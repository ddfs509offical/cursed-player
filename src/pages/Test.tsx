import { FlaskConical } from "lucide-react";
import EmptyState from "../components/EmptyState";

/**
 * Тестовый раздел: заглушка для проверки навигации и интерфейса.
 */
export default function TestPage() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-14 h-14 rounded-2xl border border-line/10 bg-surface flex items-center justify-center text-faint mb-4">
        <FlaskConical size={22} strokeWidth={1.75} />
      </div>
      <p className="text-[15px] font-semibold">Тест</p>
      <p className="text-[13px] text-muted mt-1.5 max-w-sm leading-relaxed">
        Этот раздел пока пуст. Здесь можно будет разместить экспериментальные
        функции и тесты приложения.
      </p>
    </div>
  );
}
