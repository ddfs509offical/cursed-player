import { create } from "zustand";
import { trackFromLocal, type Track } from "./playerStore";
import { readFiles, scanFolder } from "../services/player";

const STORAGE_KEY = "music_hub_local_library";

function load(): Track[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Track => {
      const track = item as Partial<Track>;
      return typeof track?.path === "string" && typeof track?.title === "string";
    });
  } catch {
    return [];
  }
}

interface LibraryState {
  tracks: Track[];
  /** Сканируем папку: возвращает сколько треков добавлено. */
  addFolder: (path: string) => Promise<number>;
  /** Добавляем конкретные файлы. */
  addFiles: (paths: string[]) => Promise<number>;
  setTracks: (tracks: Track[]) => void;
  remove: (path: string) => void;
  clear: () => void;
}

/**
 * Локальная библиотека: пути и теги хранятся локально, файлы не копируются.
 * При старте содержимое сверяется с диском — удалённые файлы уходят из списка.
 */
export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: load(),

  addFolder: async (path) => {
    const found = await scanFolder(path);
    if (!found.length) return 0;
    const incoming = found.map(trackFromLocal);
    const known = new Set(get().tracks.map((track) => track.path));
    const merged = [...get().tracks, ...incoming.filter((track) => !known.has(track.path))];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    set({ tracks: merged });
    return incoming.filter((track) => !known.has(track.path)).length;
  },

  addFiles: async (paths) => {
    const found = await readFiles(paths);
    if (!found.length) return 0;
    const incoming = found.map(trackFromLocal);
    const known = new Set(get().tracks.map((track) => track.path));
    const merged = [...get().tracks, ...incoming.filter((track) => !known.has(track.path))];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    set({ tracks: merged });
    return incoming.length;
  },

  setTracks: (tracks) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
    set({ tracks });
  },

  remove: (path) => {
    const next = get().tracks.filter((track) => track.path !== path);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    set({ tracks: next });
  },

  clear: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ tracks: [] });
  },
}));
