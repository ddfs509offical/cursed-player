import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri собирается отдельно, а временные файлы атомарных записей
      // (например, из редактора) роняли watcher с EBUSY на Windows. Маски
      // с ведущей точкой нужны отдельно: без них picomatch не берёт скрытые
      // каталоги вида ".gradients.ts.1234.tmpdir".
      ignored: [
        "**/src-tauri/**",
        "**/.*.tmpdir/**",
        "**/*.tmpdir",
        "**/.*.tmp",
        "**/*.tmp",
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    outDir: "dist",
  },
});
