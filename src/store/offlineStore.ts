/**
 * Офлайн-хранилище: что уже сохранено на диск, знает всё приложение.
 *
 * Записи лежат в объекте по ключу трека (`offlineKey`), поэтому плеер находит
 * локальную копию мгновенно и без обращения к диску: именно это делает
 * возможным главное правило — офлайн-копия важнее сети, и проверяется она до
 * любого запроса ссылки на поток.
 *
 * Хранилище наполняется один раз при старте (`refresh`, одно чтение диска на
 * всех), а после сохранения, удаления и уборки обновляется — см. `upsert`,
 * `forget`, `refresh`. Список приходит из реестра без разбора тегов; недостающие
 * метаданные догружаются в фоне по одному файлу (`enrichMissing`).
 */

import { create } from "zustand";
import { offlineFiles, offlineMeta, type SavedFile } from "../services/downloads";
import { offlineKey, offlineTrack, type OfflineTrack } from "../lib/offline";
import { errorText, logError } from "./errorStore";
import { softDelete, touch } from "./syncMeta";

interface OfflineState {
  /** Записи по ключу трека: по нему плеер ищет копию. */
  records: Record<string, SavedFile>;
  /** Те же записи списком, свежие сверху — для вкладки «Скачанные». */
  list: SavedFile[];
  /** Суммарный размер офлайн-файлов: по нему автокеш сверяет лимит. */
  totalBytes: number;
  /** Список прочитан хотя бы раз (или попытка была). */
  loaded: boolean;
  loading: boolean;

  /** Перечитывает список с диска. Ошибку сообщает вызывающему и в журнал. */
  refresh: () => Promise<SavedFile[]>;
  /** Гарантирует, что список прочитан: нужен тому, кто без него не решит. */
  ensureLoaded: () => Promise<void>;
  /** Запись о треке или null, если офлайн-копии нет. */
  record: (trackId: string) => SavedFile | null;
  /** Локальная копия как трек для плеера или null. */
  find: (trackId: string) => OfflineTrack | null;
  /** Кладёт свежую запись в хранилище (после сохранения трека). */
  upsert: (file: SavedFile) => void;
  /** Убирает запись по идентификатору трека (после удаления файла). */
  forget: (trackId: string) => void;
  /** Забывает всё: выход из профиля и смена аккаунта. */
  clear: () => void;
  /**
   * Синхронизация: отметить запись изменённой во время `atMs` (по умолчанию —
   * сейчас). Чтение списка с диска ничего не помечает: это не изменение.
   */
  markChanged: (trackId: string, atMs?: number) => void;
}

/** Общий промис чтения: плеер и интерфейс не должны читать диск дважды. */
let pendingLoad: Promise<SavedFile[]> | null = null;
/** Метаданные, которые уже пробовали догрузить: битый файл не должен зацикливать. */
const metaAttempted = new Set<string>();
/** Догрузка идёт по одному файлу за раз: пачка чтений диска не нужна никому. */
let enriching = false;

/** Записи, метаданные которых ещё не читались из файла (list их не читает). */
function needsMeta(file: SavedFile): boolean {
  return !(file.durationMs > 0) && !metaAttempted.has(file.trackId);
}

/**
 * Ленивая догрузка метаданных: список приходит из реестра мгновенно, а теги
 * файлов читаются по одному и в фоне. Ничего не перезапускает и никого не
 * ждёт — интерфейс просто получает подробности, когда они готовы.
 */
async function enrichMissing(): Promise<void> {
  if (enriching) return;
  enriching = true;
  try {
    for (;;) {
      const next = useOfflineStore.getState().list.find(needsMeta);
      if (!next) return;
      metaAttempted.add(next.trackId);
      try {
        const filled = await offlineMeta(next.trackId);
        useOfflineStore.getState().upsert(filled);
      } catch (e) {
        // Метаданные не критичны: файл играет и без них
        logError(
          "Не удалось прочитать метаданные офлайн-файла",
          next.title || next.trackId,
          "офлайн",
          errorText(e)
        );
      }
    }
  } finally {
    enriching = false;
  }
}

/** Объект для поиска по ключу: два id могли сойтись в один ключ — берём свежий. */
function index(files: SavedFile[]): Record<string, SavedFile> {
  const records: Record<string, SavedFile> = {};
  for (const file of files) {
    const key = offlineKey(file.trackId);
    if (key) records[key] = file;
  }
  return records;
}

function sortFresh(files: SavedFile[]): SavedFile[] {
  return [...files].sort((a, b) => (b.savedAtMs ?? 0) - (a.savedAtMs ?? 0));
}

function sum(files: SavedFile[]): number {
  return files.reduce((total, file) => total + (Number.isFinite(file.size) ? file.size : 0), 0);
}

export const useOfflineStore = create<OfflineState>((set, get) => {
  const apply = (files: SavedFile[]) => {
    const sorted = sortFresh(files);
    set({
      list: sorted,
      records: index(sorted),
      totalBytes: sum(sorted),
      loaded: true,
      loading: false,
    });
  };

  return {
    records: {},
    list: [],
    totalBytes: 0,
    loaded: false,
    loading: false,

    refresh: async () => {
      // Чтение списка одно на всех: старт приложения, страница «Скачанные» и
      // плеер могут попросить его почти одновременно, а диск читаем один раз
      if (pendingLoad) return pendingLoad;

      const task = (async () => {
        set({ loading: true });
        try {
          const files = await offlineFiles();
          apply(files);
          // Подробности (альбом, длительность) догружаем в фоне: список
          // приходит из реестра мгновенно, теги файлов читаются по одному
          void enrichMissing();
          return files;
        } catch (e) {
          set({ loading: false, loaded: true });
          logError(
            "Не удалось прочитать список сохранённых треков",
            "Файлы офлайн-треков лежат в папке кеша приложения",
            "офлайн",
            errorText(e)
          );
          throw e;
        }
      })();

      const guarded = task.finally(() => {
        if (pendingLoad === guarded) pendingLoad = null;
      });
      pendingLoad = guarded;
      return guarded;
    },

    ensureLoaded: async () => {
      if (get().loaded) return;
      // Плеер не должен падать из-за того, что список не прочитался:
      // он просто пойдёт за ссылкой в сеть, как раньше.
      await get()
        .refresh()
        .catch(() => undefined);
    },

    record: (trackId) => {
      const key = offlineKey(trackId);
      if (!key) return null;
      return get().records[key] ?? null;
    },

    find: (trackId) => {
      const record = get().record(trackId);
      return record ? offlineTrack(record, trackId) : null;
    },

    upsert: (file) => {
      const list = get().list.filter((item) => item.path !== file.path && item.trackId !== file.trackId);
      apply([...list, file]);
      // Синхронизация: отметка «держу офлайн» изменилась
      touch("offline", file.trackId);
    },

    forget: (trackId) => {
      const key = offlineKey(trackId);
      if (!key) return;
      apply(get().list.filter((item) => offlineKey(item.trackId) !== key));
      // Файл удалён: удаление не стираем молча, оно должно уехать на сервер
      softDelete("offline", trackId, null);
    },

    clear: () => {
      set({ records: {}, list: [], totalBytes: 0, loaded: false, loading: false });
    },

    markChanged: (trackId, atMs) => {
      touch("offline", trackId, atMs);
    },
  };
});

/** Перечитать список без React: удобно звать после сохранения и удаления. */
export async function refreshOffline(): Promise<void> {
  await useOfflineStore
    .getState()
    .refresh()
    .catch(() => undefined);
}

/** Гарантировать прочитанный список (для автокеша и ленивой догрузки). */
export async function ensureOfflineLoaded(): Promise<void> {
  await useOfflineStore.getState().ensureLoaded();
}

/**
 * Локальная копия трека, если она сохранена: её можно играть без сети.
 * Список читается заранее и теперь только из реестра — без разбора тегов,
 * поэтому ожидание здесь стоит миллисекунды, а не чтение всех файлов.
 */
export async function findOfflineCopy(trackId: string): Promise<OfflineTrack | null> {
  await ensureOfflineLoaded();
  return useOfflineStore.getState().find(trackId);
}

/** Подписка на изменения списка: возвращает функцию отписки. */
export function subscribeOffline(listener: (files: SavedFile[]) => void): () => void {
  return useOfflineStore.subscribe((state, previous) => {
    if (state.list !== previous.list) listener(state.list);
  });
}
