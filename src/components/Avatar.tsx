import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import type { Profile } from "../services/profiles";
import { seedFromString, themeCover } from "../lib/coverTone";

interface Props {
  profile: Pick<Profile, "username" | "displayName" | "avatar"> | null;
  /** Размер в пикселях. */
  size?: number;
  className?: string;
  /** Кольцо вокруг аватара — «вырезает» его из баннера. */
  ring?: boolean;
}

/**
 * Аватар: картинка профиля, а если её нет или она не загрузилась —
 * детерминированный градиент с первой буквой имени. Пустой белый кружок
 * (битая ссылка) не показываем никогда.
 */
export default function Avatar({ profile, size = 32, className = "", ring = false }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const avatar = profile?.avatar ?? null;

  // Смена картинки (в т.ч. на рабочую) должна сбрасывать прошлую ошибку
  useEffect(() => {
    setImageFailed(false);
  }, [avatar]);

  const name = profile?.displayName || profile?.username || "";
  const initial = name.trim().charAt(0).toUpperCase();
  const seed = seedFromString(profile?.username || "guest");
  const ringClass = ring ? "ring-4 ring-app" : "ring-1 ring-line/10";

  if (avatar && !imageFailed) {
    return (
      <img
        src={avatar}
        alt=""
        draggable={false}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        onError={() => setImageFailed(true)}
        className={`rounded-full object-cover shrink-0 select-none bg-ink/[0.06] ${ringClass} ${className}`}
      />
    );
  }

  return (
    <div
      style={{ width: size, height: size, background: themeCover(seed), fontSize: Math.round(size * 0.42) }}
      className={`rounded-full shrink-0 flex items-center justify-center font-semibold text-coverInk select-none ${ringClass} ${className}`}
      aria-hidden
    >
      {initial || <UserRound size={Math.round(size * 0.5)} />}
    </div>
  );
}
