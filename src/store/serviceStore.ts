import { create } from "zustand";
import { detectAvailability } from "../services/catalog";
import type { ServiceId } from "../lib/services";

interface ServiceState {
  available: Record<ServiceId, boolean>;
  ready: boolean;
  refresh: () => Promise<void>;
}

/** Какие сервисы реально подключены — от этого зависит вид иконок и поиск. */
export const useServiceStore = create<ServiceState>((set) => ({
  available: { yandex: false, spotify: false, vk: false, soundcloud: false },
  ready: false,
  refresh: async () => {
    try {
      const available = await detectAvailability();
      set({ available, ready: true });
    } catch {
      set({ ready: true });
    }
  },
}));
