/**
 * Обход блокировок (zapret): состояние, разбор отчётов тестов и живая проверка.
 * Приложение ничего не запускает и не останавливает, пока работает служба
 * пользователя — иначе две копии winws начали бы мешать друг другу.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./profiles";

export interface PresetScore {
  preset: string;
  ok: number;
  total: number;
}

export interface ZapretStatus {
  folder: string;
  found: boolean;
  binaryFound: boolean;
  presets: string[];
  serviceState: string;
  winwsRunning: boolean;
  reportPath: string | null;
  reportBest: PresetScore | null;
  reportScores: PresetScore[];
  /** Пресет, с которым установлена служба. */
  currentPreset: string | null;
  note: string;
}

export interface ProbeResult {
  host: string;
  ok: boolean;
  detail: string;
}

const EMPTY: ZapretStatus = {
  folder: "",
  found: false,
  binaryFound: false,
  presets: [],
  serviceState: "неизвестно",
  winwsRunning: false,
  reportPath: null,
  reportBest: null,
  reportScores: [],
  currentPreset: null,
  note: "",
};

export async function zapretStatus(): Promise<ZapretStatus> {
  if (!isTauri()) return EMPTY;
  return invoke<ZapretStatus>("zapret_status");
}

/** Применяет пресет через их же .bat: Windows спросит права администратора. */
export async function zapretApply(preset: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("zapret_apply", { preset });
}

/** Подбор: приложение перебирает пресеты своим winws и проверяет SoundCloud API. */
export async function zapretAutotest(limit = 8): Promise<number> {
  if (!isTauri()) return 0;
  return invoke<number>("zapret_autotest", { limit });
}

export interface AutotestRow {
  preset: string;
  ok: boolean;
  detail: string;
}

export async function zapretAutotestResults(): Promise<AutotestRow[]> {
  if (!isTauri()) return [];
  const rows = await invoke<[string, boolean, string][]>("zapret_autotest_results");
  return rows.map(([preset, ok, detail]) => ({ preset, ok, detail }));
}

/** Запустить конкретный пресет из своей копии zapret (администратор). */
export async function zapretStartOwn(preset: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("zapret_start_own", { preset });
}

/** Остановить обход, запущенный приложением. */
export async function zapretStopOwn(): Promise<void> {
  if (!isTauri()) return;
  await invoke("zapret_stop_own");
}

export async function zapretProbe(hosts: string[] = []): Promise<ProbeResult[]> {
  if (!isTauri()) return [];
  return invoke<ProbeResult[]>("zapret_probe", { hosts });
}
