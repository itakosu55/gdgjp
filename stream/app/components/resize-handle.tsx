import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * The grab strip between two regions of the editor shell.
 *
 * It carries no size of its own. The caller keeps the number and positions the
 * strip, because where the edge *is* is a fact about the shell's grid — the
 * panels are two CSS variables the container queries also write to — and a
 * handle that measured its own neighbour would have to know which of those
 * rules had won.
 *
 * `role="separator"` with a `tabIndex` is the window-splitter pattern, and the
 * arrow keys are not a courtesy: a pointer drag is the only other way to set
 * this, and unlike the drag on the canvas there is no form anywhere that says
 * the same thing. Double-click restores the width the shell opened with, which
 * is the cheap way back from a panel dragged shut.
 */

/** One arrow press, in px. */
const STEP = 16;

export function ResizeHandle({
  axis,
  label,
  value,
  min,
  max,
  reset,
  invert = false,
  onResize,
  className,
}: Readonly<{
  axis: "x" | "y";
  label: string;
  value: number;
  min: number;
  max: number;
  /** Size to go back to on a double-click. */
  reset?: number;
  /** True when moving *against* the axis grows the region — the right panel, the dock. */
  invert?: boolean;
  onResize: (next: number) => void;
  className?: string;
}>) {
  const horizontal = axis === "x";
  const [drag, setDrag] = useState<{ at: number; from: number } | null>(null);

  // The handler is installed once per drag and must not close over a stale
  // `onResize`, which is recreated by the route on every render of the shell.
  const latest = useRef(onResize);
  latest.current = onResize;

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const delta = (horizontal ? event.clientX : event.clientY) - drag.at;
      latest.current(clamp(drag.from + (invert ? -delta : delta), min, max));
    };
    const finish = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [drag, horizontal, invert, max, min]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> is void and inert; a splitter takes focus and draws a child.
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      data-dragging={drag ? "" : undefined}
      className={cn(
        "group/handle absolute z-10 flex touch-none items-center justify-center outline-none",
        horizontal ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        setDrag({ at: horizontal ? event.clientX : event.clientY, from: value });
      }}
      onDoubleClick={() => {
        if (reset !== undefined) onResize(reset);
      }}
      onKeyDown={(event) => {
        const step = arrowStep(event.key, horizontal);
        if (step === 0) {
          if (event.key === "Home") onResize(min);
          else if (event.key === "End") onResize(max);
          else return;
          event.preventDefault();
          return;
        }
        event.preventDefault();
        onResize(clamp(value + (invert ? -step : step), min, max));
      }}
    >
      {/* The strip is wider than the line it draws: a 2px target is a target
          nobody hits, and a 2px line is all the shell wants to show. */}
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-transparent transition-colors",
          "group-hover/handle:bg-primary/70 group-focus-visible/handle:bg-primary",
          "group-data-[dragging]/handle:bg-primary",
          horizontal ? "h-full w-0.5" : "h-0.5 w-full",
        )}
      />
    </div>
  );
}

function arrowStep(key: string, horizontal: boolean): number {
  if (horizontal) {
    if (key === "ArrowRight") return STEP;
    if (key === "ArrowLeft") return -STEP;
    return 0;
  }
  if (key === "ArrowDown") return STEP;
  if (key === "ArrowUp") return -STEP;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
