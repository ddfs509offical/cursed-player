/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        app: "rgb(var(--color-app) / calc(var(--window-alpha, 1) * <alpha-value>))",
        inset: "rgb(var(--color-inset) / calc(var(--panel-alpha, 1) * <alpha-value>))",
        surface: "rgb(var(--color-surface) / calc(var(--panel-alpha, 1) * <alpha-value>))",
        surface2: "rgb(var(--color-surface-2) / calc(var(--panel-alpha, 1) * <alpha-value>))",
        surface3: "rgb(var(--color-surface-3) / calc(var(--panel-alpha, 1) * <alpha-value>))",
        line: "rgb(var(--color-line) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        faint: "rgb(var(--color-faint) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        onAccent: "rgb(var(--color-on-accent) / <alpha-value>)",
        accentText: "rgb(var(--color-accent-text) / <alpha-value>)",
        accentHover: "rgb(var(--color-accent-hover) / <alpha-value>)",
        coverA: "rgb(var(--color-cover-a) / <alpha-value>)",
        coverB: "rgb(var(--color-cover-b) / <alpha-value>)",
        coverC: "rgb(var(--color-cover-c) / <alpha-value>)",
        coverInk: "rgb(var(--color-cover-ink) / <alpha-value>)",
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        lift: "var(--shadow-lift)",
      },
      spacing: {
        row: "var(--row-h)",
        page: "var(--page-pad)",
      },
      transitionTimingFunction: {
        // Стандартные кривые Linear/Geist: вход мягкий, выход быстрее
        out: "cubic-bezier(0, 0, 0.2, 1)",
        in: "cubic-bezier(0.4, 0, 1, 1)",
        std: "cubic-bezier(0.2, 0, 0, 1)",
      },
    },
  },
  plugins: [],
};
