import { Heart } from "lucide-react";
import { favoriteKeyFor } from "../lib/favoriteKey";
import { useFavoritesStore, favoriteTrackFrom, type FavoriteTrack } from "../store/favoritesStore";
import { toast } from "../store/toastStore";
import { sounds } from "../lib/sounds";

interface Props {
  /** Карточка трека: достаточно id, остальное подставится разумными значениями. */
  track: Partial<FavoriteTrack> & { id: string };
  size?: number;
  className?: string;
}

/**
 * Сердечко «в избранное»: одинаковое во всех списках и плеере.
 *
 * Ключ лайка считается одной функцией (`favoriteKeyFor`), а не берётся из `id`
 * напрямую: строка очереди или скачанного трека приходит с путём к файлу кеша,
 * и без приведения сердечко ставило лайк другому ключу, чем «Избранное».
 */
export default function FavoriteButton({ track, size = 14, className = "" }: Props) {
  const key = favoriteKeyFor(track);
  const liked = useFavoritesStore((s) => s.ids.includes(key));
  const toggle = useFavoritesStore((s) => s.toggle);
  const card = favoriteTrackFrom({ ...track, id: key });

  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        const nowLiked = toggle(card);
        if (nowLiked) sounds.save();
        else sounds.off();
        toast({
          title: nowLiked ? "Добавлено в избранное" : "Убрано из избранного",
          description: card.title,
          action: { label: "Отменить", run: () => void toggle(card) },
        });
      }}
      aria-label={liked ? "Убрать из избранного" : "Добавить в избранное"}
      aria-pressed={liked}
      title={liked ? "Убрать из избранного" : "В избранное"}
      className={`p-1.5 rounded-lg transition-colors ${
        liked ? "text-red-400 hover:bg-red-500/10" : "text-faint hover:text-ink hover:bg-ink/[0.06]"
      } ${className}`}
    >
      <Heart size={size} fill={liked ? "currentColor" : "none"} strokeWidth={1.9} />
    </button>
  );
}
