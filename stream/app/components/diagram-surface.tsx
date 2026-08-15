import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "~/lib/utils";

/**
 * The pane the signal flow diagram is looked at through.
 *
 * It is a **native scroll container** with its own scrollbars hidden and two
 * drawn over the top, rather than a camera holding an `{x, y, scale}` of its
 * own. The picture has no coordinates — `SetupDoc` refuses to carry any and the
 * layout is regenerated on every render — so there is nothing here a transform
 * would express better, and three things already lean on the pane being
 * scrollable: selecting anything scrolls its box into view, Playwright's
 * `scrollIntoViewIfNeeded` is what puts a jack under the cursor before a drag,
 * and browsers now let the keyboard scroll an overflowing region, which is the
 * only non-pointer route around a picture this wide.
 *
 * What changes is what `ctrl`-and-the-wheel means. It zooms, as it does on a
 * map, and about the pointer rather than about the corner: the reason to zoom in
 * on this picture is to read one machine's jacks, and a zoom that then drops
 * that machine off the edge has to be undone by hand every single time. Holding
 * the point under the cursor still is one line of arithmetic and removes the
 * whole gesture. A bare wheel is left alone — a rig is taller than the pane far
 * more often than it needs zooming, and `ctrl` is both the modifier every canvas
 * uses and what a trackpad pinch already arrives as.
 *
 * Since the pane resizes as a *result* of the zoom, the scroll that holds that
 * point still cannot be written until the new size exists — hence the one
 * `flushSync`. Deferring it to the next frame draws the jump and then corrects
 * it, which is more visible than the thing it was avoiding.
 *
 * The picture floats on a mat half a pane wide on every side. That is exactly
 * the room needed to pull any edge of it to the middle of the pane and no more,
 * which matters both ways round: with less, zooming into something near an edge
 * clamps against the scroll and the point under the cursor slides away; with
 * more, the whole picture can be pushed off screen and has to be hunted for.
 *
 * The drawn scrollbars are not decoration. Once a wheel no longer scrolls, the
 * remaining pointer route is dragging, and a scrollbar the platform draws is
 * both the loudest thing on a pane full of 1px cables and — on the platforms
 * that hide it until you scroll — missing exactly when it is the only route
 * there is.
 */

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2;

/**
 * Gap between the picture's corner and the pane's when the view is reset.
 * Screen px, never scaled, and the floor under the mat below.
 */
export const SURFACE_PAD = 16;

/**
 * Zoom per pixel of wheel travel, applied exponentially so a notch in and a
 * notch back out land on the scale they started from.
 */
const WHEEL_RATE = 0.0015;

/** Wheel deltas arrive in lines or pages on some platforms. Both mean pixels here. */
const LINE_HEIGHT = 16;

const THUMB = 8;
const THUMB_INSET = 3;
const MIN_THUMB = 28;

/** How long the scrollbars stay up after the last scroll. */
const FADE_AFTER = 1100;

/** How far a drag travels before it is a pan and not a click. */
const PAN_SLOP = 3;

/** One axis' scroll state, or `null` when that axis does not overflow. */
type Extent = { start: number; view: number; total: number };

type Axis = "x" | "y";

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The mat the picture should be floating on for this pane: half of it on every
 * side. Any smaller and an edge of the picture cannot reach the middle; any
 * larger and the picture can be shoved off screen entirely. It follows that the
 * scroll range is the picture's own size, whatever the pane is doing.
 */
function padFor(element: HTMLElement): { x: number; y: number } {
  return {
    x: Math.max(SURFACE_PAD, Math.round(element.clientWidth / 2)),
    y: Math.max(SURFACE_PAD, Math.round(element.clientHeight / 2)),
  };
}

/**
 * The mat currently laid, read back off the element.
 *
 * The element owns this and React does not render it: the padding is a fact
 * about the pane's measured size, and a re-render to change it would paint the
 * picture in its new place one frame before the scroll that cancels the move.
 * Written and cancelled in the same breath, nothing moves at all.
 */
function padOf(element: HTMLElement): { x: number; y: number } {
  return {
    x: Number.parseFloat(element.style.getPropertyValue("--pad-x")) || SURFACE_PAD,
    y: Number.parseFloat(element.style.getPropertyValue("--pad-y")) || SURFACE_PAD,
  };
}

function same(a: Extent | null, b: Extent | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.view === b.view && a.total === b.total;
}

/** A wheel delta in pixels, whatever unit the platform sent it in. */
function wheelPixels(event: WheelEvent, page: number): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT;
  if (event.deltaMode === 2) return event.deltaY * page;
  return event.deltaY;
}

/**
 * Zoom the pane, holding one point of the picture still.
 *
 * Exported because the toolbar's ± buttons have to move the picture the same
 * way the wheel does; all they change is the anchor, which for a button is the
 * middle of the pane because that is the only point a button can be said to
 * have been aimed at. A zoom that anchors on the corner instead walks whatever
 * you were reading off the edge, and does it worse the further in you are.
 *
 * The picture sits one mat in from the pane's origin at every zoom, and the mat
 * is a fact about the pane rather than the scale, so a diagram point `d` is at
 * `pad + d * scale` in content coordinates and the scroll that keeps it under
 * the anchor falls straight out of that. The pane resizes as a *result* of
 * `apply`, so that scroll cannot be written until the new size exists —
 * deferring it to the next frame draws the jump and then corrects it, which is
 * more visible than the thing it avoids.
 */
export function zoomSurface(
  element: HTMLElement | null,
  from: number,
  to: number,
  anchor: { x: number; y: number } | null,
  apply: (scale: number) => void,
): void {
  if (to === from) return;
  if (!element) {
    apply(to);
    return;
  }
  const box = element.getBoundingClientRect();
  const pad = padOf(element);
  const cx = anchor ? anchor.x - box.left : box.width / 2;
  const cy = anchor ? anchor.y - box.top : box.height / 2;
  const dx = (element.scrollLeft + cx - pad.x) / from;
  const dy = (element.scrollTop + cy - pad.y) / from;

  flushSync(() => apply(to));

  element.scrollLeft = pad.x + dx * to - cx;
  element.scrollTop = pad.y + dy * to - cy;
}

/**
 * Zoom, then put the picture's corner back in the pane's corner.
 *
 * What 幅に合わせる needs: a scale that fits, *and* a scroll, because the point
 * of the button is to see the rig end to end and a scroll left over from
 * wherever it was being read hides one end of it. The scroll has to wait for the
 * new scale for the same reason a zoom's does — the mat's far edge is only where
 * the button wants it once the picture underneath is the right size.
 */
export function resetSurface(
  element: HTMLElement | null,
  to: number,
  apply: (scale: number) => void,
): void {
  if (!element) {
    apply(to);
    return;
  }
  flushSync(() => apply(to));
  const pad = padOf(element);
  element.scrollTo({ left: pad.x - SURFACE_PAD, top: pad.y - SURFACE_PAD });
}

export function DiagramSurface({
  viewport,
  scale,
  onScale,
  children,
}: Readonly<{
  /**
   * The scrolling element, owned by the route because two things outside this
   * component reach for it: 幅に合わせる measures it, and selecting a box
   * scrolls to it.
   */
  viewport: RefObject<HTMLDivElement | null>;
  scale: number;
  onScale: (scale: number) => void;
  children: ReactNode;
}>) {
  const content = useRef<HTMLDivElement>(null);
  const [extents, setExtents] = useState<{ x: Extent | null; y: Extent | null }>({
    x: null,
    y: null,
  });
  const [awake, setAwake] = useState(false);
  const [panning, setPanning] = useState(false);
  const [holding, setHolding] = useState<Axis | null>(null);
  const sleep = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(() => {
    const element = viewport.current;
    if (!element) return;

    // Lay the mat, and undo the shove it would otherwise give the picture in the
    // same breath: growing the leading pad by n moves everything n to the right,
    // and scrolling n to the right puts it back. So a pane that changes width —
    // a dragged panel edge, a resized window, hydration finding a real size for
    // the first time — leaves the picture exactly where it was on screen.
    const want = padFor(element);
    const have = padOf(element);
    if (want.x !== have.x || want.y !== have.y) {
      element.style.setProperty("--pad-x", `${want.x}px`);
      element.style.setProperty("--pad-y", `${want.y}px`);
      element.scrollLeft += want.x - have.x;
      element.scrollTop += want.y - have.y;
    }

    const overflowsX = element.scrollWidth - element.clientWidth > 1;
    const overflowsY = element.scrollHeight - element.clientHeight > 1;
    const next = {
      x: overflowsX
        ? { start: element.scrollLeft, view: element.clientWidth, total: element.scrollWidth }
        : null,
      y: overflowsY
        ? { start: element.scrollTop, view: element.clientHeight, total: element.scrollHeight }
        : null,
    };
    // Idempotent, because this is called from a scroll handler and from an
    // effect that a re-render can re-run: a fresh object every time would make
    // "measure after the picture changed" a render loop.
    setExtents((current) => (same(current.x, next.x) && same(current.y, next.y) ? current : next));
  }, [viewport]);

  const wake = useCallback(() => {
    setAwake(true);
    if (sleep.current) clearTimeout(sleep.current);
    sleep.current = setTimeout(() => setAwake(false), FADE_AFTER);
  }, []);

  useEffect(() => {
    return () => {
      if (sleep.current) clearTimeout(sleep.current);
    };
  }, []);

  /**
   * The thumbs are sized from the DOM rather than from anything React holds,
   * because the picture's size is a fact about a laid-out SVG and this
   * component is handed it as opaque `children`.
   *
   * Measured on mount and on every change of what is being shown, *and* by a
   * ResizeObserver. Not one or the other: the observer is the only thing that
   * sees the window being resized, and an initial observation is the one
   * delivery a browser is allowed to skip — a scrollbar that appears only once
   * something has already been scrolled is missing exactly when it is the only
   * sign there is more picture past the edge.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: scale and children are the triggers — see above.
  useEffect(measure, [measure, scale, children]);

  useEffect(() => {
    const element = viewport.current;
    const inner = content.current;
    if (!element || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [measure, viewport]);

  // Registered by hand: React's `onWheel` is passive at the root, so a
  // `preventDefault` inside it is dropped and the pane would scroll as well as
  // zoom.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // Without the modifier the wheel is the browser's: down the rig, and
      // sideways with shift. `ctrlKey` is also how a trackpad pinch arrives, so
      // this one test covers the gesture people reach for first.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = wheelPixels(event, element.clientHeight);
      const next = clampScale(scale * Math.exp(-delta * WHEEL_RATE));
      zoomSurface(element, scale, next, { x: event.clientX, y: event.clientY }, onScale);
      measure();
      wake();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [measure, onScale, scale, viewport, wake]);

  /**
   * Dragging the picture around.
   *
   * Mouse only: on a touchscreen the browser is already panning this element,
   * and a second implementation over the top of it moves everything twice. It
   * starts anywhere on the pane rather than on the background alone, so that a
   * drag begun over a box pans too — a box is a click target, not a handle —
   * and only the jack grips opt out, because a drag from one of those is a
   * cable being patched.
   */
  const [pan, setPan] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    const element = viewport.current;
    if (!pan || !element) return;
    const move = (event: PointerEvent) => {
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (!moved.current && Math.hypot(dx, dy) < PAN_SLOP) return;
      if (!moved.current) {
        // The pane goes `select-none` the moment a pointer lands, which stops a
        // drag from painting the labels blue — but a caret the pointerdown had
        // already dropped survives that, and the first real movement is the last
        // chance to clear it.
        window.getSelection()?.removeAllRanges();
      }
      moved.current = true;
      setPanning(true);
      element.scrollLeft = pan.left - dx;
      element.scrollTop = pan.top - dy;
    };
    const finish = () => {
      setPan(null);
      setPanning(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [pan, viewport]);

  const scrollTo = useCallback(
    (axis: Axis, start: number) => {
      const element = viewport.current;
      if (!element) return;
      if (axis === "x") element.scrollLeft = start;
      else element.scrollTop = start;
    },
    [viewport],
  );

  return (
    <div
      className="relative min-h-0 flex-1"
      onPointerEnter={() => setAwake(true)}
      onPointerLeave={() => setAwake(false)}
    >
      <div
        ref={viewport}
        data-testid="diagram-surface"
        // The platform's scrollbars are the thing being replaced. Both
        // properties are needed: Firefox and Chrome read different ones.
        className={cn(
          "h-full w-full overflow-auto overscroll-contain",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          panning ? "cursor-grabbing" : "cursor-grab",
          // From the pointer landing, not from the pan starting: by the time a
          // drag is long enough to be a pan the browser has already been
          // selecting for several frames. React flushes a pointerdown
          // synchronously, so this is on the element before the move arrives.
          pan && "select-none",
        )}
        onScroll={() => {
          measure();
          wake();
        }}
        onPointerDown={(event) => {
          const element = viewport.current;
          if (!element || event.pointerType !== "mouse") return;
          if (event.button !== 0 && event.button !== 1) return;
          if ((event.target as Element).closest("[data-port-grip]")) return;
          moved.current = false;
          setPan({
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          });
        }}
        // A pan ends over a box as often as over the background, and letting
        // that pointerup become a click would select whatever the picture
        // happened to slide under the cursor. Cleared by the next pointerdown,
        // which always precedes a click.
        onClickCapture={(event) => {
          if (!moved.current) return;
          event.stopPropagation();
          event.preventDefault();
        }}
      >
        {/* The fallbacks are what the server renders and what the first frame
            uses; `measure` replaces them with the real mat and cancels the
            move. */}
        <div
          ref={content}
          className="w-max min-w-full px-[var(--pad-x,16px)] py-[var(--pad-y,16px)]"
        >
          {children}
        </div>
      </div>

      {(["x", "y"] as const).map((axis) => {
        const extent = extents[axis];
        if (!extent) return null;
        return (
          <Scrollbar
            key={axis}
            axis={axis}
            extent={extent}
            visible={awake || holding !== null}
            held={holding === axis}
            onScrollTo={scrollTo}
            onHold={setHolding}
          />
        );
      })}
    </div>
  );
}

/**
 * One drawn scrollbar.
 *
 * Translucent and laid over the picture rather than taking a lane of its own,
 * so the drawing does not reflow the moment it grows one column too wide — with
 * a lane, gaining a horizontal bar would make the picture shorter, which can
 * hand it a vertical one as well.
 */
function Scrollbar({
  axis,
  extent,
  visible,
  held,
  onScrollTo,
  onHold,
}: Readonly<{
  axis: Axis;
  extent: Extent;
  visible: boolean;
  held: boolean;
  onScrollTo: (axis: Axis, start: number) => void;
  onHold: (axis: Axis | null) => void;
}>) {
  const horizontal = axis === "x";
  const track = Math.max(0, extent.view - THUMB_INSET * 2 - THUMB);
  const size = Math.max(MIN_THUMB, Math.min(track, (extent.view / extent.total) * track));
  const travel = Math.max(1, extent.total - extent.view);
  const offset = Math.round((extent.start / travel) * (track - size));

  const grip = useRef<{ at: number; start: number } | null>(null);

  useEffect(() => {
    if (!held) return;
    const move = (event: PointerEvent) => {
      const from = grip.current;
      if (!from || track <= size) return;
      const delta = (horizontal ? event.clientX : event.clientY) - from.at;
      onScrollTo(axis, from.start + (delta / (track - size)) * travel);
    };
    const finish = () => {
      grip.current = null;
      onHold(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [axis, held, horizontal, onHold, onScrollTo, size, track, travel]);

  return (
    <div
      data-scrollbar={axis}
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10 transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0",
        horizontal ? "right-0 bottom-0 left-0 h-3.5" : "top-0 right-0 bottom-0 w-3.5",
      )}
    >
      {/* Not a control: the pane underneath is a real scroll container, so the
          keyboard and the wheel-with-shift already reach everywhere this does. */}
      <div
        role="presentation"
        className={cn(
          "pointer-events-auto absolute rounded-full transition-colors",
          "bg-foreground/25 hover:bg-foreground/45",
          held && "bg-foreground/55",
          horizontal ? "cursor-ew-resize" : "cursor-ns-resize",
        )}
        style={
          horizontal
            ? { left: THUMB_INSET + offset, bottom: THUMB_INSET, width: size, height: THUMB }
            : { top: THUMB_INSET + offset, right: THUMB_INSET, width: THUMB, height: size }
        }
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // The pane below is listening for a pan; grabbing the bar is not one,
          // and it must not double as a click on the picture either.
          event.stopPropagation();
          event.preventDefault();
          grip.current = { at: horizontal ? event.clientX : event.clientY, start: extent.start };
          onHold(axis);
        }}
      />
    </div>
  );
}
