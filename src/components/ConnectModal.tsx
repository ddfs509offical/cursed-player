import { useState, useEffect } from "react";
import { ClipboardPaste, ExternalLink, Check } from "lucide-react";
import Modal, { GhostButton, PrimaryButton } from "./Modal";
import { normalizeToken } from "../lib/tokens";
import { sounds } from "../lib/sounds";

interface Props {
  service: string | null;
  onClose: () => void;
  onSave: (service: string, token: string) => void;
}

interface Hint {
  what: string;
  steps: string[];
  links?: { url: string; label: string }[];
}

const HINTS: Record<string, Hint> = {
  "Яндекс Музыка": {
    what: "OAuth-токен аккаунта Яндекс ID",
    steps: [
      "Открой страницу выдачи токена и разреши доступ",
      "Скопируй значение access_token из адресной строки",
      "Вставь сюда — приложение проверит токен и подтянет плейлисты",
      "Поиск работает с любым музыкальным токеном; для плейлистов нужен токен с доступом к аккаунту",
    ],
    links: [
      {
        url: "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d",
        label: "Страница выдачи токена",
      },
      { url: "https://teletype.in/@faqdotify/xXLIYm40woT", label: "Гайд: как получить токен" },
    ],
  },
  Spotify: {
    what: "Access token приложения Spotify",
    steps: [
      "Проще всего — вход по Client ID в настройках: токен тогда продлевается сам",
      "Либо возьми access token на developer.spotify.com/dashboard",
      "Помни: такой токен живёт около часа",
    ],
    links: [{ url: "https://developer.spotify.com/dashboard", label: "Кабинет Spotify" }],
  },
  "VK Музыка": {
    what: "Токен доступа VK",
    steps: [
      "VK с 2021 не отдаёт музыку через API: поиск и прослушивание недоступны",
      "Подключи Яндекс Музыку или Spotify — они работают",
    ],
  },
};

export default function ConnectModal({ service, onClose, onSave }: Props) {
  const [token, setToken] = useState("");
  const [pasted, setPasted] = useState(false);
  const hint = service ? HINTS[service] ?? { what: "Токен доступа", steps: [] } : null;

  useEffect(() => {
    setToken("");
    setPasted(false);
  }, [service]);

  const clean = normalizeToken(token);
  const tooShort = clean.length > 0 && clean.length < 10;

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setToken(text.trim());
        setPasted(true);
      }
    } catch {
      sounds.error();
    }
  }

  return (
    <Modal
      open={Boolean(service)}
      onClose={onClose}
      title={`Подключить ${service ?? ""}`}
      description={hint?.what}
      footer={
        <>
          <GhostButton onClick={onClose}>Отмена</GhostButton>
          <PrimaryButton
            disabled={!clean || tooShort}
            onClick={() => service && onSave(service, clean)}
          >
            Подключить и проверить
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setPasted(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && clean && !tooShort && service) onSave(service, clean);
              }}
              placeholder="Вставь токен сюда"
              className="input flex-1"
            />
            <GhostButton onClick={() => void pasteFromClipboard()} className="flex items-center gap-1.5 shrink-0">
              <ClipboardPaste size={14} /> Вставить
            </GhostButton>
          </div>

          <div className="flex items-center gap-2 mt-2 text-[11px]">
            {clean ? (
              tooShort ? (
                <span className="text-red-400">Слишком коротко: похоже, скопировалась не вся строка</span>
              ) : (
                <span className="text-emerald-400/90 flex items-center gap-1">
                  <Check size={11} /> Готово к подключению · {clean.length} символов
                </span>
              )
            ) : (
              <span className="text-faint">
                Токен хранится только на этом устройстве. Префиксы «OAuth» и кавычки можно не убирать — почистим сами.
              </span>
            )}
            {pasted && clean && !tooShort && <span className="text-faint">· вставлено из буфера</span>}
          </div>
        </div>

        {hint && hint.steps.length > 0 && (
          <div className="rounded-xl border border-line/[0.07] bg-inset p-3.5">
            <p className="text-[12px] font-medium mb-2">Как получить</p>
            <ol className="space-y-1.5">
              {hint.steps.map((step, index) => (
                <li key={step} className="flex gap-2 text-[12px] text-muted">
                  <span className="text-faint tnum shrink-0">{index + 1}.</span>
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ol>
            {hint.links?.map((link) => (
              <button
                key={link.url}
                onClick={() => {
                  sounds.open();
                  void import("@tauri-apps/plugin-shell").then(({ open }) => open(link.url));
                }}
                className="mt-2.5 mr-4 inline-flex items-center gap-1.5 text-[12px] text-accentText hover:underline"
              >
                <ExternalLink size={12} /> {link.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
