import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

// Pan and zoom for an svg with a fixed plan size, driven by its viewBox.
// The box is kept in a ref and written straight to the element so a drag does
// not re-render the few hundred nodes of the plan on every pointer move.
export type ViewBox = { x: number; y: number; w: number; h: number };

const MAX_ZOOM = 8;
const DRAG_PX = 4;

export function usePanZoom(planW: number, planH: number) {
  const svg = useRef<SVGSVGElement>(null);
  const box = useRef<ViewBox>({ x: 0, y: 0, w: planW, h: planH });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(0);
  const dragged = useRef(false);

  const apply = () => {
    const b = box.current;
    svg.current?.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
  };

  const clamp = (b: ViewBox): ViewBox => {
    const w = Math.min(planW, Math.max(planW / MAX_ZOOM, b.w));
    const h = (w * planH) / planW;
    return { x: Math.min(planW - w, Math.max(0, b.x)), y: Math.min(planH - h, Math.max(0, b.y)), w, h };
  };

  // The svg uses the default "meet" fit, so one axis is letterboxed.
  const fit = () => {
    const r = svg.current!.getBoundingClientRect();
    const b = box.current;
    const s = Math.min(r.width / b.w, r.height / b.h);
    return { r, s, ox: (r.width - b.w * s) / 2, oy: (r.height - b.h * s) / 2 };
  };

  const toPlan = (clientX: number, clientY: number) => {
    const { r, s, ox, oy } = fit();
    return { x: box.current.x + (clientX - r.left - ox) / s, y: box.current.y + (clientY - r.top - oy) / s };
  };

  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    const b = box.current;
    const p = toPlan(clientX, clientY);
    box.current = clamp({ x: p.x - (p.x - b.x) * factor, y: p.y - (p.y - b.y) * factor, w: b.w * factor, h: b.h * factor });
    apply();
  };

  const panBy = (dxPx: number, dyPx: number) => {
    const { s } = fit();
    const b = box.current;
    box.current = clamp({ ...b, x: b.x - dxPx / s, y: b.y - dyPx / s });
    apply();
  };

  const zoomBy = (factor: number) => {
    const r = svg.current!.getBoundingClientRect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  };

  // A landscape box gets the whole plan across its width, with empty bands
  // above and below. A portrait box (a phone) would make the names unreadable
  // at that scale, so it gets the middle of the plan at full height and pans
  // for the rest.
  const reset = () => {
    const r = svg.current?.getBoundingClientRect();
    const aspect = r && r.height > 0 ? r.width / r.height : planW / planH;
    const w = aspect >= 1 ? planW : Math.min(planW, planH * aspect);
    const h = aspect >= 1 ? planW / aspect : (w * planH) / planW;
    box.current = { x: (planW - w) / 2, y: (planH - h) / 2, w, h };
    apply();
  };

  // React registers wheel listeners as passive, so the page would still zoom
  // on ctrl+wheel; a native listener can prevent that.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    reset();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      // A trackpad pinch arrives as ctrl+wheel with small deltas.
      const k = e.ctrlKey ? 0.01 : 0.0015;
      zoomAt(Math.exp(e.deltaY * lines * k), e.clientX, e.clientY);
    };
    const swallow = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', swallow);
    el.addEventListener('gesturechange', swallow);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', swallow);
      el.removeEventListener('gesturechange', swallow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      moved.current = 0;
      dragged.current = false;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    const pts = [...pointers.current.entries()];
    if (pts.length === 1) {
      moved.current += Math.abs(next.x - prev.x) + Math.abs(next.y - prev.y);
      if (moved.current > DRAG_PX) dragged.current = true;
      if (dragged.current) panBy(next.x - prev.x, next.y - prev.y);
    } else if (pts.length === 2) {
      dragged.current = true;
      const other = pts.find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      panBy((next.x - prev.x) / 2, (next.y - prev.y) / 2);
      if (before > 0 && after > 0) zoomAt(before / after, (next.x + other.x) / 2, (next.y + other.y) / 2);
    }
    pointers.current.set(e.pointerId, next);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
  };

  // A click that ends a drag must not select a zone.
  const onClickCapture = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (dragged.current) {
      e.stopPropagation();
      dragged.current = false;
    }
  };

  const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) => zoomAt(0.5, e.clientX, e.clientY);

  return {
    svg,
    zoomBy,
    reset,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClickCapture, onDoubleClick },
  };
}
