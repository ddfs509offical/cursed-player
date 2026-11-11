//! Пересборка скачанных потоков в файл, который гарантированно играет WebView2.
//!
//! SoundCloud отдаёт часть треков только как HLS, и внутри сегментов лежит то
//! fMP4, то MPEG-TS со звуком AAC, то голый ADTS-AAC. fMP3-контейнер WebView
//! играет как есть, а два последних — нет: ADTS не контейнер, MPEG-TS он не
//! понимает вовсе. Поэтому здесь живёт свой минимум без ffmpeg и без сети:
//!
//! * определение формата по первым байтам (`detect`);
//! * разбор ADTS-кадров: профиль, частота, каналы, границы кадров;
//! * демуксер MPEG-TS: PAT → PMT → PID звука → PES → ADTS (`mpeg_ts_to_adts`);
//! * MP4-муксер: из кадров AAC собирается нормальный `.m4a`
//!   (`ftyp` + `moov` с таблицами `stts/stsc/stsz/stco` + `mdat`), звук при
//!   этом не перекодируется — кадры переносятся байт в байт.
//!
//! Модуль намеренно ничего не знает про сеть, диск и приложение: на вход
//! байты, на выходе байты. Поэтому всё поведение проверяется тестами на
//! синтетических потоках, которые тесты же и собирают.

/// Длина пакета MPEG-TS.
const TS_PACKET: usize = 188;
/// Синхробайт пакета MPEG-TS.
const TS_SYNC: u8 = 0x47;
/// PID таблицы PAT: с неё начинается разбор любого MPEG-TS.
const PAT_PID: u16 = 0;
/// «Нет пакета» — такой PID в таблицах пропускаем.
const NULL_PID: u16 = 0x1FFF;
/// `stream_type` звука ADTS-AAC в PMT.
const STREAM_TYPE_ADTS: u8 = 0x0F;
/// Сэмплов в одном AAC-кадре (один raw_data_block).
const AAC_FRAME_SAMPLES: u32 = 1024;
/// Частоты дискретизации AAC по индексу из ADTS (13, 14 и 15 — не частота).
const SAMPLE_RATES: [u32; 13] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
/// Сколько первых байт потока достаточно, чтобы понять формат.
pub const PROBE_BYTES: usize = 8 * 1024;
/// Единичная матрица преобразования для `mvhd` и `tkhd`.
const MATRIX: [u8; 36] = [
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
    0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, //
    0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
];

/* ─────────────── Формат потока ─────────────── */

/// Формат скачанного потока, определённый по первым байтам.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFormat {
    /// fMP4/MP4: склеенные сегменты WebView играет как есть.
    Mp4,
    /// Голый ADTS-AAC: нужен муксер в MP4.
    Adts,
    /// MPEG-TS со звуком AAC: нужен демуксер и муксер.
    MpegTs,
    /// MPEG audio (mp3/mp2): склеенные кадры WebView играет как есть.
    Mp3,
    /// Ничего знакомого: обещать воспроизведение нельзя.
    Unknown,
}

impl StreamFormat {
    /// Человеческое имя для ошибки и подписи.
    pub fn name(self) -> &'static str {
        match self {
            StreamFormat::Mp4 => "MP4",
            StreamFormat::Adts => "ADTS-AAC",
            StreamFormat::MpegTs => "MPEG-TS",
            StreamFormat::Mp3 => "MP3",
            StreamFormat::Unknown => "неизвестный формат",
        }
    }

    /// Играет ли WebView такой поток без пересборки.
    pub fn plays_as_is(self) -> bool {
        matches!(self, StreamFormat::Mp4 | StreamFormat::Mp3)
    }

    /// Расширение файла, который получится из этого потока.
    pub fn extension(self) -> &'static str {
        match self {
            StreamFormat::Mp3 => "mp3",
            _ => "m4a",
        }
    }
}

/// Длина ID3v2-тега в начале буфера: такие теги встречаются и у MP3, и у
/// ADTS-потоков, и мешают увидеть настоящий формат.
fn id3_len_at(bytes: &[u8]) -> usize {
    if bytes.len() < 10 || &bytes[..3] != b"ID3" {
        return 0;
    }
    // Размер записан «syncsafe»: по семь значащих бит на байт
    let size = ((bytes[6] as usize & 0x7F) << 21)
        | ((bytes[7] as usize & 0x7F) << 14)
        | ((bytes[8] as usize & 0x7F) << 7)
        | (bytes[9] as usize & 0x7F);
    let total = 10 + size;
    if total <= bytes.len() {
        total
    } else {
        // Тег не влез в буфер: пропустить его нельзя, но и считать нулём
        // нельзя — пусть решает вызывающий
        0
    }
}

/// Похож ли буфер на MP4: у первого бокса тип `ftyp`/`styp`/`moof` и
/// правдоподобная длина.
fn looks_like_mp4(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    let marker = &bytes[4..8];
    if !matches!(
        marker,
        b"ftyp" | b"styp" | b"moof" | b"moov" | b"mdat" | b"sidx" | b"free"
    ) {
        return false;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    // 0 и 1 — «длина до конца файла» и 64-битная длина: тоже допустимы
    size == 0 || size == 1 || size >= 8
}

/// Сколько подряд идущих ADTS-кадров начинается с этого места.
fn adts_frame_count(bytes: &[u8]) -> usize {
    let mut cursor = 0;
    let mut count = 0;
    while count < 4 {
        let Some(header) = parse_adts_header(&bytes[cursor..]) else {
            break;
        };
        if header.frame_len > bytes.len() - cursor {
            break;
        }
        count += 1;
        cursor += header.frame_len;
    }
    count
}

/// Похож ли буфер на поток ADTS-AAC. Одного кадра мало (случайное совпадение
/// синхрослова), поэтому требуем либо цепочку кадров, либо совсем короткий
/// буфер — он просто не может вместить второй кадр.
fn looks_like_adts(bytes: &[u8]) -> bool {
    let count = adts_frame_count(bytes);
    count >= 2 || (count == 1 && bytes.len() < 2048)
}

/// Первый байт последовательности пакетов MPEG-TS: ищем 0x47 с шагом 188.
/// Три совпадения подряд случайными быть уже не могут.
fn find_ts_start(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < TS_PACKET {
        return None;
    }
    let need = if bytes.len() >= 3 * TS_PACKET { 3 } else { 2 };
    for offset in 0..bytes.len().min(TS_PACKET * 4) {
        if bytes[offset] != TS_SYNC {
            continue;
        }
        let mut found = 0;
        let mut at = offset;
        while at + TS_PACKET <= bytes.len() && found < need {
            if bytes[at] != TS_SYNC {
                break;
            }
            found += 1;
            at += TS_PACKET;
        }
        if found >= need {
            return Some(offset);
        }
    }
    None
}

/// Заголовок кадра MPEG audio: синхрослово 11 бит и осмысленные поля.
/// От ADTS отличается битами слоя: там они нулевые, здесь — нет.
fn looks_like_mpeg_audio(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    if bytes[0] != 0xFF || bytes[1] & 0xE0 != 0xE0 {
        return false;
    }
    if (bytes[1] >> 3) & 0x03 == 0x01 {
        return false; // зарезервированная версия
    }
    if (bytes[1] >> 1) & 0x03 == 0 {
        return false; // зарезервированный слой
    }
    let bitrate = (bytes[2] >> 4) & 0x0F;
    if bitrate == 0 || bitrate == 0x0F {
        return false; // «свободный» или мусорный битрейт
    }
    if (bytes[2] >> 2) & 0x03 == 0x03 {
        return false; // зарезервированная частота
    }
    true
}

/// Формат потока по первым байтам: расширение и content-type могут врать,
/// а байты — нет.
pub fn detect(bytes: &[u8]) -> StreamFormat {
    let body = &bytes[id3_len_at(bytes)..];
    if body.is_empty() {
        return StreamFormat::Unknown;
    }
    if looks_like_mp4(body) {
        return StreamFormat::Mp4;
    }
    if looks_like_adts(body) {
        return StreamFormat::Adts;
    }
    if find_ts_start(body).is_some() {
        return StreamFormat::MpegTs;
    }
    if looks_like_mpeg_audio(body) {
        return StreamFormat::Mp3;
    }
    StreamFormat::Unknown
}

/* ─────────────── ADTS-AAC ─────────────── */

/// Параметры звука из заголовка ADTS. Из них собирается и `esds`
/// (AudioSpecificConfig), и частоты дорожки в MP4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AacInfo {
    /// Профиль AAC (2 бита): объектный тип минус один, то есть 1 — это LC.
    profile: u8,
    /// Индекс частоты дискретизации (0…12).
    sample_rate_index: u8,
    /// Конфигурация каналов (0 — «описано отдельно», 7 — восемь каналов).
    channel_config: u8,
}

impl AacInfo {
    fn sample_rate(&self) -> u32 {
        SAMPLE_RATES
            .get(self.sample_rate_index as usize)
            .copied()
            .unwrap_or(44100)
    }

    /// Объектный тип AAC для AudioSpecificConfig.
    fn object_type(&self) -> u32 {
        self.profile as u32 + 1
    }

    fn channels(&self) -> Result<u16, String> {
        match self.channel_config {
            0 => Err("в потоке не указана конфигурация каналов (нужен PCE)".to_string()),
            7 => Ok(8),
            value => Ok(value as u16),
        }
    }
}

/// Разобранный заголовок одного ADTS-кадра.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AdtsHeader {
    /// Полная длина кадра вместе с заголовком.
    frame_len: usize,
    /// Где начинается звук: заголовок плюс позиции блоков (у многоблочных).
    payload_start: usize,
    /// Концы звуковых блоков внутри кадра, считая от его начала.
    block_ends: Vec<usize>,
    /// Сколько сэмплов в кадре: по 1024 на каждый блок.
    samples: u32,
    info: AacInfo,
}

/// Разбирает заголовок ADTS. `None` — это не ADTS-кадр.
fn parse_adts_header(bytes: &[u8]) -> Option<AdtsHeader> {
    if bytes.len() < 7 {
        return None;
    }
    // Синхрослово — 12 бит
    if bytes[0] != 0xFF || bytes[1] & 0xF0 != 0xF0 {
        return None;
    }
    // Слой всегда 00: именно так кадры MP3 (слой 01/10/11) отсеиваются
    if (bytes[1] >> 1) & 0x03 != 0 {
        return None;
    }
    let protection_absent = bytes[1] & 0x01 == 1;
    let profile = (bytes[2] >> 6) & 0x03;
    let sample_rate_index = (bytes[2] >> 2) & 0x0F;
    // 13 и 14 зарезервированы, 15 — «частота передана отдельно»: в ADTS это мусор
    if sample_rate_index > 12 {
        return None;
    }
    let channel_config = ((bytes[2] & 0x01) << 2) | ((bytes[3] >> 6) & 0x03);
    let frame_len = (((bytes[3] & 0x03) as usize) << 11)
        | ((bytes[4] as usize) << 3)
        | ((bytes[5] >> 5) as usize);
    let raw_blocks = bytes[6] & 0x03;
    let header_len = if protection_absent { 7 } else { 9 };
    if frame_len < header_len {
        return None;
    }

    let info = AacInfo {
        profile,
        sample_rate_index,
        channel_config,
    };

    if raw_blocks == 0 {
        return Some(AdtsHeader {
            frame_len,
            payload_start: header_len,
            block_ends: vec![frame_len],
            samples: AAC_FRAME_SAMPLES,
            info,
        });
    }

    // Многоблочный кадр: перед звуком идут позиции блоков (по 16 бит), и, по
    // спеке, контрольная сумма. Реальные кодировщики так не делают, поэтому
    // проверяем оба варианта длины заголовка, а при сомнении берём кадр целиком
    // одним сэмплом: длительность 1024 на блок всё равно верна.
    let blocks = raw_blocks as usize;
    let mut samples = AAC_FRAME_SAMPLES * (raw_blocks as u32 + 1);
    if samples == 0 {
        samples = AAC_FRAME_SAMPLES;
    }
    let mut positions = Vec::with_capacity(blocks);
    let positions_ok = bytes.len() >= 7 + blocks * 2
        && (0..blocks).all(|index| {
            let at = 7 + index * 2;
            let position = ((bytes[at] as usize) << 8) | bytes[at + 1] as usize;
            if position == 0 || position > frame_len {
                return false;
            }
            positions.push(position);
            true
        });

    if positions_ok {
        for start in [7 + blocks * 2, 7 + blocks * 2 + 2] {
            let increasing = positions.windows(2).all(|pair| pair[0] < pair[1]);
            if !increasing || positions[0] <= start || *positions.last().unwrap() >= frame_len {
                continue;
            }
            let mut ends: Vec<usize> = positions.clone();
            ends.push(frame_len);
            return Some(AdtsHeader {
                frame_len,
                payload_start: start,
                block_ends: ends,
                samples,
                info,
            });
        }
    }

    Some(AdtsHeader {
        frame_len,
        payload_start: header_len,
        block_ends: vec![frame_len],
        samples,
        info,
    })
}

/// Один звуковой блок в исходном буфере: полезные данные без заголовка ADTS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AacSample {
    /// Начало полезных данных в исходном буфере.
    offset: usize,
    /// Длина полезных данных.
    len: usize,
    /// Сколько сэмплов в блоке.
    samples: u32,
}

/// Разобранный поток ADTS: кадры и параметры звука.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AacStream {
    samples: Vec<AacSample>,
    info: AacInfo,
}

impl AacStream {
    fn total_samples(&self) -> u64 {
        self.samples.iter().map(|sample| sample.samples as u64).sum()
    }

    fn payload_bytes(&self) -> u64 {
        self.samples.iter().map(|sample| sample.len as u64).sum()
    }
}

/// Ищет следующее синхрослово ADTS: так из потока выпадает мусор между
/// кадрами и (редкие) теги ID3, не ломая разбор остального.
fn find_adts_sync(bytes: &[u8], from: usize) -> Option<usize> {
    let mut at = from;
    while at + 7 <= bytes.len() {
        if bytes[at] == 0xFF && bytes[at + 1] & 0xF6 == 0xF0 {
            if let Some(header) = parse_adts_header(&bytes[at..]) {
                if header.frame_len <= bytes.len() - at {
                    return Some(at);
                }
            }
        }
        at += 1;
    }
    None
}

/// Разбирает поток ADTS в кадры. Параметры звука берутся из первого кадра:
/// дальше они меняться не должны, такие кадры пропускаются.
fn parse_adts(bytes: &[u8]) -> Result<AacStream, String> {
    let start = id3_len_at(bytes);
    let body = &bytes[start..];
    if body.is_empty() {
        return Err("поток пуст".to_string());
    }

    let mut samples: Vec<AacSample> = Vec::new();
    let mut info: Option<AacInfo> = None;
    let mut cursor = start;
    // Сколько байт потока занято разобранными кадрами: по этой доле видно,
    // ADTS это или случайные байты с одним совпавшим синхрословом.
    let mut spanned: u64 = 0;

    while cursor + 7 <= bytes.len() {
        // Тег ID3 может стоять и в середине потока: пропускаем целиком
        let tag = id3_len_at(&bytes[cursor..]);
        if tag > 0 {
            cursor += tag;
            continue;
        }

        let Some(header) = parse_adts_header(&bytes[cursor..]) else {
            match find_adts_sync(bytes, cursor + 1) {
                Some(next) => cursor = next,
                None => break,
            }
            continue;
        };
        if header.frame_len > bytes.len() - cursor {
            // Обрывок последнего кадра: дальше кадров уже не будет
            break;
        }

        match info {
            Some(known) if known != header.info => {
                // Параметры поменялись посреди потока: такой кадр не наш
                cursor += header.frame_len;
                continue;
            }
            _ => info = Some(header.info),
        }

        let per_block = header.samples / header.block_ends.len().max(1) as u32;
        for (index, end) in header.block_ends.iter().enumerate() {
            let from = if index == 0 {
                header.payload_start
            } else {
                header.block_ends[index - 1]
            };
            if end <= &from {
                continue;
            }
            samples.push(AacSample {
                offset: cursor + from,
                len: end - from,
                samples: per_block,
            });
        }
        spanned += header.frame_len as u64;
        cursor += header.frame_len;
    }

    if samples.is_empty() {
        return Err("в потоке не нашлось ни одного кадра ADTS-AAC".to_string());
    }

    // Кадры должны занимать почти весь поток: иначе это не ADTS, а случайные
    // байты, в которых один раз совпало синхрослово. Теги ID3 и редкий мусор
    // между кадрами дают потери в доли процента, поэтому порог — 80%.
    if spanned * 5 < body.len() as u64 * 4 {
        return Err(format!(
            "кадры ADTS покрывают лишь {}% потока — это не поток AAC",
            spanned * 100 / body.len().max(1) as u64
        ));
    }

    Ok(AacStream {
        samples,
        info: info.expect("кадры есть — значит, параметры известны"),
    })
}

/* ─────────────── MP4-муксер ─────────────── */

/// Бокс MP4: длина, тип, тело.
fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&((8 + body.len()) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

/// Бокс с версией и флагами: они идут до тела.
fn full_box(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::with_capacity(4 + body.len());
    inner.push(version);
    inner.extend_from_slice(&flags.to_be_bytes()[1..]);
    inner.extend_from_slice(body);
    mp4_box(kind, &inner)
}

/// Дескриптор MPEG-4: тег, размер переменной длины, тело.
fn descriptor(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + payload.len());
    out.push(tag);
    write_descriptor_size(&mut out, payload.len());
    out.extend_from_slice(payload);
    out
}

/// Размер дескриптора: по семь значащих бит на байт, старший бит — продолжение.
fn write_descriptor_size(out: &mut Vec<u8>, size: usize) {
    let bytes = [
        ((size >> 21) & 0x7F) as u8,
        ((size >> 14) & 0x7F) as u8,
        ((size >> 7) & 0x7F) as u8,
        (size & 0x7F) as u8,
    ];
    let mut start = 0;
    while start < 3 && bytes[start] == 0 {
        start += 1;
    }
    for (index, byte) in bytes.iter().enumerate().skip(start) {
        let last = index == 3;
        out.push(if last { *byte } else { *byte | 0x80 });
    }
}

/// Пишет биты старшими вперёд: AudioSpecificConfig — поток бит, а не байт.
struct BitWriter {
    bytes: Vec<u8>,
    current: u8,
    used: u8,
}

impl BitWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            current: 0,
            used: 0,
        }
    }

    fn write(&mut self, value: u32, bits: u8) {
        for index in (0..bits).rev() {
            let bit = (value >> index) & 1 == 1;
            self.current = (self.current << 1) | u8::from(bit);
            self.used += 1;
            if self.used == 8 {
                self.bytes.push(self.current);
                self.current = 0;
                self.used = 0;
            }
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.used > 0 {
            self.current <<= 8 - self.used;
            self.bytes.push(self.current);
        }
        self.bytes
    }
}

/// AudioSpecificConfig из параметров ADTS: объектный тип, частота, каналы и
/// `GASpecificConfig` из трёх нулей (кадры по 1024 сэмпла, без зависимостей).
fn audio_specific_config(info: &AacInfo) -> Result<Vec<u8>, String> {
    let channels = info.channels()?;
    let mut writer = BitWriter::new();
    writer.write(info.object_type(), 5);
    writer.write(info.sample_rate_index as u32, 4);
    writer.write(channels as u32, 4);
    writer.write(0, 3);
    let config = writer.finish();
    if config.is_empty() {
        return Err("не собрался AudioSpecificConfig".to_string());
    }
    Ok(config)
}

/// `esds`: описание декодера AAC, внутри — AudioSpecificConfig.
fn build_esds(asc: &[u8], max_frame: u32, avg_bitrate: u32) -> Vec<u8> {
    let mut decoder = Vec::new();
    decoder.push(0x40); // объектный тип: MPEG-4 Audio
    decoder.push(0x15); // streamType 5 (звук), reserved = 1
    decoder.extend_from_slice(&max_frame.min(0xFF_FFFF).to_be_bytes()[1..]); // bufferSizeDB
    decoder.extend_from_slice(&0u32.to_be_bytes()); // maxBitrate: неизвестен
    decoder.extend_from_slice(&avg_bitrate.to_be_bytes());
    decoder.extend_from_slice(&descriptor(0x05, asc));

    let mut payload = Vec::new();
    payload.extend_from_slice(&1u16.to_be_bytes()); // ES_ID
    payload.push(0); // без зависимостей, URL и OCR
    payload.extend_from_slice(&descriptor(0x04, &decoder));
    payload.extend_from_slice(&descriptor(0x06, &[0x02])); // SLConfig: predefined

    full_box(b"esds", 0, 0, &descriptor(0x03, &payload))
}

/// Запись сэмпла `mp4a`: каналы, разрядность, частота и `esds`.
fn build_mp4a(info: &AacInfo, max_frame: u32, avg_bitrate: u32) -> Result<Vec<u8>, String> {
    let channels = info.channels()?;
    let asc = audio_specific_config(info)?;
    let esds = build_esds(&asc, max_frame, avg_bitrate);

    let mut body = Vec::new();
    body.extend_from_slice(&[0u8; 6]); // reserved
    body.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    body.extend_from_slice(&[0u8; 8]); // version, revision, vendor
    body.extend_from_slice(&channels.to_be_bytes());
    body.extend_from_slice(&16u16.to_be_bytes()); // разрядность
    body.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    body.extend_from_slice(&0u16.to_be_bytes()); // reserved
    body.extend_from_slice(&(info.sample_rate() << 16).to_be_bytes()); // частота 16.16
    body.extend_from_slice(&esds);
    Ok(mp4_box(b"mp4a", &body))
}

/// `stsd` с единственной записью — нашим `mp4a`.
fn build_stsd(info: &AacInfo, max_frame: u32, avg_bitrate: u32) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    body.extend_from_slice(&1u32.to_be_bytes());
    body.extend_from_slice(&build_mp4a(info, max_frame, avg_bitrate)?);
    Ok(full_box(b"stsd", 0, 0, &body))
}

/// `stts`: длительности сэмплов, сжатые в записи «сколько раз по сколько».
fn build_stts(samples: &[AacSample]) -> Vec<u8> {
    let mut entries: Vec<(u32, u32)> = Vec::new();
    for sample in samples {
        match entries.last_mut() {
            Some((count, delta)) if *delta == sample.samples => *count += 1,
            _ => entries.push((1, sample.samples)),
        }
    }

    let mut body = Vec::new();
    body.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (count, delta) in entries {
        body.extend_from_slice(&count.to_be_bytes());
        body.extend_from_slice(&delta.to_be_bytes());
    }
    full_box(b"stts", 0, 0, &body)
}

/// `stsc`: по одному сэмплу в чанке — самая простая и самая совместимая схема.
fn build_stsc() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&1u32.to_be_bytes()); // одна запись
    body.extend_from_slice(&1u32.to_be_bytes()); // первый чанк
    body.extend_from_slice(&1u32.to_be_bytes()); // сэмплов в чанке
    body.extend_from_slice(&1u32.to_be_bytes()); // описание сэмпла
    full_box(b"stsc", 0, 0, &body)
}

/// `stsz`: размеры сэмплов. Размеры у AAC разные, поэтому таблица обязательна.
fn build_stsz(samples: &[AacSample]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // «размеры в таблице»
    body.extend_from_slice(&(samples.len() as u32).to_be_bytes());
    for sample in samples {
        body.extend_from_slice(&(sample.len as u32).to_be_bytes());
    }
    full_box(b"stsz", 0, 0, &body)
}

/// `stco` или `co64`: смещения чанков в файле. 64-битная таблица нужна только
/// для потоков больше четырёх гигабайт, но поддержана честно.
fn chunk_offsets_box(offsets: &[u64], force_co64: bool) -> Vec<u8> {
    let co64 = force_co64 || offsets.iter().any(|offset| *offset > u32::MAX as u64);
    let mut body = Vec::new();
    body.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
    for offset in offsets {
        if co64 {
            body.extend_from_slice(&offset.to_be_bytes());
        } else {
            body.extend_from_slice(&(*offset as u32).to_be_bytes());
        }
    }
    full_box(if co64 { b"co64" } else { b"stco" }, 0, 0, &body)
}

/// `mvhd`: параметры всего файла. Длительность — в сэмплах дорожки.
fn build_mvhd(timescale: u32, duration: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    body.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    body.extend_from_slice(&timescale.to_be_bytes());
    body.extend_from_slice(&duration.to_be_bytes());
    body.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    body.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    body.extend_from_slice(&0u16.to_be_bytes()); // reserved
    body.extend_from_slice(&[0u8; 8]); // reserved
    body.extend_from_slice(&MATRIX);
    body.extend_from_slice(&[0u8; 24]); // pre_defined
    body.extend_from_slice(&2u32.to_be_bytes()); // next_track_ID
    full_box(b"mvhd", 0, 0, &body)
}

/// `tkhd`: заголовок дорожки, включённой и видимой.
fn build_tkhd(duration: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    body.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    body.extend_from_slice(&1u32.to_be_bytes()); // track_ID
    body.extend_from_slice(&[0u8; 4]); // reserved
    body.extend_from_slice(&duration.to_be_bytes());
    body.extend_from_slice(&[0u8; 8]); // reserved
    body.extend_from_slice(&0u16.to_be_bytes()); // layer
    body.extend_from_slice(&0u16.to_be_bytes()); // alternate_group
    body.extend_from_slice(&0x0100u16.to_be_bytes()); // volume
    body.extend_from_slice(&0u16.to_be_bytes()); // reserved
    body.extend_from_slice(&MATRIX);
    body.extend_from_slice(&0u32.to_be_bytes()); // width
    body.extend_from_slice(&0u32.to_be_bytes()); // height
    full_box(b"tkhd", 0, 7, &body)
}

/// `mdhd`: медиа-заголовок. Язык `und` — «не определён».
fn build_mdhd(timescale: u32, duration: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // creation_time
    body.extend_from_slice(&0u32.to_be_bytes()); // modification_time
    body.extend_from_slice(&timescale.to_be_bytes());
    body.extend_from_slice(&duration.to_be_bytes());
    body.extend_from_slice(&0x55C4u16.to_be_bytes()); // language
    body.extend_from_slice(&0u16.to_be_bytes()); // pre_defined
    full_box(b"mdhd", 0, 0, &body)
}

/// `hdlr`: дорожка звуковая.
fn hdlr_box() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    body.extend_from_slice(b"soun"); // handler_type
    body.extend_from_slice(&[0u8; 12]); // reserved
    body.extend_from_slice(b"SoundHandler\0");
    full_box(b"hdlr", 0, 0, &body)
}

/// `dinf` с одной записью `url`: данные лежат в этом же файле.
fn dinf_box() -> Vec<u8> {
    let url = full_box(b"url ", 0, 1, &[]);
    let mut dref = Vec::new();
    dref.extend_from_slice(&1u32.to_be_bytes());
    dref.extend_from_slice(&url);
    mp4_box(b"dinf", &full_box(b"dref", 0, 0, &dref))
}

/// Собирает `moov`. `base` — смещение первого байта тела `mdat`: от него
/// считаются смещения чанков. Длина `moov` от значения `base` не зависит,
/// поэтому пересобрать его с точным `base` можно без второй итерации.
fn build_moov(stream: &AacStream, base: u64, force_co64: bool) -> Result<Vec<u8>, String> {
    let info = &stream.info;
    let duration = stream.total_samples();
    if duration > u32::MAX as u64 {
        return Err(format!(
            "поток слишком длинный для MP4: {duration} сэмплов"
        ));
    }
    let duration = duration as u32;
    let timescale = info.sample_rate();
    let payload = stream.payload_bytes();
    let max_frame = stream
        .samples
        .iter()
        .map(|sample| sample.len as u32)
        .max()
        .unwrap_or(0);
    let avg_bitrate = (payload
        .saturating_mul(8)
        .saturating_mul(timescale as u64)
        / duration.max(1) as u64)
        .min(u32::MAX as u64) as u32;

    let mut offsets = Vec::with_capacity(stream.samples.len());
    let mut position = base;
    for sample in &stream.samples {
        offsets.push(position);
        position += sample.len as u64;
    }

    let mut stbl_body = Vec::new();
    stbl_body.extend_from_slice(&build_stsd(info, max_frame, avg_bitrate)?);
    stbl_body.extend_from_slice(&build_stts(&stream.samples));
    stbl_body.extend_from_slice(&build_stsc());
    stbl_body.extend_from_slice(&build_stsz(&stream.samples));
    stbl_body.extend_from_slice(&chunk_offsets_box(&offsets, force_co64));
    let stbl = mp4_box(b"stbl", &stbl_body);

    let mut minf_body = Vec::new();
    minf_body.extend_from_slice(&full_box(b"smhd", 0, 0, &[0u8; 4]));
    minf_body.extend_from_slice(&dinf_box());
    minf_body.extend_from_slice(&stbl);
    let minf = mp4_box(b"minf", &minf_body);

    let mut mdia_body = Vec::new();
    mdia_body.extend_from_slice(&build_mdhd(timescale, duration));
    mdia_body.extend_from_slice(&hdlr_box());
    mdia_body.extend_from_slice(&minf);
    let mdia = mp4_box(b"mdia", &mdia_body);

    let mut trak_body = Vec::new();
    trak_body.extend_from_slice(&build_tkhd(duration));
    trak_body.extend_from_slice(&mdia);
    let trak = mp4_box(b"trak", &trak_body);

    let mut moov_body = Vec::new();
    moov_body.extend_from_slice(&build_mvhd(timescale, duration));
    moov_body.extend_from_slice(&trak);
    Ok(mp4_box(b"moov", &moov_body))
}

/// `ftyp` для M4A: так файл опознают и WebView, и теги.
fn build_ftyp() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(b"M4A "); // major_brand
    body.extend_from_slice(&512u32.to_be_bytes()); // minor_version
    for brand in [b"M4A ".as_slice(), b"isom", b"mp42", b"mp41"] {
        body.extend_from_slice(brand);
    }
    mp4_box(b"ftyp", &body)
}

/// Собирает MP4 из разобранных ADTS-кадров: звук переносится без перекодирования.
fn build_m4a(source: &[u8], stream: &AacStream) -> Result<Vec<u8>, String> {
    let ftyp = build_ftyp();
    let payload = stream.payload_bytes();
    let mdat_size = 8u64
        .checked_add(payload)
        .ok_or_else(|| "поток слишком большой для MP4".to_string())?;
    if mdat_size > u32::MAX as u64 {
        return Err("поток больше четырёх гигабайт — в один MP4 он не влезает".to_string());
    }

    // Длина moov не зависит от значений смещений, поэтому сначала узнаём её
    // «на нулевой базе», а потом пересобираем с настоящей.
    let probe = build_moov(stream, 0, false)?;
    let base = ftyp.len() as u64 + probe.len() as u64 + 8;
    let moov = if base + payload > u32::MAX as u64 {
        let probe = build_moov(stream, 0, true)?;
        let base = ftyp.len() as u64 + probe.len() as u64 + 8;
        build_moov(stream, base, true)?
    } else {
        build_moov(stream, base, false)?
    };

    let mut out = Vec::with_capacity(ftyp.len() + moov.len() + mdat_size as usize);
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&moov);
    out.extend_from_slice(&(mdat_size as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for sample in &stream.samples {
        let end = sample.offset + sample.len;
        let chunk = source
            .get(sample.offset..end)
            .ok_or_else(|| "кадр AAC вышел за пределы потока".to_string())?;
        out.extend_from_slice(chunk);
    }
    Ok(out)
}

/// Голый ADTS-AAC → `.m4a`, который играет WebView2. Без ffmpeg и без сети.
pub fn adts_to_m4a(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let stream = parse_adts(bytes)?;
    build_m4a(bytes, &stream)
}

/* ─────────────── Демуксер MPEG-TS ─────────────── */

/// Пакет MPEG-TS, разобранный до полезной нагрузки.
#[derive(Debug, Clone, Copy)]
struct TsPacket<'a> {
    pid: u16,
    /// `payload_unit_start_indicator`: с этого пакета начинается PES или секция.
    start: bool,
    payload: &'a [u8],
}

/// Разбирает заголовок пакета MPEG-TS. `None` — пакет нечитаемый.
fn parse_ts_packet(packet: &[u8]) -> Option<TsPacket<'_>> {
    if packet.len() < TS_PACKET || packet[0] != TS_SYNC {
        return None;
    }
    if packet[1] & 0x80 != 0 {
        return None; // transport_error_indicator: пакет битый
    }
    if (packet[3] >> 6) & 0x03 != 0 {
        return None; // scrambling: зашифрованное не разбираем
    }
    let start = packet[1] & 0x40 != 0;
    let pid = (((packet[1] & 0x1F) as u16) << 8) | packet[2] as u16;

    let mut offset = 4;
    match (packet[3] >> 4) & 0x03 {
        0 => return None, // зарезервировано
        2 => return None, // только адаптационное поле: полезных данных нет
        3 => {
            let length = packet[4] as usize;
            if 5 + length > TS_PACKET {
                return None;
            }
            offset = 5 + length;
        }
        _ => {}
    }

    Some(TsPacket {
        pid,
        start,
        payload: &packet[offset..TS_PACKET],
    })
}

/// CRC-32/MPEG-2: им подписаны секции PSI (PAT и PMT). Проверка нужна, чтобы
/// отличить настоящую секцию от набивки, которую неаккуратный кодировщик
/// положил в полезную нагрузку: без неё PID звука берётся из мусора.
fn crc32_mpeg2(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc ^= (*byte as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04C1_1DB7
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// Собрана ли секция PSI целиком: у секций с контрольной суммой она должна
/// сходиться. У остальных (без флага синтаксиса) проверять нечего.
fn section_is_complete(section: &[u8]) -> bool {
    if section.len() < 8 || section[1] & 0x80 == 0 {
        return true;
    }
    let end = section.len() - 4;
    let declared = u32::from_be_bytes([
        section[end],
        section[end + 1],
        section[end + 2],
        section[end + 3],
    ]);
    crc32_mpeg2(&section[..end]) == declared
}

/// Сборщик PSI-секций: PAT и PMT могут прийти несколькими пакетами.
#[derive(Debug, Default)]
struct SectionBuffer {
    data: Vec<u8>,
}

impl SectionBuffer {
    fn clear(&mut self) {
        self.data.clear();
    }

    /// Добавляет полезную нагрузку пакета и отдаёт все собранные секции.
    fn push(&mut self, start: bool, payload: &[u8]) -> Vec<Vec<u8>> {
        if start {
            self.clear();
            // Первый байт — pointer_field: сколько байт идёт до начала секции
            let pointer = payload.first().copied().unwrap_or(0) as usize;
            if pointer + 1 > payload.len() {
                return Vec::new();
            }
            self.data.extend_from_slice(&payload[1 + pointer..]);
        } else {
            self.data.extend_from_slice(payload);
        }

        let mut sections = Vec::new();
        loop {
            if self.data.len() < 3 || self.data[0] == 0xFF {
                break; // набивка до конца пакета
            }
            let length = (((self.data[1] & 0x0F) as usize) << 8) | self.data[2] as usize;
            if length == 0 {
                self.clear();
                break;
            }
            let total = 3 + length;
            if self.data.len() < total {
                break; // секция ещё не влезла
            }
            // Секция должна быть целой: если сумма не сходится, часть «секции» —
            // набивка, и нужно дождаться следующего пакета
            if !section_is_complete(&self.data[..total]) {
                break;
            }
            sections.push(self.data[..total].to_vec());
            self.data.drain(..total);
        }
        sections
    }
}

/// PID'ы таблиц программ из секции PAT.
fn parse_pat(section: &[u8]) -> Vec<u16> {
    if section.len() < 12 || section[0] != 0x00 {
        return Vec::new();
    }
    let end = section.len() - 4; // без CRC32
    let mut pids = Vec::new();
    let mut at = 8; // после table_id, длины, tsid, версии и номеров секций
    while at + 4 <= end {
        let program = ((section[at] as u16) << 8) | section[at + 1] as u16;
        let pid = (((section[at + 2] & 0x1F) as u16) << 8) | section[at + 3] as u16;
        if program != 0 && pid != NULL_PID && !pids.contains(&pid) {
            pids.push(pid);
        }
        at += 4;
    }
    pids
}

/// PID звука ADTS из секции PMT.
fn parse_pmt(section: &[u8]) -> Option<u16> {
    if section.len() < 16 || section[0] != 0x02 {
        return None;
    }
    let end = section.len() - 4; // без CRC32
    let program_info = (((section[10] & 0x0F) as usize) << 8) | section[11] as usize;
    let mut at = 12 + program_info;
    while at + 5 <= end {
        let stream_type = section[at];
        let pid = (((section[at + 1] & 0x1F) as u16) << 8) | section[at + 2] as u16;
        let es_info = (((section[at + 3] & 0x0F) as usize) << 8) | section[at + 4] as usize;
        if stream_type == STREAM_TYPE_ADTS {
            return Some(pid);
        }
        at += 5 + es_info;
    }
    None
}

/// Полезные данные PES: служебный заголовок и хвостовая набивка отбрасываются.
fn pes_payload(pes: &[u8]) -> &[u8] {
    if pes.len() < 6 || pes[0] != 0 || pes[1] != 0 || pes[2] != 1 {
        return pes;
    }
    match pes[3] {
        // У этих потоков дополнительного заголовка нет
        0xBC | 0xBE | 0xBF | 0xF0 | 0xF1 | 0xF2 | 0xF8 | 0xFF => &pes[6..],
        _ => {
            if pes.len() < 9 || pes[6] & 0xC0 != 0x80 {
                return pes;
            }
            let header = 9 + pes[8] as usize;
            if header > pes.len() {
                return &pes[pes.len()..];
            }
            // PES_packet_length считает байты после самого поля длины: он точно
            // говорит, где кончается поток, а где начинается набивка
            let declared = u16::from_be_bytes([pes[4], pes[5]]) as usize;
            let end = if declared == 0 {
                pes.len()
            } else {
                (6 + declared).min(pes.len())
            };
            if end <= header {
                return &pes[pes.len()..];
            }
            &pes[header..end]
        }
    }
}

/// Длина серии 0xFF в конце полезной нагрузки пакета, которую считаем набивкой:
/// некоторые кодировщики добивают пакет ею вместо адаптационного поля, и без
/// этой чистки звук разбирается, но «мусорных» байт становится больше, чем
/// кадров.
const TS_STUFFING_RUN: usize = 16;

/// Срезает хвостовую набивку 0xFF у полезной нагрузки пакета TS.
fn trim_stuffing(payload: &[u8]) -> &[u8] {
    let mut end = payload.len();
    while end > 0 && payload[end - 1] == 0xFF {
        end -= 1;
    }
    if payload.len() - end >= TS_STUFFING_RUN {
        &payload[..end]
    } else {
        // Короткая серия 0xFF — это данные, а не набивка
        payload
    }
}

/// Собирает элементарный поток одного PID: склеивает PES и снимает заголовки.
fn extract_elementary(packets: &[&[u8]], pid: u16) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut pes: Vec<u8> = Vec::new();

    for packet in packets {
        let Some(parsed) = parse_ts_packet(packet) else {
            continue;
        };
        if parsed.pid != pid {
            continue;
        }
        if parsed.start {
            out.extend_from_slice(pes_payload(&pes));
            pes.clear();
        }
        pes.extend_from_slice(trim_stuffing(parsed.payload));
    }
    out.extend_from_slice(pes_payload(&pes));
    out
}

/// PID'ы с аудио-PES: подстраховка, когда PMT не назвал AAC.
fn discover_audio_pids(packets: &[&[u8]]) -> Vec<u16> {
    let mut pids = Vec::new();
    for packet in packets {
        let Some(parsed) = parse_ts_packet(packet) else {
            continue;
        };
        if !parsed.start || parsed.payload.len() < 4 {
            continue;
        }
        if parsed.payload[0..3] != [0, 0, 1] {
            continue;
        }
        let stream_id = parsed.payload[3];
        // 0xC0…0xDF — звуковые элементарные потоки MPEG
        if (0xC0..=0xDF).contains(&stream_id) && !pids.contains(&parsed.pid) {
            pids.push(parsed.pid);
        }
    }
    pids
}

/// Достаёт из MPEG-TS вложенный поток ADTS-AAC: PAT → PMT → PID звука → PES.
pub fn mpeg_ts_to_adts(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let start = find_ts_start(bytes).ok_or_else(|| {
        "в потоке не нашлось пакетов MPEG-TS (188 байт, каждый начинается с 0x47)".to_string()
    })?;
    let packets: Vec<&[u8]> = bytes[start..].chunks_exact(TS_PACKET).collect();

    // Первый проход: PAT даёт PID таблиц программ, PMT — PID звука AAC
    let mut pat = SectionBuffer::default();
    let mut pmts: Vec<(u16, SectionBuffer)> = Vec::new();
    let mut pmt_pids: Vec<u16> = Vec::new();
    let mut audio: Option<u16> = None;

    for packet in &packets {
        let Some(parsed) = parse_ts_packet(packet) else {
            continue;
        };
        if parsed.pid == PAT_PID {
            for section in pat.push(parsed.start, parsed.payload) {
                for pid in parse_pat(&section) {
                    if !pmt_pids.contains(&pid) {
                        pmt_pids.push(pid);
                    }
                }
            }
            continue;
        }
        if !pmt_pids.contains(&parsed.pid) {
            continue;
        }
        let position = match pmts.iter().position(|(pid, _)| *pid == parsed.pid) {
            Some(position) => position,
            None => {
                pmts.push((parsed.pid, SectionBuffer::default()));
                pmts.len() - 1
            }
        };
        for section in pmts[position].1.push(parsed.start, parsed.payload) {
            if audio.is_none() {
                audio = parse_pmt(&section);
            }
        }
    }

    let mut candidates: Vec<u16> = Vec::new();
    if let Some(pid) = audio {
        candidates.push(pid);
    }
    if candidates.is_empty() {
        candidates = discover_audio_pids(&packets);
    }
    if candidates.is_empty() {
        return Err(
            "в MPEG-TS не нашлось звуковой дорожки AAC (stream_type 0x0F)".to_string(),
        );
    }

    let mut reason = String::new();
    for pid in candidates {
        let elementary = extract_elementary(&packets, pid);
        if elementary.is_empty() {
            reason = format!("на PID {pid} нет полезных данных");
            continue;
        }
        match parse_adts(&elementary) {
            Ok(_) => return Ok(elementary),
            Err(error) => reason = format!("PID {pid}: {error}"),
        }
    }

    Err(format!("в MPEG-TS звук AAC не разобрался ({reason})"))
}

/// MPEG-TS → `.m4a`: демуксер плюс тот же муксер, что и для голого ADTS.
pub fn mpeg_ts_to_m4a(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let adts = mpeg_ts_to_adts(bytes)?;
    adts_to_m4a(&adts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ops::Range;

    /* ─────────── Синтетические потоки ─────────── */

    /// Кадр ADTS с заданными параметрами и полезной нагрузкой.
    fn adts_frame(sample_rate_index: u8, channel_config: u8, payload: &[u8]) -> Vec<u8> {
        adts_frame_full(sample_rate_index, channel_config, payload, false, 0)
    }

    /// Кадр ADTS: `crc` добавляет контрольную сумму, `raw_blocks` — число
    /// дополнительных звуковых блоков (0 — обычный кадр).
    fn adts_frame_full(
        sample_rate_index: u8,
        channel_config: u8,
        payload: &[u8],
        crc: bool,
        raw_blocks: u8,
    ) -> Vec<u8> {
        let header_len = if crc { 9 } else { 7 };
        let frame_len = header_len + payload.len();
        let profile = 1u8; // AAC-LC
        let fullness = 0x7FFu16; // «переменный битрейт»

        let mut frame = Vec::with_capacity(frame_len);
        frame.push(0xFF);
        frame.push(0xF0 | if crc { 0x00 } else { 0x01 });
        frame.push((profile << 6) | (sample_rate_index << 2) | ((channel_config >> 2) & 0x01));
        frame.push(((channel_config & 0x03) << 6) | (((frame_len >> 11) as u8) & 0x03));
        frame.push(((frame_len >> 3) & 0xFF) as u8);
        frame.push((((frame_len & 0x07) as u8) << 5) | ((fullness >> 6) as u8 & 0x1F));
        frame.push((((fullness & 0x3F) as u8) << 2) | (raw_blocks & 0x03));
        if crc {
            frame.push(0x12);
            frame.push(0x34);
        }
        frame.extend_from_slice(payload);
        frame
    }

    /// Поток из нескольких кадров ADTS.
    fn adts_stream(frames: &[Vec<u8>]) -> Vec<u8> {
        frames.iter().flatten().copied().collect()
    }

    /// Тег ID3v2 указанного размера: такие теги встречаются у потоков AAC.
    fn id3_tag(size: usize) -> Vec<u8> {
        let mut tag = Vec::with_capacity(10 + size);
        tag.extend_from_slice(b"ID3\x03\x00\x00");
        tag.extend_from_slice(&[
            ((size >> 21) & 0x7F) as u8,
            ((size >> 14) & 0x7F) as u8,
            ((size >> 7) & 0x7F) as u8,
            (size & 0x7F) as u8,
        ]);
        tag.extend(std::iter::repeat(0u8).take(size));
        tag
    }

    /// Пакет MPEG-TS: полезная нагрузка и набивка 0xFF до конца пакета.
    fn ts_packet(pid: u16, start: bool, payload: &[u8], counter: u8) -> Vec<u8> {
        assert!(payload.len() <= TS_PACKET - 4, "полезная нагрузка велика");
        let mut packet = vec![0xFFu8; TS_PACKET];
        let flags = if start { 0x40u8 } else { 0x00 };
        packet[0] = TS_SYNC;
        packet[1] = flags | (((pid >> 8) as u8) & 0x1F);
        packet[2] = (pid & 0xFF) as u8;
        packet[3] = 0x10 | (counter & 0x0F);
        packet[4..4 + payload.len()].copy_from_slice(payload);
        packet
    }

    /// Пакет MPEG-TS с адаптационным полем: полезная нагрузка сдвигается.
    fn ts_packet_with_adaptation(pid: u16, start: bool, payload: &[u8], counter: u8) -> Vec<u8> {
        let adaptation = 1usize;
        assert!(
            payload.len() <= TS_PACKET - 5 - adaptation,
            "полезная нагрузка велика"
        );
        let mut packet = vec![0xFFu8; TS_PACKET];
        let flags = if start { 0x40u8 } else { 0x00 };
        packet[0] = TS_SYNC;
        packet[1] = flags | (((pid >> 8) as u8) & 0x1F);
        packet[2] = (pid & 0xFF) as u8;
        packet[3] = 0x30 | (counter & 0x0F); // адаптация плюс полезная нагрузка
        packet[4] = adaptation as u8;
        packet[5] = 0x00; // флаги адаптационного поля: без PCR
        let at = 5 + adaptation;
        packet[at..at + payload.len()].copy_from_slice(payload);
        packet
    }

    /// Пакет MPEG-TS, добитый адаптационным полем: так и делают настоящие
    /// мультиплексоры, когда полезной нагрузки меньше пакета. Набивка 0xFF
    /// внутри полезной нагрузки (как в `ts_packet`) для секции, которая
    /// продолжается в следующем пакете, недопустима — её не отличить от данных.
    fn ts_packet_padded(pid: u16, start: bool, payload: &[u8], counter: u8) -> Vec<u8> {
        assert!(payload.len() <= TS_PACKET - 6, "полезная нагрузка велика");
        let mut packet = vec![0xFFu8; TS_PACKET];
        let flags = if start { 0x40u8 } else { 0x00 };
        packet[0] = TS_SYNC;
        packet[1] = flags | (((pid >> 8) as u8) & 0x1F);
        packet[2] = (pid & 0xFF) as u8;
        packet[3] = 0x30 | (counter & 0x0F); // адаптация плюс полезная нагрузка
        let adaptation = TS_PACKET - 5 - payload.len();
        packet[4] = adaptation as u8;
        packet[5] = 0x00; // флаги адаптационного поля: без PCR
        let at = 5 + adaptation;
        packet[at..at + payload.len()].copy_from_slice(payload);
        packet
    }

    /// Пакет с PSI-секцией: pointer_field плюс сама секция.
    fn psi_packet(pid: u16, section: &[u8], counter: u8) -> Vec<u8> {
        let mut payload = vec![0x00u8];
        payload.extend_from_slice(section);
        ts_packet(pid, true, &payload, counter)
    }

    /// Проставляет длину и CRC-32 в готовой секции PSI: настоящие секции
    /// всегда подписаны, и разбор это проверяет.
    fn seal_section(section: &mut [u8]) {
        let length = section.len() - 3;
        section[1] = 0xB0 | ((length >> 8) as u8 & 0x0F);
        section[2] = (length & 0xFF) as u8;
        let end = section.len() - 4;
        let crc = crc32_mpeg2(&section[..end]);
        section[end..].copy_from_slice(&crc.to_be_bytes());
    }

    /// Секция PAT с одной программой.
    fn pat_section(pmt_pid: u16) -> Vec<u8> {
        let mut section = vec![
            0x00, 0x00, 0x00, // table_id и длина (заполним ниже)
            0x00, 0x01, // transport_stream_id
            0xC1, 0x00, 0x00, // версия, номер секции, последняя секция
            0x00, 0x01, // program_number = 1
        ];
        section.push(0xE0 | ((pmt_pid >> 8) as u8 & 0x1F));
        section.push((pmt_pid & 0xFF) as u8);
        section.extend_from_slice(&[0, 0, 0, 0]); // CRC
        seal_section(&mut section);
        section
    }

    /// Секция PMT с одной дорожкой указанного типа.
    fn pmt_section(program: u16, stream_type: u8, pid: u16) -> Vec<u8> {
        let mut section = vec![0x02, 0x00, 0x00];
        section.extend_from_slice(&program.to_be_bytes());
        section.push(0xC1); // версия и «текущая»
        section.push(0x00); // номер секции
        section.push(0x00); // последняя секция
        section.push(0xE0 | ((pid >> 8) as u8 & 0x1F)); // PCR_PID
        section.push((pid & 0xFF) as u8);
        section.extend_from_slice(&[0xF0, 0x00]); // program_info_length = 0
        section.push(stream_type);
        section.push(0xE0 | ((pid >> 8) as u8 & 0x1F));
        section.push((pid & 0xFF) as u8);
        section.extend_from_slice(&[0xF0, 0x00]); // ES_info_length = 0
        section.extend_from_slice(&[0, 0, 0, 0]); // CRC
        seal_section(&mut section);
        section
    }

    /// PES-пакет с элементарным потоком: заголовок без PTS.
    fn pes_packet(stream_id: u8, payload: &[u8]) -> Vec<u8> {
        let mut pes = vec![0x00, 0x00, 0x01, stream_id, 0x00, 0x00, 0x80, 0x00, 0x00];
        pes.extend_from_slice(payload);
        pes
    }

    /* ─────────── Чтение MP4 в тестах ─────────── */

    fn read_u16(bytes: &[u8], at: usize) -> u16 {
        u16::from_be_bytes([bytes[at], bytes[at + 1]])
    }

    fn read_u32(bytes: &[u8], at: usize) -> u32 {
        u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    /// Верхний уровень файла: тип бокса и границы его тела. Заодно проверяет,
    /// что файл состоит из целых боксов.
    fn top_boxes(bytes: &[u8]) -> Vec<(String, Range<usize>)> {
        let mut boxes = Vec::new();
        let mut at = 0usize;
        while at + 8 <= bytes.len() {
            let size = read_u32(bytes, at) as usize;
            let kind = String::from_utf8_lossy(&bytes[at + 4..at + 8]).to_string();
            assert!(size >= 8, "битая длина бокса {kind}");
            assert!(at + size <= bytes.len(), "бокс {kind} вылез за файл");
            boxes.push((kind, at + 8..at + size));
            at += size;
        }
        assert_eq!(at, bytes.len(), "файл должен состоять из целых боксов");
        boxes
    }

    /// Тело бокса по имени: `stsd`/`dref` пропускают FullBox и счётчик, а
    /// `mp4a` — заголовок записи сэмпла.
    fn child_prefix(kind: &[u8]) -> usize {
        match kind {
            b"stsd" | b"dref" => 8,
            b"mp4a" => 28,
            _ => 0,
        }
    }

    fn is_container(kind: &[u8]) -> bool {
        matches!(
            kind,
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"dinf" | b"stsd" | b"mp4a"
        )
    }

    /// Ищет бокс на любом уровне вложенности: тестам нужен факт и тело.
    fn find_box(bytes: &[u8], kind: &[u8]) -> Vec<u8> {
        if let Some(body) = find_box_opt(bytes, kind) {
            return body;
        }
        panic!("не нашёлся бокс {}", String::from_utf8_lossy(kind));
    }

    fn find_box_opt(bytes: &[u8], kind: &[u8]) -> Option<Vec<u8>> {
        let mut at = 0usize;
        while at + 8 <= bytes.len() {
            let size = read_u32(bytes, at) as usize;
            if size < 8 || at + size > bytes.len() {
                return None;
            }
            let current = &bytes[at + 4..at + 8];
            let body = &bytes[at + 8..at + size];
            if current == kind {
                return Some(body.to_vec());
            }
            if is_container(current) {
                let prefix = child_prefix(current);
                if prefix <= body.len() {
                    if let Some(found) = find_box_opt(&body[prefix..], kind) {
                        return Some(found);
                    }
                }
            }
            at += size;
        }
        None
    }

    /* ─────────── ADTS ─────────── */

    #[test]
    fn adts_header_gives_profile_rate_channels_and_length() {
        let payload = [7u8; 120];
        let frame = adts_frame(4, 2, &payload);
        let header = parse_adts_header(&frame).expect("заголовок должен разобраться");
        assert_eq!(header.frame_len, 127, "длина кадра вместе с заголовком");
        assert_eq!(header.payload_start, 7, "звук начинается после заголовка");
        assert_eq!(header.block_ends, vec![127], "у обычного кадра один блок");
        assert_eq!(header.samples, 1024);
        assert_eq!(header.info.profile, 1, "профиль AAC-LC");
        assert_eq!(header.info.object_type(), 2, "объектный тип AAC-LC");
        assert_eq!(header.info.sample_rate(), 44100);
        assert_eq!(header.info.channels().unwrap(), 2);

        // Кадр с контрольной суммой: заголовок длиннее на два байта
        let with_crc = adts_frame_full(4, 2, &payload, true, 0);
        let header = parse_adts_header(&with_crc).expect("кадр с CRC тоже ADTS");
        assert_eq!(header.payload_start, 9);

        // Частота из таблицы
        assert_eq!(
            parse_adts_header(&adts_frame(8, 1, &[0u8; 20]))
                .unwrap()
                .info
                .sample_rate(),
            16000
        );
    }

    #[test]
    fn broken_adts_headers_are_rejected() {
        // Короткий буфер
        assert!(parse_adts_header(&[0xFF, 0xF1, 0x50]).is_none());
        // Не то синхрослово
        let mut frame = adts_frame(4, 2, &[0u8; 32]);
        frame[0] = 0xFE;
        assert!(parse_adts_header(&frame).is_none());
        // Слой не нулевой: это уже MP3, а не ADTS
        let mut mp3 = adts_frame(4, 2, &[0u8; 32]);
        mp3[1] |= 0x02;
        assert!(parse_adts_header(&mp3).is_none());
        // Зарезервированный индекс частоты
        let mut reserved = adts_frame(4, 2, &[0u8; 32]);
        reserved[2] = (reserved[2] & 0xC3) | (13 << 2);
        assert!(parse_adts_header(&reserved).is_none());
        // Длина кадра меньше заголовка
        let mut short = adts_frame(4, 2, &[0u8; 32]);
        short[3] &= 0xFC;
        short[4] = 0;
        short[5] = 0x1F;
        assert!(parse_adts_header(&short).is_none());
    }

    #[test]
    fn adts_stream_is_read_frame_by_frame() {
        let frames = vec![
            adts_frame(4, 2, &[1u8; 100]),
            adts_frame(4, 2, &[2u8; 150]),
            adts_frame(4, 2, &[3u8; 90]),
        ];
        let stream = parse_adts(&adts_stream(&frames)).expect("поток должен разобраться");
        assert_eq!(stream.samples.len(), 3);
        assert_eq!(stream.info.sample_rate(), 44100);
        assert_eq!(stream.info.channels().unwrap(), 2);
        assert_eq!(stream.total_samples(), 3 * 1024);
        assert_eq!(stream.payload_bytes(), 100 + 150 + 90);
        // Полезная нагрузка — именно кадры без заголовков ADTS
        for (index, (sample, expected)) in stream.samples.iter().zip([100usize, 150, 90]).enumerate()
        {
            assert_eq!(sample.len, expected, "размер {index}-го кадра");
            assert_eq!(sample.samples, 1024);
        }
    }

    #[test]
    fn adts_parser_skips_id3_and_resyncs_after_garbage() {
        let first = adts_frame(4, 2, &[5u8; 200]);
        let second = adts_frame(4, 2, &[6u8; 200]);

        let mut bytes = id3_tag(120);
        bytes.extend_from_slice(&first);
        bytes.extend_from_slice(b"\x00\x11\x22"); // мусор между кадрами
        bytes.extend_from_slice(&second);

        let stream = parse_adts(&bytes).expect("мусор и тег не должны ломать разбор");
        assert_eq!(stream.samples.len(), 2, "оба кадра должны найтись");
        assert_eq!(stream.samples[0].len, 200);
        assert_eq!(stream.samples[1].len, 200);
        // Первый кадр начинается сразу после тега и собственного заголовка
        assert_eq!(stream.samples[0].offset, 10 + 120 + 7);
    }

    #[test]
    fn adts_parser_rejects_garbage() {
        let error = parse_adts("это не поток AAC, а случайный текст".as_bytes()).unwrap_err();
        assert!(error.contains("кадр"), "получили: {error}");
        assert!(parse_adts(&[]).is_err());

        // Один случайно совпавший синхрослово в мусоре — ещё не поток
        let mut noise = vec![0x11u8; 4000];
        noise[100] = 0xFF;
        noise[101] = 0xF1;
        let error = parse_adts(&noise).unwrap_err();
        assert!(error.contains("ADTS") || error.contains("кадр"), "получили: {error}");
    }

    #[test]
    fn multi_block_adts_frame_splits_into_separate_samples() {
        let first = [1u8; 60];
        let second = [2u8; 40];
        // Заголовок из семи байт плюс позиция второго блока
        let payload_start = 9usize;
        let frame_len = payload_start + first.len() + second.len();
        let mut frame = vec![0xFF, 0xF1, (1 << 6) | (4 << 2), 0x00, 0x00, 0x1F, 0xFD];
        frame[3] = (((frame_len >> 11) as u8) & 0x03) | (2 << 6);
        frame[4] = ((frame_len >> 3) & 0xFF) as u8;
        frame[5] = (((frame_len & 0x07) as u8) << 5) | 0x1F;
        // raw_data_blocks = 1 → кадр содержит два блока
        frame[6] = 0xFC | 0x01;
        frame.extend_from_slice(&((payload_start + first.len()) as u16).to_be_bytes());
        frame.extend_from_slice(&first);
        frame.extend_from_slice(&second);

        let header = parse_adts_header(&frame).expect("многоблочный кадр тоже ADTS");
        assert_eq!(header.payload_start, payload_start);
        assert_eq!(header.block_ends, vec![payload_start + 60, frame_len]);
        assert_eq!(header.samples, 2048);

        let stream = parse_adts(&frame).expect("кадр должен разобраться");
        assert_eq!(stream.samples.len(), 2, "блоки становятся отдельными сэмплами");
        assert_eq!(stream.samples[0].len, 60);
        assert_eq!(stream.samples[1].len, 40);
        assert_eq!(stream.samples[0].offset, payload_start);
        assert_eq!(stream.samples[1].offset, payload_start + 60);
        assert_eq!(stream.total_samples(), 2048);
    }

    /* ─────────── Определение формата ─────────── */

    #[test]
    fn format_is_detected_by_first_bytes() {
        // fMP4: первый бокс ftyp
        let mut mp4 = vec![0u8, 0, 0, 0x20];
        mp4.extend_from_slice(b"ftypM4A ");
        mp4.extend_from_slice(&[0u8; 32]);
        assert_eq!(detect(&mp4), StreamFormat::Mp4);

        // Голый ADTS: цепочка кадров
        let adts = adts_stream(&[
            adts_frame(4, 2, &[1u8; 400]),
            adts_frame(4, 2, &[2u8; 400]),
        ]);
        assert_eq!(detect(&adts), StreamFormat::Adts);

        // MPEG-TS: три пакета подряд
        let ts = [
            ts_packet(0x100, true, &[0u8; 20], 0),
            ts_packet(0x100, false, &[0u8; 20], 1),
            ts_packet(0x100, false, &[0u8; 20], 2),
        ]
        .concat();
        assert_eq!(detect(&ts), StreamFormat::MpegTs);

        // MP3: свой синхрослово и слой
        let mp3 = [0xFFu8, 0xFB, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00];
        assert_eq!(detect(&mp3), StreamFormat::Mp3);

        // ID3 не должен прятать формат
        let mut tagged = id3_tag(60);
        tagged.extend_from_slice(&adts);
        assert_eq!(detect(&tagged), StreamFormat::Adts);

        // Пусто и мусор
        assert_eq!(detect(&[]), StreamFormat::Unknown);
        assert_eq!(detect(b"<!DOCTYPE html><html>"), StreamFormat::Unknown);
        assert_eq!(detect(&[0x00u8; 512]), StreamFormat::Unknown);
    }

    #[test]
    fn format_names_and_extensions_are_honest() {
        assert!(StreamFormat::Mp4.plays_as_is());
        assert!(StreamFormat::Mp3.plays_as_is());
        assert!(!StreamFormat::Adts.plays_as_is());
        assert!(!StreamFormat::MpegTs.plays_as_is());
        assert!(!StreamFormat::Unknown.plays_as_is());
        assert_eq!(StreamFormat::Mp3.extension(), "mp3");
        assert_eq!(StreamFormat::Adts.extension(), "m4a");
        assert_eq!(StreamFormat::MpegTs.name(), "MPEG-TS");
    }

    /* ─────────── MP4-муксер ─────────── */

    #[test]
    fn muxer_builds_complete_mp4_with_tables() {
        let first = vec![1u8; 100];
        let second = vec![2u8; 150];
        let third = vec![3u8; 90];
        let mut source = Vec::new();
        source.extend(adts_frame(4, 2, &first));
        source.extend(adts_frame(4, 2, &second));
        source.extend(adts_frame(4, 2, &third));

        let mp4 = adts_to_m4a(&source).expect("муксер обязан собрать файл");
        let top = top_boxes(&mp4);
        let kinds: Vec<&str> = top.iter().map(|(kind, _)| kind.as_str()).collect();
        assert_eq!(kinds, vec!["ftyp", "moov", "mdat"], "порядок боксов MP4");

        // ftyp: бренд M4A
        assert_eq!(&mp4[top[0].1.start..top[0].1.start + 4], &b"M4A "[..]);
        // mdat: кадры без служебных заголовков ADTS, по порядку
        let mdat_range = top[2].1.clone();
        let mdat = &mp4[mdat_range];
        let mut expected = Vec::new();
        expected.extend_from_slice(&first);
        expected.extend_from_slice(&second);
        expected.extend_from_slice(&third);
        assert_eq!(mdat, &expected[..], "в mdat должны лежать сами кадры AAC");
        assert_eq!(mdat.len(), 340);

        // mvhd и mdhd: частота как timescale, длительность в сэмплах
        let mvhd = find_box(&mp4, b"mvhd");
        assert_eq!(read_u32(&mvhd, 12), 44100, "timescale mvhd");
        assert_eq!(read_u32(&mvhd, 16), 3 * 1024, "длительность mvhd");
        let mdhd = find_box(&mp4, b"mdhd");
        assert_eq!(read_u32(&mdhd, 12), 44100);
        assert_eq!(read_u32(&mdhd, 16), 3 * 1024);
        assert_eq!(read_u16(&mdhd, 20), 0x55C4, "язык und");

        // hdlr: дорожка звуковая
        assert_eq!(&find_box(&mp4, b"hdlr")[8..12], &b"soun"[..]);
        // tkhd: дорожка включена
        assert_eq!(&find_box(&mp4, b"tkhd")[..4], &[0x00u8, 0x00, 0x00, 0x07][..]);

        // stsd → mp4a: каналы, разрядность, частота и esds
        let mp4a = find_box(&mp4, b"mp4a");
        assert_eq!(read_u16(&mp4a, 16), 2, "число каналов");
        assert_eq!(read_u16(&mp4a, 18), 16, "разрядность");
        assert_eq!(read_u32(&mp4a, 24) >> 16, 44100, "частота в записи сэмпла");
        // esds заканчивается DecoderSpecificInfo и SLConfig: ASC для AAC-LC
        // 44,1 кГц стерео — это ровно 0x12 0x10
        let esds = find_box(&mp4, b"esds");
        assert!(
            esds.ends_with(&[0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02]),
            "AudioSpecificConfig в esds: {esds:02x?}"
        );
        assert!(esds.contains(&0x40), "objectTypeIndication = MPEG-4 Audio");

        // stts: три кадра по 1024 сэмпла сжаты в одну запись
        let stts = find_box(&mp4, b"stts");
        assert_eq!(read_u32(&stts, 4), 1, "одна запись на одинаковые кадры");
        assert_eq!(read_u32(&stts, 8), 3, "сэмплов в записи");
        assert_eq!(read_u32(&stts, 12), 1024, "длительность сэмпла");

        // stsz: размеры кадров
        let stsz = find_box(&mp4, b"stsz");
        assert_eq!(read_u32(&stsz, 4), 0, "размеры разные — нужна таблица");
        assert_eq!(read_u32(&stsz, 8), 3);
        assert_eq!(read_u32(&stsz, 12), 100);
        assert_eq!(read_u32(&stsz, 16), 150);
        assert_eq!(read_u32(&stsz, 20), 90);

        // stsc: по одному сэмплу в чанке
        let stsc = find_box(&mp4, b"stsc");
        assert_eq!(read_u32(&stsc, 4), 1);
        assert_eq!(read_u32(&stsc, 8), 1, "первый чанк");
        assert_eq!(read_u32(&stsc, 12), 1, "сэмплов в чанке");
        assert_eq!(read_u32(&stsc, 16), 1, "описание сэмпла");

        // stco: смещения указывают точно на кадры внутри mdat
        let stco = find_box(&mp4, b"stco");
        assert_eq!(read_u32(&stco, 4), 3);
        let mdat_start = top[2].1.start;
        assert_eq!(read_u32(&stco, 8) as usize, mdat_start);
        assert_eq!(read_u32(&stco, 12) as usize, mdat_start + 100);
        assert_eq!(read_u32(&stco, 16) as usize, mdat_start + 250);
        assert_eq!(&mp4[mdat_start..mdat_start + 100], &first[..]);
        assert_eq!(&mp4[mdat_start + 100..mdat_start + 250], &second[..]);
        assert_eq!(&mp4[mdat_start + 250..], &third[..], "хвост mdat — третий кадр");
    }

    #[test]
    fn muxer_uses_real_sample_rate_and_channels() {
        // 16 кГц, моно: и timescale, и запись сэмпла должны это повторить
        let source = adts_stream(&[
            adts_frame(8, 1, &[1u8; 80]),
            adts_frame(8, 1, &[2u8; 80]),
        ]);
        let mp4 = adts_to_m4a(&source).unwrap();
        assert_eq!(read_u32(&find_box(&mp4, b"mdhd"), 12), 16000);
        let mp4a = find_box(&mp4, b"mp4a");
        assert_eq!(read_u16(&mp4a, 16), 1, "моно");
        assert_eq!(read_u32(&mp4a, 24) >> 16, 16000);
        // stts: две записи быть не должно — кадры одинаковые
        assert_eq!(read_u32(&find_box(&mp4, b"stts"), 4), 1);
    }

    #[test]
    fn muxer_writes_one_stts_entry_per_distinct_duration() {
        // Многоблочный кадр, у которого позиции блоков не сходятся с длиной:
        // он уходит одним сэмплом длиной 2048, и записей в stts становится две.
        let first = [1u8; 60];
        let second = [2u8; 40];
        let payload_start = 9usize;
        let frame_len = payload_start + first.len() + second.len();
        let mut broken = vec![0xFF, 0xF1, (1 << 6) | (4 << 2), 2 << 6, 0, 0, 0xFC | 0x01];
        broken[3] = (((frame_len >> 11) as u8) & 0x03) | (2 << 6);
        broken[4] = ((frame_len >> 3) & 0xFF) as u8;
        broken[5] = (((frame_len & 0x07) as u8) << 5) | 0x1F;
        broken.extend_from_slice(&((frame_len + 100) as u16).to_be_bytes()); // позиция «за кадром»
        broken.extend_from_slice(&first);
        broken.extend_from_slice(&second);
        broken.extend(adts_frame(4, 2, &[3u8; 100]));

        let mp4 = adts_to_m4a(&broken).unwrap();
        let stts = find_box(&mp4, b"stts");
        assert_eq!(read_u32(&stts, 4), 2, "две записи: кадры разной длительности");
        assert_eq!(read_u32(&stts, 8), 1, "первая запись: один многоблочный кадр");
        assert_eq!(read_u32(&stts, 12), 2048, "два блока по 1024");
        assert_eq!(read_u32(&stts, 16), 1, "вторая запись: обычный кадр");
        assert_eq!(read_u32(&stts, 20), 1024);
        assert_eq!(read_u32(&find_box(&mp4, b"mdhd"), 16), 3 * 1024);
    }

    #[test]
    fn chunk_offsets_switch_to_co64_for_huge_files() {
        let small = chunk_offsets_box(&[0, 1000, 2000], false);
        assert_eq!(&small[4..8], &b"stco"[..]);
        assert_eq!(read_u32(&small, 12), 3, "три чанка после version/flags");
        assert_eq!(read_u32(&small, 16), 0, "первое смещение");
        assert_eq!(read_u32(&small, 24), 2000, "третье смещение");

        let big = chunk_offsets_box(&[u32::MAX as u64, u32::MAX as u64 + 1000], false);
        assert_eq!(&big[4..8], &b"co64"[..], "смещения вне 32 бит требуют co64");
        assert_eq!(read_u32(&big, 12), 2);
        assert_eq!(
            u64::from_be_bytes([
                big[24], big[25], big[26], big[27], big[28], big[29], big[30], big[31]
            ]),
            u32::MAX as u64 + 1000
        );
    }

    #[test]
    fn muxer_refuses_audio_without_channel_config() {
        // channel_config = 0 означает «описание каналов отдельно»: такого мы не
        // умеем, и честнее отказать, чем собрать неиграемый файл
        let mut stream = Vec::new();
        for index in 0..2u8 {
            let mut frame = adts_frame(4, 2, &[index; 50]);
            frame[2] &= !0x01;
            frame[3] &= 0x3F;
            stream.extend_from_slice(&frame);
        }
        let error = adts_to_m4a(&stream).unwrap_err();
        assert!(error.contains("каналов"), "получили: {error}");
    }

    /* ─────────── Демуксер MPEG-TS ─────────── */

    /// Поток TS: PAT, PMT и PES со звуком, разбитым на два пакета.
    fn synthetic_ts(elementary: &[u8]) -> Vec<u8> {
        let pmt_pid = 0x1000u16;
        let audio_pid = 0x101u16;
        let mut ts = Vec::new();
        ts.extend(psi_packet(PAT_PID, &pat_section(pmt_pid), 0));
        ts.extend(psi_packet(pmt_pid, &pmt_section(1, STREAM_TYPE_ADTS, audio_pid), 0));

        let pes = pes_packet(0xC0, elementary);
        let (head, tail) = pes.split_at(100);
        ts.extend(ts_packet(audio_pid, true, head, 0));
        ts.extend(ts_packet(audio_pid, false, tail, 1));
        ts
    }

    #[test]
    fn mpeg_ts_demux_pulls_adts_out_of_pes() {
        let first = adts_frame(4, 2, &[7u8; 64]);
        let second = adts_frame(4, 2, &[8u8; 48]);
        let mut elementary = Vec::new();
        elementary.extend_from_slice(&first);
        elementary.extend_from_slice(&second);

        let ts = synthetic_ts(&elementary);
        assert_eq!(detect(&ts), StreamFormat::MpegTs);
        assert_eq!(
            mpeg_ts_to_adts(&ts).unwrap(),
            elementary,
            "PES собирается по порядку, а его заголовок снимается"
        );

        // И целиком в M4A: те же два кадра
        let mp4 = mpeg_ts_to_m4a(&ts).unwrap();
        let stsz = find_box(&mp4, b"stsz");
        assert_eq!(read_u32(&stsz, 8), 2, "два кадра в таблице размеров");
        assert_eq!(read_u32(&stsz, 12) as usize, 64);
        assert_eq!(read_u32(&stsz, 16) as usize, 48);
        // В mdat лежат кадры без заголовков ADTS, в том же порядке
        let mut expected = first[7..].to_vec();
        expected.extend_from_slice(&second[7..]);
        assert_eq!(find_box(&mp4, b"mdat"), expected);
    }

    #[test]
    fn mpeg_ts_demux_handles_adaptation_fields() {
        let frame = adts_frame(4, 2, &[3u8; 60]);
        let pmt_pid = 0x1000u16;
        let audio_pid = 0x101u16;
        let mut ts = Vec::new();
        ts.extend(psi_packet(PAT_PID, &pat_section(pmt_pid), 0));
        ts.extend(psi_packet(pmt_pid, &pmt_section(1, STREAM_TYPE_ADTS, audio_pid), 0));

        let pes = pes_packet(0xC0, &frame);
        let (head, tail) = pes.split_at(60);
        // Первый пакет с адаптационным полем: полезная нагрузка сдвинута
        ts.extend(ts_packet_with_adaptation(audio_pid, true, head, 0));
        ts.extend(ts_packet(audio_pid, false, tail, 1));

        assert_eq!(mpeg_ts_to_adts(&ts).unwrap(), frame);
    }

    #[test]
    fn mpeg_ts_demux_finds_audio_without_pmt() {
        // PMT нет вовсе: PID звука ищем по аудио-PES
        let frame = adts_frame(4, 2, &[9u8; 70]);
        let pes = pes_packet(0xC0, &frame);
        let (head, tail) = pes.split_at(40);
        let audio_pid = 0x201u16;
        let mut ts = Vec::new();
        ts.extend(ts_packet(audio_pid, true, head, 0));
        ts.extend(ts_packet(audio_pid, false, tail, 1));

        assert_eq!(detect(&ts), StreamFormat::MpegTs);
        assert_eq!(mpeg_ts_to_adts(&ts).unwrap(), frame);
    }

    #[test]
    fn mpeg_ts_without_aac_audio_is_reported() {
        let pmt_pid = 0x1000u16;
        let video_pid = 0x101u16;
        let mut ts = Vec::new();
        ts.extend(psi_packet(PAT_PID, &pat_section(pmt_pid), 0));
        // H.264 вместо AAC
        ts.extend(psi_packet(pmt_pid, &pmt_section(1, 0x1B, video_pid), 0));
        ts.extend(ts_packet(video_pid, true, &pes_packet(0xE0, &[0u8; 40]), 0));

        let error = mpeg_ts_to_m4a(&ts).unwrap_err();
        assert!(error.contains("MPEG-TS"), "получили: {error}");
        assert!(error.contains("AAC"), "получили: {error}");
    }

    #[test]
    fn ts_sections_survive_continuation_packets() {
        // Секцию PMT растягиваем на два пакета: сборщик обязан её склеить
        let pmt = pmt_section(1, STREAM_TYPE_ADTS, 0x101);
        let (head, tail) = pmt.split_at(12);
        let mut ts = Vec::new();
        ts.extend(psi_packet(PAT_PID, &pat_section(0x1000), 0));
        // pointer_field, начало секции и её первый байт во втором пакете
        let mut pmt_start = vec![0x00u8];
        pmt_start.extend_from_slice(head);
        pmt_start.push(tail[0]);
        ts.extend(ts_packet_padded(0x1000, true, &pmt_start, 0));
        ts.extend(ts_packet_padded(0x1000, false, &tail[1..], 1));
        // Хвост секции короче пакета: остальное — набивка
        let frame = adts_frame(4, 2, &[4u8; 50]);
        ts.extend(ts_packet(0x101, true, &pes_packet(0xC0, &frame), 0));

        assert_eq!(mpeg_ts_to_adts(&ts).unwrap(), frame);
    }

    #[test]
    fn ts_section_with_payload_stuffing_does_not_fake_a_pid() {
        // Пакет добит набивкой прямо в полезной нагрузке: «секция» на первых
        // пакетах выглядит собранной, но контрольная сумма не сходится, поэтому
        // PID из неё не берётся — звук ищется запасным путём.
        let pmt = pmt_section(1, STREAM_TYPE_ADTS, 0x101);
        let (head, tail) = pmt.split_at(12);
        let mut pmt_start = vec![0x00u8];
        pmt_start.extend_from_slice(head);
        pmt_start.push(tail[0]);

        let frame = adts_frame(4, 2, &[6u8; 50]);
        let mut ts = Vec::new();
        ts.extend(psi_packet(PAT_PID, &pat_section(0x1000), 0));
        ts.extend(ts_packet(0x1000, true, &pmt_start, 0));
        ts.extend(ts_packet(0x1000, false, &tail[1..], 1));
        ts.extend(ts_packet(0x101, true, &pes_packet(0xC0, &frame), 0));

        assert_eq!(mpeg_ts_to_adts(&ts).unwrap(), frame);
    }

    #[test]
    fn psi_crc_matches_the_reference_value() {
        // Контрольное значение CRC-32/MPEG-2 для строки «123456789»
        assert_eq!(crc32_mpeg2(b"123456789"), 0x0376_E6E7);
        // Подписанная секция PAT проверку проходит
        let pat = pat_section(0x1000);
        assert!(section_is_complete(&pat));
        // А с испорченной суммой — нет
        let mut broken = pat.clone();
        let last = broken.len() - 1;
        broken[last] ^= 0xFF;
        assert!(!section_is_complete(&broken));
        // Секция без флага синтаксиса контрольной суммы не имеет
        assert!(section_is_complete(&[0x70, 0x02, 0x00]));
    }

    #[test]
    fn sections_with_broken_crc_are_not_emitted() {
        let mut buffer = SectionBuffer::default();
        let mut section = pat_section(0x1000);
        let last = section.len() - 1;
        section[last] ^= 0xFF;
        let mut payload = vec![0x00u8];
        payload.extend_from_slice(&section);
        assert!(
            buffer.push(true, &payload).is_empty(),
            "секция с плохой суммой не должна приниматься"
        );
    }

    #[test]
    fn ts_with_broken_packets_is_not_a_stream() {
        assert!(mpeg_ts_to_adts(&[0x47u8; 100]).is_err());
        assert!(mpeg_ts_to_adts(&[]).is_err());
        assert!(mpeg_ts_to_adts(b"not a transport stream at all").is_err());
    }

    #[test]
    fn section_buffer_ignores_stuffing_and_partial_sections() {
        let mut buffer = SectionBuffer::default();
        // Набивка 0xFF после секции: ничего лишнего не собирается
        let mut payload = vec![0x00u8];
        payload.extend_from_slice(&pat_section(0x1000));
        payload.extend_from_slice(&[0xFFu8; 20]);
        let sections = buffer.push(true, &payload);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0][0], 0x00, "table_id PAT");

        // Неполная секция ждёт продолжения
        let mut buffer = SectionBuffer::default();
        assert!(buffer.push(true, &[0x00, 0xB0]).is_empty());
    }
}
