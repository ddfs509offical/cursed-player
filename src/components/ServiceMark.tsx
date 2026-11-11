import type { ServiceId } from "../lib/services";
import logoYandex from "../assets/logo-yandex.png";
import logoSpotify from "../assets/logo-spotify.png";

/**
 * Знаки сервисов: у Яндекса и Spotify — настоящие логотипы (присланы
 * пользователем), у VK — простая монохромная иконка. Неподключённые сервисы
 * показываем приглушёнными, чтобы состояние читалось без подписи.
 */
export default function ServiceMark({
  service,
  size = 16,
  muted = false,
}: {
  service: ServiceId;
  size?: number;
  muted?: boolean;
}) {
  const tone = muted ? "opacity-40 saturate-0" : "";

  if (service === "yandex") {
    // Логотип Яндекса — чёрный квадрат: на тёмной теме видно только по контуру,
    // поэтому добавляем тонкую светлую обводку (без толстой белой рамки).
    return (
      <span
        className={`inline-block shrink-0 rounded-full overflow-hidden ring-1 ring-white/30 ${tone}`}
        style={{ width: size, height: size }}
      >
        <img
          src={logoYandex}
          alt=""
          className="w-full h-full object-cover"
          draggable={false}
        />
      </span>
    );
  }

  if (service === "spotify") {
    return (
      <img
        src={logoSpotify}
        alt=""
        width={size}
        height={size}
        className={`rounded-full object-cover shrink-0 ${tone}`}
        draggable={false}
      />
    );
  }

  if (service === "soundcloud") {
    // Облако SoundCloud
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
        className={`shrink-0 ${tone}`}
      >
        <path
          d="M6.4 17.5h10.9a3.3 3.3 0 0 0 .3-6.6 5 5 0 0 0-9.5-1.6A3.9 3.9 0 0 0 3.2 13a4.5 4.5 0 0 0 3.2 4.5Z"
          fill="#FF5500"
        />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={`shrink-0 ${tone}`}
    >
      <rect x="2.8" y="2.8" width="18.4" height="18.4" rx="5.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M6.6 8.4h1.7l1.4 4.2 1.4-4.2h1.6l-2.2 6.1H8.8L6.6 8.4Zm7 0h1.6v2.3l2-2.3h1.9l-2.3 2.6 2.4 3.5h-1.9l-1.6-2.4-.5.6v1.8h-1.6V8.4Z"
        fill="currentColor"
      />
    </svg>
  );
}
