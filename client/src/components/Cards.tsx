import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { copy } from '../copy';

export type CardKey = 'hidden' | 'device' | 'zone' | 'history' | 'ask' | 'setup';
type Side = 'left' | 'right';
type Layout = Record<Side, CardKey[]>;
const LAYOUT_KEY = 'earshot.cards';
const KEYS: CardKey[] = ['hidden', 'device', 'zone', 'history', 'ask', 'setup'];
const SIDES: Side[] = ['left', 'right'];
// Ask on the left of the map, whatever is picked (or the setup tools) on the right.
const DEFAULT: Layout = { left: ['ask'], right: ['hidden', 'device', 'zone', 'history', 'setup'] };

function load(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<Layout> | null;
    const all = SIDES.flatMap((s) => saved?.[s] ?? []);
    if (all.length === KEYS.length && KEYS.every((k) => all.includes(k))) return { left: saved!.left!, right: saved!.right! };
  } catch {
    // Storage blocked or garbage: use the default layout.
  }
  return DEFAULT;
}

type Slot = { key: CardKey | null; side: Side; top: number; bottom: number; left: number; right: number };

// The cards either side of the map. Drag a card's handle and it snaps into whichever slot the
// pointer is over, on either side; a tap on the handle moves the card to the other side.
// Pointer events rather than HTML drag and drop, which Firefox refuses to start from a button
// and touch does not support. The layout is kept in this browser.
export function Cards({ cards }: { cards: Partial<Record<CardKey, ReactNode>> }) {
  const [layout, setLayout] = useState<Layout>(load);
  const [dragging, setDragging] = useState<CardKey | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Slots measured when the drag starts, so a reorder mid-drag does not move the targets.
  const drag = useRef<{ key: CardKey; startY: number; moved: boolean; slots: Slot[] } | null>(null);
  const shown = (side: Side) => layout[side].filter((k) => cards[k]);

  function save(next: Layout) {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the layout lasts for this page only.
    }
  }

  // Puts `from` before `to`, or at the end of `side` when `to` is null.
  function moveTo(from: CardKey, side: Side, to: CardKey | null) {
    if (from === to) return;
    const next: Layout = { left: layout.left.filter((k) => k !== from), right: layout.right.filter((k) => k !== from) };
    const i = to ? next[side].indexOf(to) : next[side].length;
    next[side].splice(i, 0, from);
    if (next.left.join() === layout.left.join() && next.right.join() === layout.right.join()) return;
    save(next);
  }

  function flip(k: CardKey) {
    moveTo(k, layout.left.includes(k) ? 'right' : 'left', null);
  }

  function down(k: CardKey, e: PointerEvent<HTMLSpanElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const slots: Slot[] = [];
    root.current?.querySelectorAll<HTMLElement>('[data-side]').forEach((col) => {
      const side = col.dataset.side as Side;
      col.querySelectorAll<HTMLElement>('[data-card]').forEach((el) => {
        const r = el.getBoundingClientRect();
        slots.push({ key: el.dataset.card as CardKey, side, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      });
      const r = col.getBoundingClientRect();
      // The column itself, after its cards: dropping below the last card appends.
      slots.push({ key: null, side, top: r.top, bottom: Math.max(r.bottom, window.innerHeight), left: r.left, right: r.right });
    });
    drag.current = { key: k, startY: e.clientY, moved: false, slots };
    setDragging(k);
  }

  function move(e: PointerEvent<HTMLSpanElement>) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.startY) < 6) return;
    d.moved = true;
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    const inColumn = d.slots.filter((s) => x >= s.left && x < s.right);
    const slot = inColumn.find((s) => y >= s.top && y < s.bottom) ?? inColumn.find((s) => s.key === null);
    if (slot) moveTo(d.key, slot.side, slot.key);
  }

  function up(e: PointerEvent<HTMLSpanElement>) {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (d && !d.moved) flip(d.key);
  }

  return (
    <div className="sides" ref={root}>
      {SIDES.map((side) => (
        <div key={side} className={`side ${side}`} data-side={side}>
          {shown(side).map((k) => (
            <aside key={k} data-card={k} className={`panel card-${k}${dragging === k ? ' dragging' : ''}`}>
              <span
                role="button"
                tabIndex={0}
                className="grip"
                aria-label={copy.cards.move}
                title={copy.cards.move}
                onPointerDown={(e) => down(k, e)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    flip(k);
                  }
                }}
              />
              {cards[k]}
            </aside>
          ))}
        </div>
      ))}
    </div>
  );
}
