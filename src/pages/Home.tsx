import { useState } from "react";
import { motion } from "framer-motion";
import {
  Headphones,
  Disc3,
  Clock,
  Heart,
  Plus,
  UserRound,
  Palette,
  FolderOpen,
  ChevronRight,
  Play,
} from "lucide-react";
import StatCard from "../components/StatCard";
import Cover from "../components/Cover";
import CountUp from "../components/CountUp";
import ChartsSection from "../components/ChartsSection";
import { useHistoryStore, historyStats } from "../store/historyStore";
import { usePlayerStore, markFreshStream } from "../store/playerStore";
import { findOfflineCopy } from "../store/offlineStore";
import { offlineFailureMessage } from "../lib/offline";
import { formatDuration, refreshServiceStream } from "../services/catalog";
import { toast } from "../store/toastStore";
import { errorText, logError } from "../store/errorStore";
import { sounds } from "../lib/sounds";
import Modal, { GhostButton, PrimaryButton } from "../components/Modal";
import EmptyState from "../components/EmptyState";
import { useFavoritesStore } from "../store/favoritesStore";
import type { Profile } from "../services/profiles";

interface Props {
  profile: Profile;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

export default function Home({ profile, onOpenProfile, onOpenSettings }: Props) {
  const [importNote, setImportNote] = useState(false);
  const stats = profile.stats;
  const favorites = useFavoritesStore((s) => s.ids.length);

  const history = useHistoryStore((s) => s.entries);
  const clearHistory = useHistoryStore((s) => s.clear);
  const historyNumbers = historyStats(history);
  const recent = history.slice(0, 6);

  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playerPosition = usePlayerStore((s) => s.position);
  const currentTrack = index >= 0 ? queue[index] : undefined;

  /**
   * Возвращаемся к треку из истории: локальные играем, сервисные — по ссылке.
   * Ссылка на поток у сервиса живёт недолго, поэтому перед включением берём
   * свежую. Если трек сохранён офлайн, ссылка не нужна вовсе.
   */
  async function playFromHistory(id: string) {
    const entry = history.find((item) => item.id === id);
    if (!entry) return;
    const saved = queue.find((item) => item.id === id) ?? {
      id: entry.id,
      path: entry.path,
      title: entry.title,
      artist: entry.artist,
      album: null,
      durationMs: 0,
      source: entry.source,
      cover: entry.cover,
    };
    try {
      const copy = await findOfflineCopy(saved.id);
      usePlayerStore.getState().playNow(copy ?? (await refreshServiceStream(saved)));
    } catch (e) {
      // Копии нет и сеть не ответила — объясняем это, а не отказ сервиса
      const message = offlineFailureMessage(e, false);
      sounds.error();
      logError("Не удалось включить трек из истории", `${saved.title}: ${message}`, "главная", errorText(e));
      toast({ title: "Не удалось включить трек", description: message, tone: "danger" });
    }
  }

  /**
   * «Продолжить»: включаем текущий трек с места, где остановились. У сервисного
   * трека ссылка к этому моменту уже истекла — обновляем её и перезапускаем
   * воспроизведение через jumpTo (togglePlay здесь нажал бы паузу).
   * Сохранённая офлайн-копия играет с диска: сеть не нужна.
   */
  async function resumeFromHistory() {
    const state = usePlayerStore.getState();
    const track = state.index >= 0 ? state.queue[state.index] : undefined;
    if (!track) return;
    try {
      const copy = track.source === "service" ? await findOfflineCopy(track.id) : null;
      if (track.source === "service" && !copy) {
        const fresh = await refreshServiceStream(track);
        // Ссылка уже добыта: помечаем свежей, чтобы плеер не спросил её второй раз
        markFreshStream(fresh);
        usePlayerStore.setState({
          queue: usePlayerStore.getState().queue.map((item, i) => (i === state.index ? fresh : item)),
        });
      }
      // jumpTo включает трек и возвращает сохранённую позицию
      usePlayerStore.getState().jumpTo(state.index);
    } catch (e) {
      const message = offlineFailureMessage(e, false);
      sounds.error();
      logError("Не удалось продолжить трек", `${track.title}: ${message}`, "главная", errorText(e));
      toast({ title: "Не удалось продолжить трек", description: message, tone: "danger" });
    }
  }

  return (
    <div className="space-y-[var(--gap-section)]">
      {/* Шапка: название раздела мелкой меткой, приветствие крупным кеглем и
          одна строка-сводка. Дата создания профиля отсюда убрана — она нужна
          раз в год, а место занимала каждый запуск. */}
      <header className="flex items-end justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <h1 className="title-page">
            {greeting()}, {profile.displayName}
          </h1>
          <p className="text-[13px] text-muted mt-2">
            {stats.hours.toFixed(1)} ч музыки · {stats.tracks} треков · {favorites} в избранном
            {stats.topArtist ? ` · чаще всех — ${stats.topArtist}` : ""}
          </p>
        </div>
        <PrimaryButton onClick={() => setImportNote(true)} className="flex items-center gap-1.5">
          <Plus size={15} /> Добавить музыку
        </PrimaryButton>
      </header>

      {/* Статистика: четыре отдельные плитки с воздухом вместо одной полосы с
          разделителями. На широком окне это дашборд, на узком — две колонки. */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { Icon: Headphones, value: String(stats.tracks), label: "Треков прослушано" },
          { Icon: Clock, value: `${stats.hours.toFixed(1)} ч`, label: "Время в музыке" },
          { Icon: Disc3, value: stats.topArtist ?? "—", label: "Любимый исполнитель" },
          { Icon: Heart, value: String(favorites), label: "В избранном" },
        ].map((item) => (
          <div key={item.label} className="ui-tile hairline bg-surface p-4">
            <StatCard Icon={item.Icon} value={item.value} label={item.label} />
          </div>
        ))}
      </section>

      {/* Продолжить слушать: последний трек и позиция, где остановились */}
      {currentTrack && playerPosition > 3 && (
        <motion.section
          initial={{ y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
        >
          <SectionHeader title="Продолжить слушать" />
          <div className="rounded-xl border border-line/[0.07] bg-surface p-3 flex items-center gap-3">
            <Cover src={currentTrack.cover} size={56} rounded="rounded-lg" hoverIcon />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium truncate">{currentTrack.title}</p>
              <p className="text-[12px] text-muted truncate">
                {currentTrack.artist ?? "Неизвестный исполнитель"} · остановились на{" "}
                {formatDuration(playerPosition * 1000)}
              </p>
            </div>
            <button
              onClick={() => {
                sounds.save();
                void resumeFromHistory();
              }}
              className="h-9 px-4 rounded-lg bg-accent text-onAccent text-[13px] font-medium hover:bg-accentHover transition-colors flex items-center gap-1.5 shrink-0"
            >
              <Play size={14} fill="currentColor" /> Продолжить
            </button>
          </div>
        </motion.section>
      )}

      {/* Недавно слушали: локальная история, без сети */}
      {recent.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold tracking-tight">Недавно слушали</h2>
            <button
              onClick={() => {
                clearHistory();
                sounds.off();
                toast({ title: "История очищена" });
              }}
              className="text-[12px] text-faint hover:text-ink transition-colors"
            >
              Очистить
            </button>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {recent.map((entry, index) => (
              <motion.button
                key={entry.id}
                initial={{ y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, delay: index * 0.04, ease: [0.2, 0, 0, 1] }}
                onClick={() => void playFromHistory(entry.id)}
                className="flex items-center gap-3 p-2.5 rounded-xl border border-line/[0.07] bg-surface hover:border-line/20 hover:bg-surface2 transition-colors text-left group"
              >
                <Cover src={entry.cover} size={40} rounded="rounded-md" hoverIcon />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] truncate">{entry.title}</span>
                  <span className="block text-[12px] text-muted truncate">
                    {entry.artist ?? "Неизвестный исполнитель"} · {entry.plays}×
                  </span>
                </span>
              </motion.button>
            ))}
          </div>
        </section>
      )}

      {/* История в цифрах: анимированные счётчики */}
      <section className="grid grid-cols-3 gap-2">
        {[
          { label: "Включений", value: historyNumbers.plays, suffix: "" },
          { label: "Треков в истории", value: historyNumbers.unique, suffix: "" },
          { label: "Частый исполнитель", value: 0, suffix: "", text: historyNumbers.topArtist ?? "—" },
        ].map((item, index) => (
          <motion.div
            key={item.label}
            initial={{ y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, delay: 0.05 * index }}
            className="rounded-xl border border-line/[0.07] bg-surface px-4 py-3"
          >
            <p className="text-[18px] font-semibold tnum">
              {item.text ?? <CountUp value={item.value} />}
            </p>
            <p className="text-[11px] text-faint uppercase tracking-[0.08em] mt-0.5">{item.label}</p>
          </motion.div>
        ))}
      </section>

      {/* Тренды SoundCloud: рекомендации сервиса прямо на главной */}
      <ChartsSection />

      <section>
        <SectionHeader title="Продолжить слушать" />
        <EmptyState
          Icon={Headphones}
          title="История пока пуста"
          description="Здесь появятся треки, которые ты слушал. Как только добавим импорт локальных файлов — включим и историю."
          action={<GhostButton onClick={() => setImportNote(true)}>Как добавить музыку</GhostButton>}
        />
      </section>

      <section>
        <SectionHeader title="С чего начать" />
        <div className="rounded-xl border border-line/[0.07] bg-surface divide-y divide-line/[0.06]">
          <StartRow
            Icon={UserRound}
            title="Заполни профиль"
            hint="Имя, аватар, баннер, жанры и ссылки"
            done={Boolean(profile.bio || profile.avatar || profile.banner)}
            onClick={onOpenProfile}
          />
          <StartRow
            Icon={Palette}
            title="Настрой внешний вид"
            hint="Пресет, акцентный цвет и плотность интерфейса"
            done={false}
            onClick={onOpenSettings}
          />
          <StartRow
            Icon={FolderOpen}
            title="Добавь локальную музыку"
            hint="Импорт папки с треками — следующий шаг"
            done={false}
            soon
            onClick={() => setImportNote(true)}
          />
        </div>
      </section>

      <Modal
        open={importNote}
        onClose={() => setImportNote(false)}
        title="Импорт музыки — следующий шаг"
        description="Сейчас приложение готовит профили, внешний вид и локальное хранилище. Библиотека, воспроизведение файлов, плейлисты и статистика — следующий этап работы."
        footer={<PrimaryButton onClick={() => setImportNote(false)}>Понятно</PrimaryButton>}
      >
        <ul className="text-[13px] text-muted space-y-2">
          {[
            "Импорт папки: сканирование файлов и чтение тегов",
            "Плейлисты: создание, добавление и удаление треков",
            "Живая статистика прослушиваний вместо нулей",
          ].map((line) => (
            <li key={line} className="flex items-start gap-2">
              <span className="mt-1.5 w-1 h-1 rounded-full bg-accentText shrink-0" />
              {line}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-[12px] text-muted mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function StartRow({
  Icon,
  title,
  hint,
  done,
  soon,
  onClick,
}: {
  Icon: typeof UserRound;
  title: string;
  hint: string;
  done: boolean;
  soon?: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      whileHover={{ x: 2 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-ink/[0.03] transition-colors first:rounded-t-xl last:rounded-b-xl"
    >
      <span
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
          done ? "bg-emerald-500/15 text-emerald-400" : "bg-ink/[0.06] text-muted"
        }`}
      >
        <Icon size={15} strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium truncate">{title}</span>
        <span className="block text-[12px] text-muted truncate">{hint}</span>
      </span>
      {soon && (
        <span className="text-[10px] uppercase tracking-wide text-faint border border-line/[0.12] rounded px-1.5 py-0.5 shrink-0">
          скоро
        </span>
      )}
      <ChevronRight size={15} className="text-faint shrink-0" />
    </motion.button>
  );
}
