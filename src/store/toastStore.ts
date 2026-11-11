import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: string;
  title: string;
  description?: string;
  action?: ToastAction;
  tone: "default" | "danger";
  createdAt: number;
}

interface ToastInput {
  title: string;
  description?: string;
  action?: ToastAction;
  tone?: Toast["tone"];
}

interface ToastState {
  toasts: Toast[];
  /** `force` нужен для уведомления о самом переключателе уведомлений. */
  push: (toast: ToastInput, options?: { force?: boolean }) => string | null;
  dismiss: (id: string) => void;
}

// На экране не больше двух карточек: третье изменение вытесняет самое старое
const MAX_TOASTS = 2;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (toast, options) => {
    if (!useSettingsStore.getState().toastsEnabled && !options?.force) return null;
    const id = globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random());
    const next: Toast = {
      id,
      title: toast.title,
      description: toast.description,
      action: toast.action,
      tone: toast.tone ?? "default",
      createdAt: Date.now(),
    };
    // Держим не больше двух карточек, вытесняя самые старые
    set({ toasts: [...get().toasts, next].slice(-MAX_TOASTS) });
    return id;
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
}));

/** Удобный вызов без хука: push({ title: "…", action: … }). */
export function toast(input: ToastInput, options?: { force?: boolean }) {
  return useToastStore.getState().push(input, options);
}
