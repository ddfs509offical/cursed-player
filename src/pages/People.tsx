import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Search as SearchIcon,
  Users,
  X,
  Copy,
  EyeOff,
  Cloud,
  UserRound,
  RefreshCw,
  Lock,
} from "lucide-react";
import Avatar from "../components/Avatar";
import EmptyState from "../components/EmptyState";
import Modal, { GhostButton, PrimaryButton } from "../components/Modal";
import { sounds } from "../lib/sounds";
import { toast } from "../store/toastStore";
import { useSyncStore } from "../store/syncStore";
import { profileGet, profileSearch, cloudVisibility, type CloudProfile } from "../services/supabase";
import { seedFromString, themeCover } from "../lib/coverTone";

interface Props {
  /** Открыть настройки: там вход в аккаунт, без него поиск не работает. */
  onOpenSettings: () => void;
}

/**
 * «Люди»: поиск по юзернейму и чужие профили.
 *
 * Люди живут в публичной таблице `profiles` проекта: юзернейм, отображаемое
 * имя, аватар, баннер, описание и настройки приватности. Читать её может любой
 * вошедший — поэтому без аккаунта страница честно объясняет, что поиск
 * появится после входа, а музыка работает и так.
 *
 * Что именно показывать в чужом профиле, решает владелец: правила приватности
 * лежат в облачной строке (`privacy`), и интерфейс их уважает — скрытое не
 * рисуется вовсе, а не прячется за заглушкой.
 */
export default function People({ onOpenSettings }: Props) {
  const signedIn = useSyncStore((s) => s.status.signedIn);
  const configured = useSyncStore((s) => s.status.configured);
  const myId = useSyncStore((s) => s.status.userId);
  const myCloud = useSyncStore((s) => s.cloudProfile);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CloudProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [opened, setOpened] = useState<CloudProfile | null>(null);
  const [openedBusy, setOpenedBusy] = useState(false);

  /** Ответы приходят не по порядку: применяем только последний запрос. */
  const requestId = useRef(0);

  async function search(text: string) {
    const clean = text.trim();
    if (clean.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const rows = await profileSearch(clean);
      if (id !== requestId.current) return;
      setResults(rows);
      setSearched(true);
    } catch (e) {
      if (id !== requestId.current) return;
      setResults([]);
      setSearched(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  // Ищем сами, пока человек печатает: отдельная кнопка не нужна
  useEffect(() => {
    if (!signedIn) return;
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      setSearched(false);
      setError(null);
      return;
    }
    const timer = window.setTimeout(() => void search(text), 400);
    return () => window.clearTimeout(timer);
    // search намеренно не в зависимостях: он пересоздаётся каждый рендер
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, signedIn]);

  /** Открыть чужой профиль: тянем свежую строку, а не то, что осталось в списке. */
  async function open(person: CloudProfile) {
    sounds.open();
    setOpened(person);
    setOpenedBusy(true);
    try {
      const fresh = await profileGet(person.id);
      if (fresh) setOpened(fresh);
    } catch {
      // Показываем то, что уже есть в списке: данные не хуже
    } finally {
      setOpenedBusy(false);
    }
  }

  async function copyUsername(username: string) {
    try {
      await navigator.clipboard.writeText(`@${username}`);
      sounds.save();
      toast({ title: "Юзернейм скопирован", description: `@${username}` });
    } catch {
      sounds.error();
      toast({ title: "Не удалось скопировать", tone: "danger" });
    }
  }

  if (!signedIn) {
    return (
      <div className="max-w-3xl">
        <Header />
        <EmptyState
          Icon={configured ? Lock : Cloud}
          title={configured ? "Поиск людей — после входа" : "Поиск людей пока недоступен"}
          description={
            configured
              ? "Юзернеймы и профили лежат в облаке проекта, и читать их может только вошедший. Вход не обязателен, чтобы слушать музыку: он нужен лишь для поиска людей и переноса данных."
              : "Приложение не смогло связаться с проектом. Музыка работает и без этого — поиск людей вернётся, когда появится сеть."
          }
          action={<PrimaryButton onClick={onOpenSettings}>Открыть настройки аккаунта</PrimaryButton>}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <Header />

      <div className="flex items-center gap-2 h-11 px-3.5 rounded-xl bg-inset border border-line/[0.07] focus-within:border-accentText/50 transition-colors">
        <SearchIcon size={16} className="text-faint shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void search(query);
            if (event.key === "Escape") setQuery("");
          }}
          placeholder="Юзернейм или имя — например cursed или Cursed"
          spellCheck={false}
          autoComplete="off"
          className="bg-transparent flex-1 min-w-0 outline-none text-[13px] placeholder:text-faint"
        />
        {busy && <RefreshCw size={14} className="text-faint animate-spin shrink-0" />}
        {query && !busy && (
          <button
            onClick={() => {
              setQuery("");
              setResults([]);
              setSearched(false);
            }}
            aria-label="Очистить поиск"
            className="shrink-0 p-0.5 rounded text-faint hover:text-ink transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <p className="text-[12px] text-faint mt-2">
        Ищем по началу юзернейма и имени, до 20 человек. Люди, которые выключили поиск по себе,
        в результатах не показываются.
      </p>

      {error && (
        <p className="mt-3 text-[12px] text-amber-300/90 leading-relaxed">
          {error}
        </p>
      )}

      {!searched && !error && (
        <EmptyState
          Icon={Users}
          title="Найди друзей по юзернейму"
          description="Начни вводить @username — покажем всех, кто подходит. Открыть профиль можно кликом по строке."
        />
      )}

      {searched && results.length === 0 && !error && (
        <EmptyState
          Icon={UserRound}
          title="Никого не нашли"
          description={`По запросу «${query.trim()}» никого нет. Проверь написание юзернейма — он уникален на весь проект.`}
        />
      )}

      {results.length > 0 && (
        <div className="mt-4 rounded-xl border border-line/[0.07] bg-surface overflow-hidden">
          {results.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              isMe={person.id === myId}
              onOpen={() => void open(person)}
            />
          ))}
        </div>
      )}

      {/* Свой профиль в облаке: по нему тебя находят другие */}
      {myCloud && (
        <div className="mt-4 rounded-xl border border-line/[0.07] bg-surface px-4 py-3.5">
          <p className="text-[12px] font-semibold tracking-tight text-ink/80 mb-1">Как тебя видят другие</p>
          <div className="flex items-center gap-3">
            <Avatar
              profile={{ username: myCloud.username, displayName: myCloud.displayName ?? "", avatar: myCloud.avatar ?? null }}
              size={36}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] truncate">{myCloud.displayName ?? myCloud.username}</p>
              <p className="text-[12px] text-muted truncate">@{myCloud.username}</p>
            </div>
            <GhostButton onClick={() => void copyUsername(myCloud.username)} className="flex items-center gap-1.5">
              <Copy size={13} /> Скопировать
            </GhostButton>
          </div>
        </div>
      )}

      <AnimatePresence>
        {opened && (
          <PersonCard
            person={opened}
            busy={openedBusy}
            isMe={opened.id === myId}
            onClose={() => setOpened(null)}
            onCopy={() => void copyUsername(opened.username)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Header() {
  return (
    <div className="mb-4">
      <h1 className="text-[20px] font-semibold tracking-tight">Люди</h1>
      <p className="text-[12px] text-muted mt-0.5">
        Поиск по юзернейму и чужие профили: аватар, имя, описание — то, что владелец разрешил показать
      </p>
    </div>
  );
}

/** Строка результата: аватар, имя, @юзернейм и кнопка «Открыть профиль». */
function PersonRow({ person, isMe, onOpen }: { person: CloudProfile; isMe: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-4 py-3 text-left border-t border-line/[0.06] first:border-t-0 hover:bg-ink/[0.04] transition-colors group"
    >
      <Avatar
        profile={{ username: person.username, displayName: person.displayName ?? "", avatar: person.avatar ?? null }}
        size={38}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] truncate">
          {person.displayName || person.username}
          {isMe && <span className="ml-2 text-[11px] text-faint">это ты</span>}
        </span>
        <span className="block text-[12px] text-muted truncate">@{person.username}</span>
      </span>
      <span className="shrink-0 text-[12px] text-muted group-hover:text-ink">Открыть профиль</span>
    </button>
  );
}

/**
 * Чужой профиль целиком. Приватность владельца уважаем буквально: скрытое не
 * показываем и не намекаем, что оно есть.
 */
function PersonCard({
  person,
  busy,
  isMe,
  onClose,
  onCopy,
}: {
  person: CloudProfile;
  busy: boolean;
  isMe: boolean;
  onClose: () => void;
  onCopy: () => void;
}) {
  const visibility = cloudVisibility(person.privacy);
  const displayName = person.displayName || person.username;

  return (
    <Modal
      open
      onClose={onClose}
      title={displayName}
      description={`@${person.username}${isMe ? " · это твой профиль в облаке" : ""}`}
      footer={<PrimaryButton onClick={onClose}>Закрыть</PrimaryButton>}
    >
      <div className="space-y-4">
        <div className="relative h-28 rounded-xl overflow-hidden border border-line/[0.07]">
          {visibility.avatar && person.banner ? (
            <img src={person.banner} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full" style={{ background: themeCover(seedFromString(person.username)) }} />
          )}
          <div className="absolute inset-0 bg-black/30" />
        </div>

        <div className="flex items-center gap-3 -mt-10 px-2 relative">
          {visibility.avatar ? (
            <Avatar profile={{ username: person.username, displayName, avatar: person.avatar ?? null }} size={64} ring />
          ) : (
            <div className="rounded-full ring-4 ring-app bg-surface3 border border-line/[0.10] w-16 h-16 flex items-center justify-center text-faint">
              <EyeOff size={20} />
            </div>
          )}
          <div className="min-w-0 flex-1 pt-6">
            <p className="text-[15px] font-semibold truncate">{displayName}</p>
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] text-muted truncate">@{person.username}</span>
              <button
                onClick={onCopy}
                aria-label="Скопировать юзернейм"
                title="Скопировать @username"
                className="p-1 rounded-md text-faint hover:text-ink hover:bg-ink/[0.06] transition-colors"
              >
                <Copy size={12} />
              </button>
            </div>
          </div>
        </div>

        {visibility.avatar && !person.avatar && (
          <p className="text-[12px] text-faint">Фото профиля не задано — показываем градиент по юзернейму.</p>
        )}
        {!visibility.avatar && (
          <p className="text-[12px] text-faint flex items-center gap-1.5">
            <EyeOff size={12} /> Фото и обложку владелец скрыл.
          </p>
        )}

        {visibility.bio && person.bio ? (
          <p className="text-[13px] leading-relaxed text-ink/80">{person.bio}</p>
        ) : visibility.bio ? (
          <p className="text-[12px] text-faint">Описание не заполнено.</p>
        ) : (
          <p className="text-[12px] text-faint flex items-center gap-1.5">
            <EyeOff size={12} /> Описание владелец скрыл.
          </p>
        )}

        {/*
          Блоки статистики и «недавнего» рисует другой подрядчик. Здесь для них
          подготовлены данные и решение приватности: `visibility.stats` и
          `visibility.recent` — можно ли вообще это показывать.
        */}
        <div className="rounded-xl border border-line/[0.07] bg-inset px-4 py-3.5">
          <p className="text-[12px] font-semibold tracking-tight text-ink/80">Статистика</p>
          {visibility.stats || visibility.recent ? (
            <p className="text-[12px] text-muted mt-1.5 leading-relaxed">
              Владелец разрешил показывать статистику. Числа придут из публичного профиля: личные
              строки в облаке закрыты правилом RLS и чужому недоступны.
            </p>
          ) : (
            <p className="text-[12px] text-muted mt-1.5 leading-relaxed flex items-center gap-1.5">
              <EyeOff size={12} /> Владелец скрыл статистику и недавно прослушанное.
            </p>
          )}
        </div>

        {busy && <p className="text-[11px] text-faint">Обновляю данные профиля…</p>}
        {person.updatedAt && (
          <p className="text-[11px] text-faint">
            Профиль обновлён {new Date(person.updatedAt).toLocaleString("ru-RU")}
          </p>
        )}
      </div>
    </Modal>
  );
}
