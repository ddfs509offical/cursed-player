//! Картинки профиля: выбор файла в системном диалоге, загрузка по ссылке и
//! подготовка к хранению.
//!
//! Ресайз делается здесь, а не в интерфейсе: в базу попадает уже сжатая
//! картинка (аватар — квадрат до 512px, баннер — до 1920px по ширине), поэтому
//! профиль остаётся лёгким, а в data-URL не уезжает 10-мегабайтный оригинал.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageFormat};
use std::io::{Cursor, Read};
use std::time::Duration;

const MAX_BYTES: u64 = 12 * 1024 * 1024;
const JPEG_QUALITY: u8 = 82;
/// Анимированные GIF не пересобираем: ресайз убил бы анимацию.
const GIF_MAX_BYTES: usize = 6 * 1024 * 1024;

fn is_gif(bytes: &[u8]) -> bool {
    bytes.len() > 6 && &bytes[0..3] == b"GIF"
}

/// Куда вписываем картинку: (ширина, высота, обрезать ли в квадрат).
fn target(kind: &str) -> (u32, u32, bool) {
    match kind {
        "banner" => (1920, 720, false),
        _ => (512, 512, true),
    }
}

fn encode(img: &DynamicImage) -> Result<String, String> {
    let mut buffer: Vec<u8> = Vec::new();
    if img.color().has_alpha() {
        img.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png)
            .map_err(|e| format!("Не удалось сохранить картинку: {e}"))?;
        Ok(format!("data:image/png;base64,{}", STANDARD.encode(&buffer)))
    } else {
        let rgb = img.to_rgb8();
        {
            let mut cursor = Cursor::new(&mut buffer);
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, JPEG_QUALITY);
            encoder
                .encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                .map_err(|e| format!("Не удалось сохранить картинку: {e}"))?;
        }
        Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(&buffer)))
    }
}

pub fn process(bytes: &[u8], kind: &str) -> Result<String, String> {
    // GIF отдаём как есть — иначе пропадёт анимация
    if is_gif(bytes) {
        if bytes.len() > GIF_MAX_BYTES {
            return Err("Анимированный GIF больше 6 МБ — возьми файл поменьше".into());
        }
        return Ok(format!("data:image/gif;base64,{}", STANDARD.encode(bytes)));
    }

    let img = image::load_from_memory(bytes).map_err(|_| "Это не похоже на картинку".to_string())?;
    let (width, height, square) = target(kind);
    let resized = if square {
        img.resize_to_fill(width, height, FilterType::Lanczos3)
    } else {
        img.resize(width, height, FilterType::Lanczos3)
    };
    encode(&resized)
}

/// Открывает системный диалог выбора файла. `None` — пользователь отменил.
pub fn pick(kind: &str) -> Result<Option<String>, String> {
    // rfd есть только на настольных платформах: на Android выбор картинки
    // идёт через системный диалог, здесь честно возвращаем «отменено».
    #[cfg(not(desktop))]
    {
        let _ = kind;
        return Ok(None);
    }
    #[cfg(desktop)]
    {
        let picked = rfd::FileDialog::new()
            .set_title("Выбери изображение")
            .add_filter("Изображения", &["png", "jpg", "jpeg", "webp", "gif", "bmp"])
            .pick_file();
        match picked {
            None => return Ok(None),
            Some(path) => {
                let meta = std::fs::metadata(&path).map_err(|e| format!("Не удалось открыть файл: {e}"))?;
                if meta.len() > MAX_BYTES {
                    return Err("Файл больше 12 МБ — выбери картинку поменьше".into());
                }
                let bytes = std::fs::read(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;
                return Ok(Some(process(&bytes, kind)?));
            }
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = kind;
        return Ok(None);
    }
}

/// Скачивает картинку по ссылке на стороне приложения: у WebView свои правила
/// CORS, поэтому обычный fetch из интерфейса на чужие домены не сработает.
pub fn fetch(url: &str, kind: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Ссылка должна начинаться с http:// или https://".into());
    }

    let response = ureq::get(trimmed)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| format!("Не удалось скачать картинку: {e}"))?;

    let mut bytes: Vec<u8> = Vec::new();
    response
        .into_reader()
        .take(MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Не удалось прочитать ответ: {e}"))?;

    if bytes.is_empty() {
        return Err("Сервер вернул пустой ответ".into());
    }
    process(&bytes, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};

    fn decoded(data_url: &str) -> (String, Vec<u8>) {
        let (meta, payload) = data_url.split_once(',').expect("data-url без запятой");
        let mime = meta.trim_start_matches("data:").trim_end_matches(";base64").to_string();
        (mime, STANDARD.decode(payload).expect("не base64"))
    }

    #[test]
    fn avatar_becomes_square_jpeg() {
        let source = RgbImage::from_pixel(1000, 600, Rgb([200, 60, 60]));
        let mut buffer = Vec::new();
        source.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png).unwrap();

        let result = process(&buffer, "avatar").unwrap();
        assert!(result.starts_with("data:image/jpeg;base64,"), "аватар без альфы должен стать JPEG");

        let (_, bytes) = decoded(&result);
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!(img.dimensions(), (512, 512), "аватар должен обрезаться в квадрат 512x512");
    }

    #[test]
    fn banner_keeps_aspect_and_fits_width() {
        let source = RgbImage::from_pixel(3000, 1000, Rgb([20, 20, 30]));
        let mut buffer = Vec::new();
        source.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png).unwrap();

        let result = process(&buffer, "banner").unwrap();
        let (_, bytes) = decoded(&result);
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!(img.width(), 1920);
        assert!(img.height() < 1000, "баннер должен уменьшиться по высоте пропорционально");
    }

    #[test]
    fn transparency_is_kept_as_png() {
        let source = RgbaImage::from_pixel(300, 300, Rgba([10, 200, 120, 0]));
        let mut buffer = Vec::new();
        source.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png).unwrap();

        let result = process(&buffer, "avatar").unwrap();
        assert!(result.starts_with("data:image/png;base64,"), "прозрачность должна сохраниться");
    }

    /// Иконка приложения должна быть квадратной, как аватар
    #[test]
    fn app_icon_is_square() {
        let source = RgbImage::from_pixel(900, 400, Rgb([240, 200, 40]));
        let mut buffer = Vec::new();
        source.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png).unwrap();

        let (_, bytes) = decoded(&process(&buffer, "app-icon").unwrap());
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!(img.dimensions(), (512, 512), "иконка приложения должна стать квадратом 512x512");
    }

    #[test]
    fn animated_gif_is_kept_as_gif() {
        // Минимальный GIF: заголовок + логический экран
        let gif: Vec<u8> = vec![
            b'G', b'I', b'F', b'8', b'9', b'a', 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
        ];
        let result = process(&gif, "avatar").unwrap();
        assert!(result.starts_with("data:image/gif;base64,"), "GIF должен остаться GIF: {result:.40}");
    }

    #[test]
    fn garbage_is_rejected() {
        let error = process(b"this is not an image", "avatar").unwrap_err();
        assert!(error.contains("не похоже на картинку"), "получили: {error}");
    }
}
