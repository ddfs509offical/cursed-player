import { create } from "zustand";

/**
 * Журнал ошибок: всё, что падало, сохраняется локально, чтобы можно было
 * открыть любую ошибку позже и посмотреть подробности. Хранится последние 60.
 */

const KEY = "music_hub_errors";

export interface AppError {
  id: string;
  /** Время в миллисекундах. */
  at: number;
  title: string;
  description: string;
  /** Где произошло: «поиск», «плеер», «сервисы» и т.п. */
  source: string;
  /** Полный текст: ответ сервиса, стек, технические детали. */
  details?: string;
}

function load(): AppError[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AppError => {
      const error = item as Partial<AppError>;
      return typeof error?.title === "string" && typeof error?.at === "number";
    });
  } catch {
    return [];
  }
}

interface ErrorState {
  errors: AppError[];
  log: (error: { title: string; description: string; source: string; details?: string }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useErrorStore = create<ErrorState>((set, get) => {
  const store = (errors: AppError[]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(errors));
    } catch {
      // переполнение хранилища не должно ломать приложение
    }
    set({ errors });
  };

  return {
    errors: load(),
    log: ({ title, description, source, details }) => {
      const entry: AppError = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        title,
        description,
        source,
        details,
      };
      // Дубли подряд не пишем: одинаковая ошибка подряд — один раз
      const [first] = get().errors;
      if (first && first.title === title && first.description === description) return;
      store([entry, ...get().errors].slice(0, 60));
    },
    remove: (id) => store(get().errors.filter((error) => error.id !== id)),
    clear: () => {
      localStorage.removeItem(KEY);
      set({ errors: [] });
    },
  };
});

/** Записать ошибку в журнал (можно звать откуда угодно). */
export function logError(
  title: string,
  description: string,
  source = "приложение",
  details?: string
): void {
  useErrorStore.getState().log({ title, description, source, details });
}

/** Разбор любого пойманного значения в текст для журнала. */
export function errorText(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return typeof value === "string" ? value : JSON.stringify(value);
}
