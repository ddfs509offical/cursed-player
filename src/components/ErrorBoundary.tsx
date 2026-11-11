import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Home, RotateCw } from "lucide-react";
import { errorText, logError } from "../store/errorStore";

interface Props {
  children: ReactNode;
  /**
   * Сброс на главную: вызывается по кнопке «Перезапустить раздел». Если не
   * передан — раздел просто перерисовывается заново.
   */
  onRestartSection?: () => void;
  /**
   * Смена ключа сбрасывает ошибку: перешли в другой раздел — старый сбой
   * больше не держит экран.
   */
  resetKey?: unknown;
  /** Заголовок экрана-заглушки: у уровня приложения и уровня раздела разные. */
  title?: string;
}

interface State {
  error: Error | null;
}

/**
 * Ловит исключения рендера в поддереве. Без такой обёртки React 18 при
 * необработанной ошибке размонтирует всё приложение — пользователь видит
 * пустой экран без объяснений. Здесь вместо пустоты появляется понятный
 * экран: что сломалось, текст ошибки и два выхода — перезапустить раздел
 * (возврат на главную) или перезагрузить приложение целиком.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError(
      this.props.title ?? "Сбой интерфейса",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      "интерфейс",
      [errorText(error), info.componentStack].filter(Boolean).join("\n\n")
    );
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private restartSection = () => {
    this.setState({ error: null });
    this.props.onRestartSection?.();
  };

  private reloadApp = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

    return (
      <div className="h-full min-h-[320px] bg-app flex flex-col items-center justify-center text-center px-6 py-12">
        <div className="w-14 h-14 rounded-2xl border border-line/10 bg-surface flex items-center justify-center text-amber-400 mb-4">
          <AlertTriangle size={22} strokeWidth={1.75} />
        </div>
        <p className="text-[15px] font-semibold">Что-то сломалось</p>
        <p className="text-[13px] text-muted mt-1.5 max-w-md leading-relaxed">
          Этот раздел не смог отрисоваться. Ошибка записана в журнал: Настройки → Ошибки.
        </p>
        <pre className="mt-4 max-w-xl max-h-40 overflow-auto text-left text-[11px] leading-relaxed text-faint bg-inset border border-line/[0.08] rounded-xl px-3 py-2 whitespace-pre-wrap">
          {message}
        </pre>
        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={this.restartSection}
            className="flex items-center gap-1.5 h-9 px-4 rounded-lg bg-accent text-onAccent text-[13px] font-medium hover:bg-accentHover transition-colors"
          >
            <Home size={14} /> Перезапустить раздел
          </button>
          <button
            onClick={this.reloadApp}
            className="flex items-center gap-1.5 h-9 px-4 rounded-lg border border-line/[0.14] text-[13px] text-ink/85 hover:bg-ink/[0.06] hover:text-ink transition-colors"
          >
            <RotateCw size={14} /> Перезагрузить приложение
          </button>
        </div>
      </div>
    );
  }
}
