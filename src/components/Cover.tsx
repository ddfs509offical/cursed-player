import { useState } from "react";
import { Music2, Play } from "lucide-react";
import { toPlayableUrl } from "../player/audio";
import ServiceMark from "./ServiceMark";
import type { ServiceId } from "../lib/services";

interface Props {
  src?: string | null;
  size?: number;
  rounded?: string;
  /** Треугольник Play поверх обложки при наведении — подсказка «включить». */
  hoverIcon?: boolean;
  className?: string;
  /** Значок сервиса в углу обложки: сразу видно, откуда трек. */
  service?: ServiceId | null;
}

/** Обложка трека: из тегов файла или из сервиса; иначе — заглушка. */
export default function Cover({
  src,
  size = 32,
  rounded = "rounded-md",
  hoverIcon = false,
  className = "",
  service = null,
}: Props) {
  const [broken, setBroken] = useState(false);
  const url = src && !broken ? toPlayableUrl(src) : null;
  // Front Facing: крупные обложки (сетка, плеер) разворачиваются к зрителю
  // при наведении; мелкие значки в списках остаются неподвижными
  const facing = size >= 64 ? "face-wrap" : "";

  return (
    <span
      className={`relative shrink-0 inline-block ${facing} ${className}`}
      style={{ width: size, height: size }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setBroken(true)}
          className={`w-full h-full ${rounded} ${size >= 64 ? "face" : ""} object-cover bg-inset`}
        />
      ) : (
        <span
          className={`w-full h-full ${rounded} bg-ink/[0.06] border border-line/[0.07] flex items-center justify-center`}
        >
          <Music2 size={Math.max(12, Math.round(size * 0.42))} className="text-faint" />
        </span>
      )}

      {hoverIcon && (
        <span
          className={`absolute inset-0 ${rounded} bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity duration-150 flex items-center justify-center`}
        >
          <Play
            size={Math.min(40, Math.max(12, Math.round(size * 0.4)))}
            className="text-white/90 ml-0.5"
            fill="currentColor"
          />
        </span>
      )}

      {service && size >= 24 && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full bg-app ring-1 ring-line/[0.14] flex items-center justify-center"
          style={{
            // Значок не должен разрастаться на большой обложке
            width: Math.min(30, Math.max(14, Math.round(size * 0.42))),
            height: Math.min(30, Math.max(14, Math.round(size * 0.42))),
          }}
          title={service === "soundcloud" ? "SoundCloud" : service === "spotify" ? "Spotify" : service}
        >
          <ServiceMark service={service} size={Math.round(Math.min(30, Math.max(14, size * 0.42)) * 0.62)} />
        </span>
      )}
    </span>
  );
}
