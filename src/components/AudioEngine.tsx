import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { playerAudio, setAudioOutput, audioOutputSupported } from "../player/audio";
import { usePlayerStore, restorePlayerState, applyVolume, type Track } from "../store/playerStore";
import { useSettingsStore } from "../store/settingsStore";
import { APP_NAME } from "../lib/app";
import { errorText, logError } from "../store/errorStore";
import { useHistoryStore } from "../store/historyStore";
import { maybeAutoCache } from "../services/autoCache";
import { useOfflineStore } from "../store/offlineStore";
import { findOffline } from "../lib/offline";
import { cachedTailSilence, ensureTailSilence, isLocalFilePath } from "../lib/tailSilence";

/**
 * Насколько позже старта трека запускать разбор хвостовой тишины. Декодирование
 * файла — работа на сотни миллисекунд, и в момент включения звука ей не место:
 * ждём, пока воспроизведение устоялось.
 */
const TAIL_ANALYSIS_DELAY_MS = 6000;

/**
 * Не пропускать хвост одного и того же трека дважды подряд. Тик позиции идёт
 * несколько раз в секунду, а смена трека (особенно повтор одного) занимает
 * время — без паузы переход сработал бы ещё раз прямо в момент перехода.
 */
const TAIL_SKIP_COOLDOWN_MS = 3000;

/**
 * Связывает HTMLAudioElement с состоянием плеера: позиция, длина трека,
 * конец трека, громкость музыки, возврат состояния после перезапуска,
 * команды из трея и уведомление о смене трека.
 */
export default function AudioEngine() {
  const volume = usePlayerStore((s) => s.volume);
  const musicVolume = useSettingsStore((s) => s.playerVolume);
  const audioOutputId = useSettingsStore((s) => s.audioOutputId);
  const notify = useSettingsStore((s) => s.notifyOnTrackChange);
  const trackTitle = usePlayerStore((s) => s.trackTitle);
  const trackArtist = usePlayerStore((s) => s.trackArtist);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const skipTailSilence = useSettingsStore((s) => s.skipTailSilence);
  const currentTrackId = usePlayerStore((s) => s.queue[s.index]?.id ?? "");
  /** Офлайн-файлы: у сервисного трека локальный путь есть только здесь. */
  const offlineList = useOfflineStore((s) => s.list);
  const restored = useRef(false);
  /** Трек, хвост которого уже пропущен, и когда это случилось. */
  const tailSkip = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  const lastNotified = useRef<string>("");
  /** Последний трек, записанный в историю: чтобы не считать паузы за прослушивание. */
  const lastRecorded = useRef<string>("");
  /**
   * Учёт фактически прослушанного времени: накапливаем разницу позиции трека и
   * пачками пишем её в историю. Перемотка, пауза и обрыв потока временем не
   * считаются — иначе статистика показывала бы выдуманные часы.
   */
  const listened = useRef<{ id: string | null; position: number; pending: number }>({
    id: null,
    position: 0,
    pending: 0,
  });

  // Возвращаем очередь, режимы и позицию трека после перезапуска
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    restorePlayerState();
    // Ноль — это настоящая позиция ползунка («выключено»), а не «нет значения»:
    // подставлять вместо него настройку музыки нельзя.
    const state = usePlayerStore.getState();
    const saved = Number.isFinite(state.volume) ? state.volume : musicVolume;
    // В состоянии хранится позиция ползунка, на аудио ставим её кривую
    applyVolume(saved);
  }, [musicVolume]);

  useEffect(() => {
    // Громкость всегда идёт через кривую: ползунок в начале шкалы — тихо
    applyVolume(volume);
  }, [volume]);

  /**
   * Страховка от «залипшей» нулевой громкости: ползунок стоит не на нуле, а
   * элемент молчит. Такое раньше проходило незаметно — тишина без единого
   * сообщения, и пользователь искал причину в устройстве вывода. Теперь кривая
   * возвращается, а случай попадает в журнал.
   */
  const volumeGuardLogged = useRef(false);
  useEffect(() => {
    const audio = playerAudio;
    if (!audio) return;
    const onPlay = () => {
      const slider = usePlayerStore.getState().volume;
      if (slider <= 0 || audio.volume > 0) return;
      applyVolume(slider);
      if (volumeGuardLogged.current) return;
      volumeGuardLogged.current = true;
      logError(
        "Звук был заглушён мимо ползунка",
        "Громкость восстановлена по положению ползунка",
        "звук",
        `Ползунок: ${slider}\nГромкость элемента: ${audio.volume}`
      );
    };
    audio.addEventListener("play", onPlay);
    return () => audio.removeEventListener("play", onPlay);
  }, []);

  /**
   * Устройство вывода из настроек. Применяем тихо, без тостов: при старте
   * пользователь ничего не выбирал. Устройство отключили — возвращаемся на
   * системное по умолчанию и пишем причину в журнал, иначе звук «пропадает»
   * без объяснений.
   */
  useEffect(() => {
    if (!playerAudio || !audioOutputSupported()) return;
    if (!audioOutputId || audioOutputId === "default") return;
    let cancelled = false;
    void setAudioOutput(audioOutputId).catch((error) => {
      if (cancelled) return;
      useSettingsStore.getState().setAudioOutputId("default");
      logError(
        "Не удалось направить звук на выбранное устройство",
        "Устройство отключено или недоступно — играем на системном по умолчанию",
        "звук",
        errorText(error)
      );
    });
    return () => {
      cancelled = true;
    };
  }, [audioOutputId]);

  useEffect(() => {
    const audio = playerAudio;
    if (!audio) return;
    const store = usePlayerStore.getState;

    /**
     * Сброс накопленных секунд в историю. Пишем пачками (раз в ~15 секунд
     * звука), а не на каждое событие: localStorage не должен дёргаться на
     * каждый тик позиции.
     */
    const flushListened = (force = false) => {
      const account = listened.current;
      if (!account.id) return;
      const enough = force ? 0.05 : 15;
      if (account.pending < enough) return;
      const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
      useHistoryStore.getState().addSeconds(account.id, account.pending, durationMs);
      account.pending = 0;
    };

    /**
     * Сколько реально проиграно с прошлого тика. Разница больше нескольких
     * секунд означает перемотку или подгрузку потока — такое не засчитываем.
     */
    const trackListened = () => {
      const state = store();
      const track = state.queue[state.index];
      const id = track?.id ?? null;
      const account = listened.current;
      const position = audio.currentTime;
      if (account.id !== id) {
        flushListened(true);
        account.id = id;
        account.pending = 0;
        account.position = position;
        return;
      }
      const delta = position - account.position;
      if (delta > 0 && delta < 3) account.pending += delta;
      account.position = position;
      flushListened();
    };

    const onTime = () => {
      store().setPosition(audio.currentTime);
      trackListened();
      maybeSkipTailSilence();
    };
    const onMeta = () => store().setDuration(Number.isFinite(audio.duration) ? audio.duration * 1000 : 0);
    const onPlay = () => {
      usePlayerStore.setState({ isPlaying: true, hasStarted: true });
      // В историю пишем один раз на трек: пауза и возобновление не считаются,
      // а повторный запуск с начала — считается
      const state = store();
      const track = state.queue[state.index];
      if (!track) return;
      /**
       * Прослушанный сервисный трек тихо остаётся на диске: в следующий раз
       * он заиграет даже без интернета. Фоновое сохранение не мешает звуку.
       */
      maybeAutoCache(track);
      const restarted = audio.currentTime < 3;
      if (lastRecorded.current !== track.id || restarted) {
        lastRecorded.current = track.id;
        useHistoryStore.getState().record(track);
      }
      // Учёт времени начинаем с текущей позиции: скачок при смене трека не в счёт
      flushListened(true);
      listened.current.id = track.id;
      listened.current.position = audio.currentTime;
    };
    const onPause = () => {
      // Пауза закрывает кусок прослушивания: остаток секунд уходит в историю
      flushListened(true);
      usePlayerStore.setState({ isPlaying: false });
    };
    /**
     * Окончание трека — общий путь для естественного конца и для пропуска
     * хвостовой тишины: повтор, случайный порядок и очередь обрабатываются в
     * одном месте, поэтому вести себя эти случаи обязаны одинаково.
     */
    const finishTrack = () => {
      flushListened(true);
      const state = store();

      /*
       * Повтор одного трека — первым делом и без посредников. Раньше конец
       * уходил в `onTrackEnded`, а тот звал `seekFraction(0)`: при нулевой
       * длительности в состоянии перемотка молча отменялась, и трек
       * замолкал в конце. Теперь здесь прямое перематывание к началу и
       * запуск, со страховкой на случай, если позиция не сдвинулась.
       */
      if (state.repeat === "one") {
        // После `ended` элемент не всегда принимает перемотку сразу: у
        // потокового файла позиция «прилипает» к концу. Перезапускаем с
        // небольшой задержкой и проверяем, что звук пошёл.
        const restart = (attempt: number) => {
          if (attempt > 3) return;
          try {
            audio.currentTime = 0;
          } catch {
            // Элемент мог ещё не знать длительность — попробуем ещё раз
          }
          store().setPosition(0);
          void audio.play().catch(() => {});
          window.setTimeout(() => {
            const running = !audio.paused && audio.currentTime < (audio.duration || Infinity) - 0.3;
            if (!running) restart(attempt + 1);
          }, 140);
        };
        restart(0);
        return;
      }

      // Дослушанный трек в следующий раз начнётся с начала
      state.forgetPosition();
      state.onTrackEnded();
    };

    /**
     * Пропуск хвостовой тишины. Работает только когда настройка включена и для
     * текущего трека есть готовый разбор: у потоковых треков разбора не бывает,
     * и здесь тогда ничего не происходит. Результат берём из памяти — читать
     * хранилище на каждом тике позиции нельзя.
     */
    const maybeSkipTailSilence = () => {
      if (!useSettingsStore.getState().skipTailSilence) return;
      const state = store();
      const track = state.queue[state.index];
      if (!track) return;
      const cached = cachedTailSilence(track.id);
      if (!cached.known || !cached.value) return;
      if (audio.currentTime * 1000 < cached.value.silenceStartMs) return;
      const mark = tailSkip.current;
      if (mark.id === track.id && Date.now() - mark.at < TAIL_SKIP_COOLDOWN_MS) return;
      tailSkip.current = { id: track.id, at: Date.now() };
      finishTrack();
    };

    /**
     * Окончание трека: повтор одного трека обрабатывается здесь, отдельно от
     * сокрытия хвостовой тишины. Эти два пути не должны пересекаться — иначе
     * при повторе вместо перезапуска срабатывает переход к следующему треку.
     */
    const onEnded = () => {
      const state = store();
      // Диагностика: какой режим видит обработчик в момент конца трека.
      (window as unknown as { __obsRepeatSeen?: string }).__obsRepeatSeen = state.repeat;
      if (state.repeat === "one") {
        audio.currentTime = 0;
        state.setPosition(0);
        // Начать заново: элемент после `ended` принимает перемотку сразу,
        // а `play` его разблокирует.
        void audio.play().catch(() => {});
        return;
      }
      finishTrack();
    };
    const onError = () => {
      // До ошибки трек мог играть — это время тоже настоящее
      flushListened(true);
      const track = store().queue[store().index];
      const message =
        track?.source === "service"
          ? "Сервис не отдал поток: проверь подписку или формат (HLS)"
          : "Файл не воспроизводится: формат не поддержан или файл недоступен";
      logError(
        "Ошибка воспроизведения",
        `${message}${track ? ` — «${track.title}»` : ""}`,
        "плеер",
        `Трек: ${track?.path ?? "нет"}\nИсточник: ${track?.source ?? "нет"}\nКод ошибки медиа: ${
          playerAudio?.error?.code ?? "нет"
        }\nСообщение: ${playerAudio?.error?.message ?? "нет"}`
      );
      usePlayerStore.setState({ error: message, isPlaying: false });
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    // Закрытие окна не должно терять последний кусок прослушанного
    const onUnload = () => flushListened(true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      flushListened(true);
      window.removeEventListener("beforeunload", onUnload);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, []);

  /**
   * Разбор хвостовой тишины текущего трека. Только для локального файла: у
   * трека из библиотеки это его путь, у сервисного — путь офлайн-копии. Поток
   * разбирать нельзя (см. `lib/tailSilence.ts`), поэтому там мы просто выходим.
   *
   * Анализ идёт в фоне и с задержкой: воспроизведение уже началось, и разбор
   * ему не мешает. Готовый результат прошлого раза поднимаем из кеша сразу —
   * тогда следующий тик позиции его уже видит.
   */
  useEffect(() => {
    if (!skipTailSilence || !currentTrackId) return;
    const state = usePlayerStore.getState();
    const track = state.queue[state.index];
    if (!track) return;

    const localPath =
      track.source === "local"
        ? track.path
        : findOffline(offlineList, track.id)?.path ?? "";
    if (!localPath || !isLocalFilePath(localPath)) return;

    cachedTailSilence(track.id);
    const timer = window.setTimeout(() => {
      void ensureTailSilence(track.id, localPath);
    }, TAIL_ANALYSIS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [skipTailSilence, currentTrackId, offlineList]);

  // Команды из трея
  useEffect(() => {
    let unlistenToggle: (() => void) | undefined;
    let unlistenNext: (() => void) | undefined;
    /**
     * Права на прослушивание событий выдаёт сборка (ACL). Если их нет, промис
     * отклоняется — раньше это давало две «Uncaught (in promise)» в консоли при
     * каждом запуске. Кнопки трея в таком случае просто не работают: показать
     * это в интерфейсе нечем, а пугать ошибкой в консоли незачем.
     */
    const bind = (event: string, run: () => void, save: (fn: () => void) => void) => {
      void listen(event, run).then(save).catch(() => {});
    };
    bind("tray://toggle", () => usePlayerStore.getState().togglePlay(), (fn) => {
      unlistenToggle = fn;
    });
    bind("tray://next", () => usePlayerStore.getState().next(), (fn) => {
      unlistenNext = fn;
    });
    return () => {
      unlistenToggle?.();
      unlistenNext?.();
    };
  }, []);

  // Уведомление при смене трека: только если пользователь включил его
  useEffect(() => {
    if (!notify || !isPlaying || !trackTitle) return;
    const key = `${trackTitle}|${trackArtist}`;
    if (lastNotified.current === key) return;
    lastNotified.current = key;
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "granted") {
        new Notification(APP_NAME, { body: trackArtist ? `${trackTitle} — ${trackArtist}` : trackTitle });
      } else if (Notification.permission !== "denied") {
        void Notification.requestPermission();
      }
    } catch {
      // Уведомления недоступны — молча продолжаем
    }
  }, [notify, isPlaying, trackTitle, trackArtist]);

  // Пробел и медиа-клавиши (не срабатывают при вводе текста)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (event.code === "Space" && !typing) {
        event.preventDefault();
        usePlayerStore.getState().togglePlay();
      }
      if (event.code === "MediaPlayPause") usePlayerStore.getState().togglePlay();
      if (event.code === "MediaTrackNext") usePlayerStore.getState().next();
      if (event.code === "MediaTrackPrevious") usePlayerStore.getState().previous();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Перед закрытием сохраняем позицию, чтобы продолжить с того же места
  useEffect(() => {
    const onBeforeUnload = () => {
      const state = usePlayerStore.getState();
      const track: Track | undefined = state.queue[state.index];
      if (track && playerAudio) state.setPosition(playerAudio.currentTime);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return null;
}
