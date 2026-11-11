import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Check, X, type LucideIcon } from "lucide-react";
import type { DownloadChoice } from "../store/settingsStore";
import { useExitGuard } from "../lib/useExitGuard";

interface Props {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Небольшая модалка: затемнение, панель, Esc и клик по фону закрывают.
 *
 * Панель — «стеклянная» поверхность, как остальные окна приложения: полупрозрачный
 * фон поверх третьей поверхности, размытие и общий класс `.glass-float` (тень и
 * блик по верхней кромке, см. styles.css). Раньше фон был плотным (/85) — окно
 * «Что сохранить?» выглядело глухой плитой; /60 читается и оставляет видимым то,
 * что под ним.
 *
 * Фокус ставится один раз при открытии и только в поле ввода. Раньше эффект
 * зависел от onClose (новая функция на каждый рендер) и искал
 * "input, textarea, button" — первым совпадением оказывался крестик, фокус
 * уезжал на него при каждом нажатии клавиши, и текст переставал печататься.
 */
export default function Modal({ open, title, description, onClose, children, footer }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** Слой уходит по таймеру и сразу перестаёт ловить клики (см. useExitGuard). */
  const { mounted, leaving } = useExitGuard(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("input, textarea")?.focus();
  }, [open]);

  return (
    /*
      Наличие слоя в дереве определяет `mounted` (его снимает таймер), а framer
      только рисует появление и уход. AnimatePresence убирал окно лишь после
      конца анимации выхода: при остановке кадров модалка оставалась поверх
      приложения и перехватывала клики.
    */
    <>
      {mounted && (
        <motion.div
          initial={{ opacity: 0.9 }}
          animate={leaving ? { opacity: 0 } : { opacity: 1 }}
          transition={{ duration: 0.15 }}
          style={leaving ? { pointerEvents: "none" } : undefined}
          className="fixed inset-0 z-[70] bg-app/80 flex items-center justify-center p-6"
          onClick={onClose}
        >
          <motion.div
            ref={panelRef}
            initial={{ scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="glass-float w-[440px] max-w-full bg-surface3/60 backdrop-blur-[18px] rounded-2xl border border-line/10 p-5"
          >
            <div className="flex items-start justify-between gap-4 mb-1">
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold">{title}</h2>
                {description && <p className="text-[13px] text-muted mt-1 leading-relaxed">{description}</p>}
              </div>
              <button
                onClick={onClose}
                aria-label="Закрыть"
                className="shrink-0 -m-1 p-1.5 rounded-lg text-muted hover:text-ink hover:bg-ink/[0.06] transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-4">{children}</div>
            {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </>
  );
}

/** Вариант сохранения: что именно положить на диск. */
const DOWNLOAD_OPTIONS: { value: DownloadChoice; label: string; hint: string }[] = [
  { value: "track", label: "Только трек", hint: "аудиофайл на диск" },
  { value: "lyrics", label: "Только текст", hint: "текст песни с таймингами" },
  { value: "both", label: "Трек и текст", hint: "аудио и текст вместе" },
];

export interface DownloadChoiceModalProps {
  open: boolean;
  /** Название трека — подпись под заголовком. */
  trackTitle?: string;
  /** Трек уже лежит в офлайн-реестре. */
  trackSaved: boolean;
  /** Текст уже сохранён файлом рядом с треком. */
  lyricsSaved: boolean;
  /** Вариант, выбранный в прошлый раз (запомненный). */
  defaultChoice?: DownloadChoice;
  /**
   * Настройка «запомнить выбор» из раздела «Плеер». По умолчанию она снята:
   * окно показывается при каждом скачивании, а галочка внутри него — не
   * отмечена, чтобы один клик «Сохранить» не запоминал выбор молча.
   */
  remembered?: boolean;
  onClose: () => void;
  onConfirm: (choice: DownloadChoice, remember: boolean) => void;
}

/**
 * Окно выбора при скачивании: трек, текст или всё вместе. Уже сделанное не
 * предлагается повторно — вариант гаснет с подписью «уже сохранено», а если
 * сохранено и то и другое, окно только сообщает об этом и оставляет одну
 * кнопку «Закрыть».
 */
export function DownloadChoiceModal({
  open,
  trackTitle,
  trackSaved,
  lyricsSaved,
  defaultChoice = "both",
  remembered = false,
  onClose,
  onConfirm,
}: DownloadChoiceModalProps) {
  const [choice, setChoice] = useState<DownloadChoice>(defaultChoice);
  // Галочка «запомнить выбор» снята по умолчанию: пока пользователь не включил
  // настройку «Запомнить выбор и не спрашивать» в разделе «Плеер», окно выбора
  // возвращается при каждом скачивании.
  const [remember, setRemember] = useState(remembered);

  /** Подпись неактивного варианта: null — вариант доступен. */
  const noteOf = (value: DownloadChoice): string | null => {
    if (value === "track") return trackSaved ? "уже сохранено" : null;
    if (value === "lyrics") return lyricsSaved ? "текст уже сохранён" : null;
    return trackSaved && lyricsSaved ? "уже сохранено" : null;
  };

  const complete = trackSaved && lyricsSaved;

  // Каждое открытие — чистый выбор: подставляем запомненный вариант, а если он
  // уже сделан — первый доступный. Галочка «запомнить» берётся из настройки:
  // по умолчанию она снята, включённой приходит только если пользователь сам
  // включил «Запомнить выбор и не спрашивать» в настройках.
  useEffect(() => {
    if (!open) return;
    setRemember(remembered);
    const nextChoice = noteOf(defaultChoice)
      ? (DOWNLOAD_OPTIONS.find((option) => !noteOf(option.value))?.value ?? defaultChoice)
      : defaultChoice;
    setChoice(nextChoice);
    // noteOf зависит только от уже сохранённого: пересчитывается вместе с ним
  }, [open, defaultChoice, trackSaved, lyricsSaved, remembered]);

  return (
    <Modal
      open={open}
      title="Что сохранить?"
      description={trackTitle}
      onClose={onClose}
      footer={
        complete ? (
          <GhostButton onClick={onClose}>Закрыть</GhostButton>
        ) : (
          <>
            <GhostButton onClick={onClose}>Отмена</GhostButton>
            <PrimaryButton onClick={() => onConfirm(choice, remember)}>Сохранить</PrimaryButton>
          </>
        )
      }
    >
      {complete ? (
        <p className="text-[13px] text-muted">
          Уже сохранено полностью — и трек, и текст лежат на диске.
        </p>
      ) : (
        <div>
          <div role="radiogroup" aria-label="Что сохранить" className="space-y-1.5">
            {DOWNLOAD_OPTIONS.map((option) => {
              const note = noteOf(option.value);
              const selected = choice === option.value && !note;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={note !== null}
                  onClick={() => setChoice(option.value)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                    selected
                      ? "border-accentText/60 bg-accent/[0.10]"
                      : // Рамка чуть заметнее, чем у плотной панели: на
                        // полупрозрачном стекле пункты должны оставаться ясными
                        "border-line/[0.14] hover:bg-ink/[0.06]"
                  } ${note ? "opacity-45 cursor-not-allowed" : ""}`}
                >
                  <span
                    className={`w-4 h-4 rounded-full border shrink-0 flex items-center justify-center ${
                      selected ? "border-accentText" : "border-line/30"
                    }`}
                  >
                    {selected && <span className="w-2 h-2 rounded-full bg-accentText" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{option.label}</span>
                    <span className="block text-[11px] text-muted">{note ?? option.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 pt-3 text-[12px] text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="accent-accent"
            />
            Запомнить выбор и больше не спрашивать
          </label>
        </div>
      )}
    </Modal>
  );
}

/** Кнопка-акцент для действий в модалке и формах. */
export function PrimaryButton({
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`h-9 px-4 rounded-lg bg-accent text-onAccent text-[13px] font-medium hover:bg-accentHover transition-colors disabled:opacity-40 disabled:hover:bg-accent ${className}`}
    >
      {children}
    </button>
  );
}

/** Нейтральная кнопка: границы вместо заливки. */
export function GhostButton({
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`h-9 px-3.5 rounded-lg border border-line/[0.12] text-[13px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

/** Опасное действие: удаление профиля и подобное. */
export function DangerButton({
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`h-9 px-4 rounded-lg bg-red-500/90 text-white text-[13px] font-medium hover:bg-red-500 transition-colors disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

/* ───────────────────────── Плотные экраны ─────────────────────────
 *
 * Общие приёмы настроек и профиля: тихая плоская сетка вместо стекла.
 * Панель — просто поверхность с тонкой границей, строка — заголовок с
 * пояснением и контролом справа, карточки — варианты выбора плитками.
 * Скругление и масштаб приходят из CSS-переменных (styles.css), поэтому
 * настройки оформления действуют на все экраны сразу.
 */

/** Плоская панель с необязательным заголовком раздела. */
export function SettingPanel({
  title,
  hint,
  children,
  className = "",
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className="mb-4 last:mb-0">
      {title && (
        <div className="mb-2.5 flex items-baseline gap-3">
          <p className="title-section">{title}</p>
          {hint && <p className="text-[12px] text-faint leading-snug">{hint}</p>}
        </div>
      )}
      <div className={`ui-panel hairline bg-surface overflow-hidden ${className}`}>
        {children}
      </div>
    </section>
  );
}

/**
 * Сноска под панелью.
 *
 * По просьбе владельца такие пояснения из настроек убраны: страница должна
 * говорить только делом — заголовок, значение и контрол. Компонент оставлен,
 * чтобы не менять все вызовы; когда тексты пригодятся, вернём тело.
 */
export function SettingNote(_props: { children: ReactNode }) {
  return null;
}

/**
 * Строка настройки: заголовок (13 px, ink) и пояснение (12 px, muted) слева,
 * контрол справа. Разделитель — только между строками.
 */
export function SettingRow({
  title,
  hint,
  control,
  icon: Icon,
  stacked = false,
  children,
}: {
  title: string;
  hint?: ReactNode;
  control?: ReactNode;
  icon?: LucideIcon;
  /** Контрол под строкой: для карточек и слайдеров, которым нужна вся ширина. */
  stacked?: boolean;
  children?: ReactNode;
}) {
  if (stacked) {
    return (
      <div className="setting-row px-4 py-4">
        <div className="flex items-start gap-3 min-w-0">
          {Icon && (
            <span className="w-8 h-8 ui-control bg-inset border border-line/[0.07] flex items-center justify-center text-muted shrink-0">
              <Icon size={14} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">{title}</p>
            {hint && <p className="text-[12px] text-muted mt-0.5 leading-snug">{hint}</p>}
          </div>
          {control && <div className="shrink-0">{control}</div>}
        </div>
        {children && <div className="mt-3">{children}</div>}
      </div>
    );
  }
  return (
    <div className="setting-row flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="flex items-center gap-3 min-w-0">
        {Icon && (
          <span className="w-8 h-8 ui-control bg-inset border border-line/[0.07] flex items-center justify-center text-muted shrink-0">
            <Icon size={14} />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-[13px] text-ink">{title}</p>
          {hint && <p className="text-[12px] text-muted mt-0.5 leading-snug">{hint}</p>}
        </div>
      </div>
      {control && <div className="shrink-0 flex items-center gap-2">{control}</div>}
      {children}
    </div>
  );
}

/** Один вариант в карточках: иконка, название, короткое пояснение. */
export interface SettingCardOption {
  id: string;
  label: string;
  hint?: string;
  Icon?: LucideIcon;
  /** Произвольное превью над подписью: полоски темы, цвет, миниатюра. */
  preview?: ReactNode;
}

/**
 * Карточки-варианты — главный приём образца: группа из 2–4 плиток, выбранная
 * обведена акцентом и подсвечена. Никаких «пилюль» и теней: только граница.
 */
export function SettingCards({
  options,
  value,
  onChange,
  columns = 2,
  ariaLabel,
}: {
  options: SettingCardOption[];
  value: string;
  onChange: (id: string) => void;
  columns?: 2 | 3 | 4;
  ariaLabel: string;
}) {
  const grid =
    columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-4";
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`grid gap-2 ${grid}`}>
      {options.map((option) => {
        const selected = option.id === value;
        const Icon = option.Icon;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={`ui-tile border p-2.5 text-left transition-colors ${
              selected
                ? "border-accentText bg-accent/[0.08]"
                : "border-line/[0.09] hover:border-line/20 hover:bg-ink/[0.03]"
            }`}
          >
            {option.preview}
            <span className="flex items-center gap-2 min-w-0">
              {Icon && <Icon size={14} className={selected ? "text-accentText shrink-0" : "text-muted shrink-0"} />}
              <span className="text-[13px] truncate">{option.label}</span>
              {selected && <Check size={12} className="text-accentText ml-auto shrink-0" />}
            </span>
            {option.hint && (
              <span className="block text-[11px] text-muted mt-1 leading-snug">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Верхние вкладки разделов: сегментированный контрол «иконка + подпись».
 *
 * Активная вкладка — акцентная иконка, текст в ink и планка акцента 2 px по
 * нижней кромке; неактивные — muted без рамок и заливки. Заливки нет намеренно:
 * «пилюля», которая переезжала между вкладками, на середине движения
 * растягивалась в широкий серый блок — это читалось как артефакт, а не как
 * выбор. Планка короче подписи и всегда остаётся на своём месте.
 */
export function SettingTabs<T extends string>({
  items,
  value,
  onChange,
  group,
}: {
  items: { id: T; label: string; icon?: LucideIcon }[];
  value: T;
  onChange: (id: T) => void;
  group: string;
}) {
  return (
    <div role="tablist" aria-label={group} className="flex flex-wrap items-center gap-1 -ml-2">
      {items.map((item) => {
        const active = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={`relative flex items-center gap-1.5 h-9 px-3 ui-control text-[13px] transition-colors ${
              active ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {active && (
              /* Только планка: подложка-«пилюля», которая переезжала между
                 вкладками, на середине движения растягивалась в широкий серый
                 блок. Планка 2 px и акцентная иконка показывают выбор без
                 этого артефакта, и переключение остаётся спокойным. */
              <span className="absolute left-3 right-3 bottom-1 h-[2px] rounded-full bg-accentText" />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {Icon && (
                <Icon
                  size={14}
                  className={`shrink-0 transition-colors ${active ? "text-accentText" : "text-faint"}`}
                />
              )}
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Под-вкладки раздела: сегментированная панель с переезжающей подсветкой. */
export function SettingSegments<T extends string>({
  items,
  value,
  onChange,
  group,
}: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  group: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={group}
      className="inline-flex items-center gap-0.5 p-1 ui-control bg-inset border border-line/[0.07]"
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={`relative h-7 px-3 ui-control text-[12px] transition-colors ${
              active ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {active && (
              <motion.span
                layoutId={`setting-seg-${group}`}
                className="absolute inset-0 bg-surface border border-line/[0.08]"
                style={{ borderRadius: "var(--radius-control)" }}
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
              />
            )}
            <span className="relative z-10">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
