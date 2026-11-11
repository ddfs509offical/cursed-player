import { invoke } from "@tauri-apps/api/core";

type ResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

/**
 * Ручки изменения размера по краям окна. У окна без системной рамки Windows
 * не рисует свои бордеры, поэтому край надо «поймать» самому и попросить
 * приложение начать изменение размера (своя Rust-команда, без ACL плагина).
 */
const HANDLES: { dir: ResizeDirection; className: string }[] = [
  { dir: "North", className: "top-0 left-2 right-2 h-[5px] cursor-ns-resize" },
  { dir: "South", className: "bottom-0 left-2 right-2 h-[5px] cursor-ns-resize" },
  { dir: "West", className: "left-0 top-2 bottom-2 w-[5px] cursor-ew-resize" },
  { dir: "East", className: "right-0 top-2 bottom-2 w-[5px] cursor-ew-resize" },
  { dir: "NorthWest", className: "top-0 left-0 w-3 h-3 cursor-nwse-resize" },
  { dir: "NorthEast", className: "top-0 right-0 w-3 h-3 cursor-nesw-resize" },
  { dir: "SouthWest", className: "bottom-0 left-0 w-3 h-3 cursor-nesw-resize" },
  { dir: "SouthEast", className: "bottom-0 right-0 w-3 h-3 cursor-nwse-resize" },
];

export default function ResizeHandles() {
  return (
    <>
      {HANDLES.map((handle) => (
        <div
          key={handle.dir}
          aria-hidden
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void invoke("window_start_resize", { direction: handle.dir }).catch(() => {});
          }}
          className={`fixed z-[65] ${handle.className}`}
        />
      ))}
    </>
  );
}
