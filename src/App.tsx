import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Home as HomeIcon, Search as SearchIcon, Disc3, ListMusic, Star, Radio, ArrowLeft, Users, FlaskConical } from "lucide-react";
import TitleBar from "./components/TitleBar";
import ResizeHandles from "./components/ResizeHandles";
import Toaster from "./components/Toaster";
import Splash from "./components/Splash";
import Modal from "./components/Modal";
import AudioEngine from "./components/AudioEngine";
import QueuePanel from "./components/QueuePanel";
import { GhostButton } from "./components/Modal";
import { hideToTray } from "./services/player";
import Sidebar, { type NavItem } from "./components/Sidebar";
import MiniPlayer from "./components/MiniPlayer";
import NowPlaying from "./components/NowPlaying";
import ArtistWindow from "./components/ArtistWindow";
import EasterEgg from "./components/EasterEgg";
import TopBar from "./components/TopBar";
import NavBar from "./components/NavBar";
import ErrorBoundary from "./components/ErrorBoundary";
import type { SectionId } from "./pages/Settings";
import EmptyState from "./components/EmptyState";
import Home from "./pages/Home";
import Search from "./pages/Search";
import Playlists from "./pages/Playlists";
import Library from "./pages/Library";
import Settings from "./pages/Settings";
import AdminPanel from "./pages/Admin";
import ProfilePage from "./pages/Profile";
import People from "./pages/People";
import Welcome from "./pages/Welcome";
import TestPage from "./pages/Test";
import { SPLASH_DURATION_MS } from "./lib/app";
import { sounds } from "./lib/sounds";
import { toast } from "./store/toastStore";
import { checkUpdate, installUpdate, markCheckedNow, shouldCheckNow } from "./services/updates";
import { useServiceStore } from "./store/serviceStore";
import { useSettingsStore } from "./store/settingsStore";
import ContextMenu from "./components/ContextMenu";
import MobileShell from "./mobile/MobileShell";
import ObsidianHome from "./pages/ObsidianHome";
import ObsidianShell from "./components/AppShell";
import ObsidianNav from "./components/ObsidianNav";
import ObsidianSearch from "./components/ObsidianSearch";
import ObsidianToolbar from "./components/ObsidianToolbar";
import ObsidianSettingsWindow from "./components/ObsidianSettingsWindow";
import ObsidianTransport from "./components/ObsidianTransport";
import { useIsMobile } from "./mobile/shared";
import { invoke } from "@tauri-apps/api/core";
import { useFavoritesStore } from "./store/favoritesStore";
import { applyWindowIcon } from "./lib/appIcon";
import { usePlayerStore, resetPlayback } from "./store/playerStore";
import { useOfflineStore } from "./store/offlineStore";
import { playerAudio } from "./player/audio";
import { discordClear } from "./services/integrations";
import { useActiveProfile, useProfileStore } from "./store/profileStore";
import { useSyncStore } from "./store/syncStore";
import { useDiscordPresence } from "./hooks/useDiscordPresence";
import { networkConfigure } from "./services/network";
import AppWallpaper from "./components/AppWallpaper";

type PageId =
  | "home"
  | "search"
  | "library"
  | "playlists"
  | "test"
  | "subscriptions"
  | "people"
  | "settings"
  | "profile";

/**
 * Пункты меню и их страницы — одной таблицей: раньше это были два массива, и
 * порядок в них разошёлся («Люди» и «Тест» стояли по-разному), из-за чего
 * фильтр по роли прятал не тот пункт.
 *
 * `ownerOnly` — раздел, который нужен только владельцу проекта: «Тест» и
 * связанные с ним инструменты. Роль приходит с сервера (`is_owner`).
 */
const NAV_ALL: { item: NavItem; page: PageId; ownerOnly?: boolean }[] = [
  { item: { Icon: HomeIcon, label: "Главная" }, page: "home" },
  { item: { Icon: SearchIcon, label: "Поиск" }, page: "search" },
  { item: { Icon: Disc3, label: "Моя музыка" }, page: "library" },
  { item: { Icon: ListMusic, label: "Плейлисты" }, page: "playlists" },
  { item: { Icon: Users, label: "Люди" }, page: "people" },
  { item: { Icon: Star, label: "Подписки" }, page: "subscriptions" },
  { item: { Icon: FlaskConical, label: "Тест" }, page: "test", ownerOnly: true },
];

export default function App() {
  /** Номер поколения интерфейса: «Перезапустить раздел» пересобирает каркас. */
  const [generation, setGeneration] = useState(0);

  return (
    <div className="h-screen bg-app text-ink overflow-hidden">
      <ErrorBoundary
        key={generation}
        title="Сбой интерфейса"
        onRestartSection={() => setGeneration((value) => value + 1)}
      >
        <AppShell />
      </ErrorBoundary>
    </div>
  );
}

/**
 * Новый слой оформления «Обсидиан». Выключается одной строкой: старая
 * оболочка остаётся в коде целиком, поэтому откат ничего не ломает.
 */
const OBS = true;

/**
 * Разделы настроек для окна «Обсидиан». Подписи совпадают с прежними,
 * поэтому привычка не меняется: только переезд в окно.
 */
const OBSIDIAN_SETTINGS_TABS = [
  { id: "account", label: "Аккаунт", hint: "Профиль и приватность" },
  { id: "appearance", label: "Интерфейс", hint: "Темы, акцент, масштаб" },
  { id: "player", label: "Плеер", hint: "Звук и офлайн" },
  { id: "services", label: "Сервисы", hint: "SoundCloud, Discord" },
  { id: "system", label: "Система", hint: "Окно, уведомления" },
  { id: "about", label: "О приложении", hint: "Версия и журнал" },
] as const;

function AppShell() {
  const ready = useProfileStore((s) => s.ready);
  /** Узкое окно — мобильная оболочка вместо настольной. */
  const mobile = useIsMobile();
  const load = useProfileStore((s) => s.load);
  const active = useActiveProfile();
  const hasStarted = usePlayerStore((s) => s.hasStarted);

  const [page, setPage] = useState<PageId>("home");
  const [creating, setCreating] = useState(false);
  const [splashStatus, setSplashStatus] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [dontAskClose, setDontAskClose] = useState(false);
  const [query, setQuery] = useState("");
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  /** Раздел настроек, который надо открыть сразу (из уведомлений — «Ошибки»). */
  const [settingsSection, setSettingsSection] = useState<SectionId | null>(null);

  /** Единственный вход в настройки: без раздела — открывается профиль. */
  function openSettings(section: SectionId | null = null) {
    setSettingsSection(section);
    setPage("settings");
  }

  /**
   * Роль аккаунта. «Тест» и разделы разработчика видит только владелец: сервер
   * всё равно не отдаст ему чужие данные (`admin_*` проверяют is_owner), но и в
   * интерфейсе не должно быть кнопок, которые обычному человеку не нужны.
   */
  const role = useSyncStore((s) => s.role);
  const isOwner = role === "owner";
  const [adminOpen, setAdminOpen] = useState(false);

  /** Пункты меню без владельческих разделов — у всех, кроме владельца. */
  const nav = useMemo(() => {
    const visible = NAV_ALL.filter((entry) => isOwner || !entry.ownerOnly);
    return { items: visible.map((entry) => entry.item), pages: visible.map((entry) => entry.page) };
  }, [isOwner]);

  // Владельцем быть перестали (выход, другой аккаунт) — уводим с «Теста».
  useEffect(() => {
    if (!isOwner && page === "test") setPage("home");
  }, [isOwner, page]);

  useEffect(() => {
    void load();
    void useServiceStore.getState().refresh();
    /**
     * Офлайн-список читаем при старте и один раз: он приходит из реестра без
     * разбора тегов, а подробности метаданных догружаются в фоне. Плеер его
     * больше не ждёт — первый трек не должен зависеть от чтения диска.
     */
    void useOfflineStore
      .getState()
      .refresh()
      .catch(() => {
        // Ошибку уже записал сам store: запуск приложения она не ломает
      });
  }, [load]);

  // Своя иконка приложения: держим её же в панели задач Windows
  const customAppIcon = useSettingsStore((s) => s.customAppIcon);

  /**
   * Автообновление: не чаще раза в 6 часов тихо спрашиваем `latest.json` из
   * бакета `updates`. Нашлась новая сборка — уведомление с кнопкой «Обновить»:
   * скачиваем установщик и открываем его. Ничего не ставится без нажатия.
   */
  useEffect(() => {
    if (!ready || !shouldCheckNow()) return;
    let cancelled = false;
    void (async () => {
      markCheckedNow();
      const info = await checkUpdate();
      if (cancelled || !info) return;
      toast({
        title: `Доступно обновление · сборка ${info.version}`,
        description: "Скачать установщик и обновиться?",
        action: {
          label: "Обновить",
          run: () => {
            void installUpdate(info).catch((error) => {
              toast({
                title: "Не удалось скачать обновление",
                description: error instanceof Error ? error.message : String(error),
              });
            });
          },
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);  useEffect(() => {
    void applyWindowIcon(customAppIcon);
  }, [customAppIcon]);
  /**
   * Островок поверх игры: он живёт в отдельном окне, поэтому трек уходит
   * туда командой, а не событием. Шлём при изменении названия, исполнителя,
   * обложки, длительности и паузы.
   */
  const islandTitle = usePlayerStore((s) => s.trackTitle);
  const islandArtist = usePlayerStore((s) => s.trackArtist);
  const islandPlaying = usePlayerStore((s) => s.isPlaying);
  // Развёрнутый островок показывает обложку и длительность текущего трека
  const islandCover = usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index]?.cover ?? "" : ""));
  const islandDuration = usePlayerStore((s) => s.durationMs);

  useEffect(() => {
    void invoke("island_update", {
      track: {
        title: islandTitle,
        artist: islandArtist,
        playing: islandPlaying,
        cover: islandCover,
        // u64 в Rust: дробные миллисекунды ломали разбор, и островок молчал
        durationMs: Math.round(islandDuration || 0),
      },
    });
  }, [islandTitle, islandArtist, islandPlaying, islandCover, islandDuration]);


  /**
   * Кнопки в островке не могут управлять плеером напрямую: это другое окно.
   * Островок кладёт действие в Rust, а мы забираем его и выполняем — так
   * переключение работает без событий между окнами.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      void invoke<string | null>("island_take_action")
        .then((action) => {
          if (!action) return;
          const player = usePlayerStore.getState();
          if (action === "next") player.next();
          else if (action === "prev") player.previous();
          else if (action === "toggle") player.togglePlay();
        })
        .catch(() => {});
    }, 500);
    return () => window.clearInterval(timer);
  }, []);
  // Настройки островка: Rust держит окно и решает, когда его показывать,
  // поэтому при каждом изменении отдаём ему всю тройку целиком.
  const islandEnabled = useSettingsStore((s) => s.islandEnabled);
  const islandAlways = useSettingsStore((s) => s.islandAlways);
  const islandAlwaysOnTop = useSettingsStore((s) => s.islandAlwaysOnTop);

  useEffect(() => {
    void invoke("island_config", {
      config: { enabled: islandEnabled, always: islandAlways, alwaysOnTop: islandAlwaysOnTop },
    }).catch(() => {});
  }, [islandEnabled, islandAlways, islandAlwaysOnTop]);
  // Прозрачность: два множителя живут в CSS-переменных, поэтому их смена
  // не перерисовывает дерево — просто меняется один атрибут стиля на <html>.
  const panelAlpha = useSettingsStore((s) => s.panelAlpha);
  const windowAlpha = useSettingsStore((s) => s.windowAlpha);

  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--panel-alpha", String(panelAlpha));
    style.setProperty("--window-alpha", String(windowAlpha));
  }, [panelAlpha, windowAlpha]);

  /**
   * Маршрут сети живёт в Rust: сетевой слой — общий для поиска, потока,
   * обложек и синхронизации. Передаём его при старте и при каждом изменении,
   * а ошибку адреса прокси показываем один раз, не мешая работе приложения.
   */
  const networkRoute = useSettingsStore((s) => s.networkRoute);
  const proxyUrl = useSettingsStore((s) => s.proxyUrl);
  useEffect(() => {
    void networkConfigure(networkRoute, proxyUrl).catch((e) => {
      toast({
        title: "Адрес прокси не принят",
        description: e instanceof Error ? e.message : String(e),
      });
    });
  }, [networkRoute, proxyUrl]);

  // Discord показывает текущий трек, если интеграция включена в настройках
  useDiscordPresence();

  /**
   * Настройки: «Готово» меняет раздел, а сам экран уезжает анимацией выхода.
   * Снимается экран по таймеру, а не только по концу анимации: если кадры
   * анимации не придут (окно свернули), экран остался бы в DOM невидимым, но
   * поверх интерфейса — и приложение выглядело бы замершим: клики уходили бы
   * в него. Плюс на время ухода экран не ловит клики вовсе.
   */
  const [settingsClosing, setSettingsClosing] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const settingsExitTimer = useRef<number | null>(null);

  function leaveSettings() {
    sounds.close();
    setPage("home");
  }

  useEffect(() => {
    const clearExitTimer = () => {
      if (settingsExitTimer.current !== null) {
        window.clearTimeout(settingsExitTimer.current);
        settingsExitTimer.current = null;
      }
    };

    if (page === "settings") {
      clearExitTimer();
      setSettingsClosing(false);
      setSettingsMounted(true);
      return;
    }

    // Раздел уже не настройки: гасим экран даже без кадров анимации — выход
    // из настроек не должен оставлять невидимый слой поверх интерфейса
    clearExitTimer();
    setSettingsClosing(true);
    // Запрос раздела от уведомлений — на один вход: следующий раз настройки
    // открываются с начала, а не с чужого раздела
    setSettingsSection(null);
    settingsExitTimer.current = window.setTimeout(() => {
      settingsExitTimer.current = null;
      setSettingsMounted(false);
      setSettingsClosing(false);
    }, 400);
  }, [page]);

  useEffect(
    () => () => {
      if (settingsExitTimer.current !== null) window.clearTimeout(settingsExitTimer.current);
    },
    []
  );

  // Esc закрывает настройки — понятный выход из полноэкранного раздела
  useEffect(() => {
    if (page !== "settings") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") leaveSettings();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [page]);

  // Лайки привязаны к профилю: при переключении читаем его список
  const favoritesProfileId = active?.id ?? null;
  useEffect(() => {
    useFavoritesStore.getState().load(favoritesProfileId);
  }, [favoritesProfileId]);

  /**
   * Синхронизация запускается после загрузки профилей: она читает состояние
   * аккаунта и сама решает, есть ли что переносить. Без настроенного проекта и
   * без входа она не делает ни одного сетевого вызова.
   */
  useEffect(() => {
    if (!ready) return;
    void useSyncStore.getState().init();
  }, [ready]);

  // Выход из профиля и смена аккаунта: глушим музыку, чистим очередь и статус
  // Discord — трек не должен «переезжать» в чужой профиль вместе с историей
  const lastProfileId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Ждём загрузки профилей: первый найденный профиль — это не смена аккаунта
    if (!ready) return;
    if (lastProfileId.current === undefined) {
      lastProfileId.current = favoritesProfileId;
      return;
    }
    if (lastProfileId.current === favoritesProfileId) return;
    lastProfileId.current = favoritesProfileId;

    playerAudio?.pause();
    resetPlayback();
    void discordClear();

    // Синхронизация привязана к профилю: переключаем область меток и, если
    // вход в аккаунт выполнен, сразу переносим данные. Без аккаунта — молчание.
    useSyncStore.getState().setProfile(favoritesProfileId);
    void useSyncStore.getState().syncNow();
  }, [ready, favoritesProfileId]);

  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const setCloseBehavior = useSettingsStore((s) => s.setCloseBehavior);
  /** Навигация: стеклянная панель сверху (по умолчанию) или боковое меню. */
  const sideNav = useSettingsStore((s) => s.navLayout === "side");

  /** Крестик: по настройке спрашиваем, сворачиваем в трей или закрываем. */
  function requestClose(choice?: "tray" | "quit") {
    const behavior = choice ?? closeBehavior;
    if (behavior === "ask") {
      setClosePrompt(true);
      return;
    }
    void finishClose(behavior);
  }

  async function finishClose(behavior: "tray" | "quit") {
    if (dontAskClose) setCloseBehavior(behavior);
    setClosePrompt(false);
    if (behavior === "tray") {
      await hideToTray();
      toast({ title: "Свернулось в трей", description: "Музыка продолжает играть" });
    } else {
      await invoke("window_close").catch(() => {});
    }
  }

  if (!ready) return <Splash status="Загружаем профили…" />;

  // Заставка после входа или создания профиля: показывается поверх всего,
  // пока не истечёт время, и только потом открывается интерфейс.
  if (splashStatus) {
    return (
      <>
        <Splash status={splashStatus} />
        <Toaster />
        <ResizeHandles />
      </>
    );
  }

  if (!active || creating) {
    return (
      <>
        <Welcome
          mode={active ? "add" : "first"}
          onDone={(status) => {
            setCreating(false);
            setSplashStatus(status);
            window.setTimeout(() => setSplashStatus(null), SPLASH_DURATION_MS);
          }}
          onBack={active ? () => setCreating(false) : undefined}
        />
        <Toaster />
        <ResizeHandles />
      </>
    );
  }

  /**
   * Телефон: свои экраны и нижняя навигация. Данные и плеер общие с
   * настольной версией, поэтому переключение ничего не теряет.
   */
  if (mobile && active) {
    return (
      <>
        <MobileShell onSettings={() => openSettings()} />
        <Toaster />
      </>
    );
  }

  const selectedIndex = nav.pages.indexOf(page);

  function content() {
    switch (page) {
      case "home":
        // «Обсидиан»: герой во всю ширину и ленты вместо дашборда.
        if (OBS) {
          return (
            <ObsidianHome
              profile={active!}
              onOpenProfile={() => setPage("profile")}
              onOpenSettings={() => openSettings()}
              onOpenLibrary={() => setPage("library")}
              onOpenPlaylists={() => setPage("playlists")}
              onAddMusic={() => setPage("library")}
            />
          );
        }
        return (
          <Home
            profile={active!}
            onOpenProfile={() => setPage("profile")}
            onOpenSettings={() => openSettings()}
          />
        );
      case "search":
        return <Search initialQuery={query} onOpenSettings={() => openSettings()} />;
      case "playlists":
        return <Playlists />;
      case "test":
        return <TestPage />;
      case "people":
        return <People onOpenSettings={() => openSettings()} />;
      case "settings":
        // Настройки рисуются отдельным экраном поверх интерфейса (см. ниже)
        return null;
      case "profile":
        return <ProfilePage profile={active!} onOpenPeople={() => setPage("people")} />;
      case "library":
        return <Library onOpenSearch={() => setPage("search")} />;
      case "subscriptions":
        return (
          <EmptyState
            Icon={Radio}
            title="Подписок пока нет"
            description="Подписки на исполнителей и релизы появятся вместе с подключением музыкальных сервисов."
          />
        );
    }
  }

  /**
   * Оболочка «Обсидиан»: панель навигации, рабочая поверхность, транспорт.
   * Разделы и их логика те же — меняется каркас и материал.
   */
  if (OBS) {
    return (
      <>
        <ContextMenu onOpenSettings={() => openSettings()} />
        <AppWallpaper />

        <ObsidianShell
          titlebar=<TitleBar onClose={() => requestClose()} />
          nav={
            <ObsidianNav
              items={nav.items}
              selected={selectedIndex}
              onSelect={(index) => setPage(nav.pages[index])}
              settingsActive={page === "settings"}
              onSettingsSelect={() => openSettings()}
              profile={active}
              profileActive={page === "profile"}
              onProfileSelect={() => setPage("profile")}
              compact={false}
            />
          }
          header={
            <div className="obs-header-bar">
              <ObsidianSearch
                hidden={page === "search"}
                onSubmit={(value) => {
                  setQuery(value);
                  setPage("search");
                }}
              />
              <span className="obs-header-bar__spacer" />
              <div className="obs-header-bar__actions">
                <ObsidianToolbar
                  profile={active}
                  onOpenProfile={() => setPage("profile")}
                  onOpenSettings={() => openSettings()}
                  onAddAccount={() => setCreating(true)}
                  onOpenErrors={() => openSettings("errors")}
                />
              </div>
            </div>
          }
          transport={
            hasStarted && !nowPlayingOpen ? (
              <ObsidianTransport
                onExpand={() => {
                  setQueueOpen(false);
                  setNowPlayingOpen(true);
                }}
                onQueue={() => setQueueOpen(true)}
              />
            ) : null
          }
          overlays={
            <>
              <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
              <NowPlaying
                open={nowPlayingOpen}
                onClose={() => {
                  setNowPlayingOpen(false);
                  setQueueOpen(false);
                }}
              />
              {/* Настройки — отдельным окном поверх музыки: интерфейс
                  остаётся виден, и изменения видно сразу. */}
              {/* Монтируем только пока окно открыто: закрытый экран настроек
                  не должен оставаться слоем поверх транспорта и ловить клики. */}
              {settingsMounted && page === "settings" && (
                <ObsidianSettingsWindow
                  open={page === "settings"}
                  onClose={leaveSettings}
                  requested={settingsSection}
                  // У самого экрана настроек есть свои вкладки: окно
                  // остаётся рамкой и не дублирует навигацию.
                  tabs={[{
                    id: "settings",
                    label: "Настройки",
                    content: (
                      <Settings
                        profile={active}
                        onOpenProfile={() => setPage("profile")}
                        requestedSection={settingsSection}
                        onOpenAdmin={() => setAdminOpen(true)}
                      />
                    ),
                  }]}
                />
              )}
              {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
            </>
          }
        >
          <ErrorBoundary
            resetKey={page}
            title="Сбой раздела"
            onRestartSection={() => setPage("home")}
          >
            {content()}
          </ErrorBoundary>
        </ObsidianShell>
      </>
    );
  }
  return (
    <div className="h-screen bg-app text-ink overflow-hidden flex flex-col relative isolate">
      {/* Своё меню по правой кнопке вместо меню браузера от WebView2 */}
      <ContextMenu onOpenSettings={() => openSettings()} />
      {/* Обои — самый нижний слой оболочки: одна картинка на всё приложение
          (главная, библиотека, настройки). Затемнение берётся из настроек. */}
      <AppWallpaper />

      <div className="relative z-10 flex-1 flex flex-col min-h-0">
        <TitleBar onClose={() => requestClose()} />

        <div className="flex-1 flex min-h-0 relative">
          {/* Боковое меню — только в режиме «Слева»: в режиме верхней панели
              его заменяет NavBar, а контент занимает всю ширину */}
          {sideNav && (
            <Sidebar
              items={nav.items}
              selected={selectedIndex}
              onSelect={(index) => setPage(nav.pages[index])}
              settingsActive={page === "settings"}
              onSettingsSelect={() => openSettings()}
              profile={active}
              profileActive={page === "profile"}
              onProfileSelect={() => setPage("profile")}
            />
          )}

          <main className="flex-1 flex flex-col min-w-0 min-h-0 relative">
            {sideNav ? (
              <TopBar
                profile={active}
                showSearch={page !== "search"}
                onSearchSubmit={(value) => {
                  setQuery(value);
                  setPage("search");
                }}
                onOpenProfile={() => setPage("profile")}
                onOpenSettings={() => openSettings()}
                onAddAccount={() => setCreating(true)}
                onOpenErrors={() => openSettings("errors")}
              />
            ) : (
              <NavBar
                items={nav.items}
                selected={selectedIndex}
                onSelect={(index) => setPage(nav.pages[index])}
                settingsActive={page === "settings"}
                onSettingsSelect={() => openSettings()}
                profile={active}
                profileActive={page === "profile"}
                showSearch={page !== "search"}
                onSearchSubmit={(value) => {
                  setQuery(value);
                  setPage("search");
                }}
                onOpenProfile={() => setPage("profile")}
                onAddAccount={() => setCreating(true)}
                onOpenErrors={() => openSettings("errors")}
              />
            )}

            <div className="flex-1 overflow-y-auto">
              <div className="px-page py-6 pb-10">
                {/*
                  Раздел монтируется сразу и анимируется только на входе, чистым
                  CSS. Раньше вход и выход раздела ждал AnimatePresence: если
                  кадры анимации не приходили (окно свёрнуто в трей, загруженная
                  система, прерванный переход), раздел оставался в начальном
                  состоянии — с opacity 0, то есть пустая тёмная область при
                  работающей верхней панели. Заодно ушёл лишний transform:
                  он делал поддерево контента отдельным слоем поверх меню.
                */}
                <div key={page} className="section-enter">
                  <ErrorBoundary
                    resetKey={page}
                    title="Сбой раздела"
                    onRestartSection={() => setPage("home")}
                  >
                    {content()}
                  </ErrorBoundary>
                </div>
              </div>
            </div>

            <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
          </main>

          {/* Полноэкранный плеер: закрывает сайдбар и верхнюю панель */}
          <NowPlaying
            open={nowPlayingOpen}
            onClose={() => {
              setNowPlayingOpen(false);
              setQueueOpen(false);
            }}
          />

          {/* Настройки — отдельный экран: интерфейс приложения скрыт до выхода.
              Экран убирает таймер (settingsMounted), а не конец анимации: иначе
              при остановке кадров невидимый слой оставался поверх интерфейса. */}
          {settingsMounted && (
              <motion.div
                initial={{ y: 12 }}
                animate={
                  settingsClosing || page !== "settings"
                    ? { opacity: 0, y: 12 }
                    : { opacity: 1, y: 0 }
                }
                transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                style={
                  // Уезжающий экран не должен перехватывать клики: иначе даже
                  // мгновенная задержка выхода читается как «интерфейс не отвечает».
                  // Условие по разделу, а не только по флагу закрытия: невидимый
                  // слой настроек не имеет права ловить клики ни в одном кадре.
                  settingsClosing || page !== "settings" ? { pointerEvents: "none" } : undefined
                }
                className="absolute inset-0 z-50 bg-app overflow-y-auto"
              >
                <div className="sticky top-0 z-10 flex items-center gap-3 px-5 h-14 bg-app/95 backdrop-blur-[12px] border-b border-line/[0.06]">
                  {/* Выход — тихий hairline-контур, а не акцентная плашка:
                      главное действие настроек — сами настройки, а не выход. */}
                  <button
                    onClick={leaveSettings}
                    title="Готово — вернуться в приложение"
                    className="group flex items-center gap-1.5 h-9 pl-2 pr-3.5 ui-control hairline text-[13px] text-muted hover:text-ink hover:border-line/20 transition-colors"
                  >
                    <ArrowLeft
                      size={14}
                      className="text-faint transition-colors group-hover:text-ink"
                    />
                    Вернуться в приложение
                  </button>
                  <span className="text-[12px] text-faint hidden sm:block">
                    Настройки открыты отдельным экраном · Esc — выйти
                  </span>
                </div>
                <div className="px-page py-6">
                  <Settings
                    profile={active}
                    onOpenProfile={() => setPage("profile")}
                    requestedSection={settingsSection}
                    onOpenAdmin={() => setAdminOpen(true)}
                  />
                </div>
              </motion.div>
            )}

          {/* Админ-панель — поверх настроек, тоже на весь экран.
              Права проверяет сервер: все admin_* отвечают not_allowed не-владельцу. */}
          {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
        </div>

        {/* Панель плеера появляется, когда впервые запустили трек.
            Начальное состояние — уже видимое: если кадры анимации не придут,
            панель просто появится без «выезда», а не останется нулевой высоты
            (нулевая высота = ни плеера, ни кнопки разворота). */}
        <AnimatePresence>
          {hasStarted && !nowPlayingOpen && (
            <motion.div
              initial={{ height: 84, opacity: 0.9 }}
              animate={{ height: 84, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="overflow-hidden shrink-0 relative z-20"
            >
              <MiniPlayer
                onExpand={() => {
                  setQueueOpen(false);
                  setNowPlayingOpen(true);
                }}
                onQueue={() => setQueueOpen(true)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Крестик: по настройке спрашиваем, сворачиваем в трей или закрываем */}
      <Modal
        open={closePrompt}
        onClose={() => setClosePrompt(false)}
        title="Закрыть приложение?"
        description="Можно свернуть в трей — музыка продолжит играть."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => void finishClose("tray")} className="flex-1">
              Свернуть в трей
            </GhostButton>
            <button
              onClick={() => void finishClose("quit")}
              className="flex-1 h-9 rounded-lg bg-red-600/90 text-white text-[13px] font-medium hover:bg-red-600 transition-colors"
            >
              Закрыть полностью
            </button>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={dontAskClose}
              onChange={(event) => setDontAskClose(event.target.checked)}
              className="accent-accent"
            />
            Больше не спрашивать — запомнить выбор
          </label>
        </div>
      </Modal>

      {/* Окно артиста живёт на уровне приложения: открытое имя исполнителя не
          должно пропадать при переходе между разделами */}
      <ArtistWindow />
      <EasterEgg />

      <Toaster />
      <AudioEngine />
      <ResizeHandles />
    </div>
  );
}
