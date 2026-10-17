import { ChevronDown, Magnet, Plus, Ruler, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { newId } from '../engine/evaluate';
import type { Guides, Project } from '../engine/types';
import { api, useApp } from '../store';

/*
 * Designer aids: rulers, guides (dragged out of the rulers, back onto them
 * to remove), snapping, safe areas and areas to keep clear (a channel bug,
 * a sign language box). Guides and areas belong to the project, as
 * fractions of the picture so they hold in every format; what is shown
 * is a per-browser choice.
 */

export const DEFAULT_GUIDES: Guides = { vertical: [], horizontal: [], actionSafe: 0.05, titleSafe: 0.1, exclusions: [] };

const VIEW_KEY = 'pulse.guidesView';
type View = { safe: boolean; guides: boolean; snap: boolean };
function loadView(): View {
  try {
    return { safe: true, guides: true, snap: true, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') };
  } catch {
    return { safe: true, guides: true, snap: true };
  }
}
export const useGuidesView = create<View & { set: (v: Partial<View>) => void }>((set, get) => ({
  ...loadView(),
  set(v) {
    set(v);
    const { safe, guides, snap } = get();
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ safe, guides, snap }));
    } catch {
      /* private mode */
    }
  },
}));

/** Guides being edited, shared by the stage and the menu until saved. */
const useDraft = create<{ id: string | null; g: Guides | null }>(() => ({ id: null, g: null }));
let pending: ReturnType<typeof setTimeout> | undefined;

/** The project's guides, edited locally and saved a moment later. */
export function useProjectGuides(project: Project): [Guides, (g: Guides) => void] {
  const toast = useApp((s) => s.toast);
  const draft = useDraft();
  const saved = JSON.stringify(project.guides ?? DEFAULT_GUIDES);
  useEffect(() => {
    if (!pending) useDraft.setState({ id: project.id, g: JSON.parse(saved) });
  }, [saved, project.id]);
  const g = draft.id === project.id && draft.g ? draft.g : (JSON.parse(saved) as Guides);
  const update = (next: Guides) => {
    useDraft.setState({ id: project.id, g: next });
    clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      api('PUT', `/api/projects/${encodeURIComponent(project.id)}/guides`, next).catch((e) => toast((e as Error).message, 'error'));
    }, 400);
  };
  return [g, update];
}

/**
 * Snapping: the smallest shift that brings one of `edges` (px) onto one
 * of `targets` (px) within `threshold`, or 0.
 */
export function snapShift(edges: number[], targets: number[], threshold: number): number {
  let best = 0;
  let bestD = threshold;
  for (const e of edges)
    for (const t of targets) {
      const d = Math.abs(t - e);
      if (d < bestD) {
        bestD = d;
        best = t - e;
      }
    }
  return best;
}

/** What layers snap to, in px: the frame, its centre, the guides, safe areas and areas to keep clear. */
export function snapTargets(g: Guides, w: number, h: number, safe: boolean): { x: number[]; y: number[] } {
  const x = [0, w / 2, w, ...g.vertical.map((v) => v * w)];
  const y = [0, h / 2, h, ...g.horizontal.map((v) => v * h)];
  if (safe)
    for (const m of [g.actionSafe, g.titleSafe]) {
      x.push(m * w, w - m * w);
      y.push(m * h, h - m * h);
    }
  for (const e of g.exclusions) {
    x.push(e.x * w, (e.x + e.width) * w);
    y.push(e.y * h, (e.y + e.height) * h);
  }
  return { x, y };
}

const STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** A ruler along the top (x) or the left (y) of the stage. */
function RulerBar({ axis, length, scale, onGuide }: { axis: 'x' | 'y'; length: number; scale: number; onGuide: (e: React.PointerEvent) => void }) {
  const step = STEPS.find((s) => s * scale >= 60) ?? 1000;
  const ticks = [];
  for (let v = 0; v <= length; v += step) ticks.push(v);
  return (
    <div className={`ruler ruler-${axis}`} style={axis === 'x' ? { width: length * scale } : { height: length * scale }} onPointerDown={onGuide} title="Drag out a guide">
      {ticks.map((v) => (
        <span key={v} className="ruler-tick" style={axis === 'x' ? { left: v * scale } : { top: v * scale }}>
          {v}
        </span>
      ))}
    </div>
  );
}

/**
 * Rulers, guides, safe areas and areas to keep clear over the stage.
 * `frameRef` is the stage frame the positions are relative to.
 */
export function StageGuides({ project, width, height, scale, frameRef }: { project: Project; width: number; height: number; scale: number; frameRef: React.RefObject<HTMLDivElement | null> }) {
  const view = useGuidesView();
  const [g, setG] = useProjectGuides(project);

  /** Drags guide `i` of `axis` (a new one when i = -1); out of the picture removes it. */
  const dragGuide = (e: React.PointerEvent, axis: 'vertical' | 'horizontal', index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const frame = frameRef.current;
    if (!frame) return;
    const list = [...g[axis]];
    let i = index;
    if (i < 0) {
      list.push(-1);
      i = list.length - 1;
    }
    const at = (ev: PointerEvent | React.PointerEvent) => {
      const r = frame.getBoundingClientRect();
      return axis === 'vertical' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
    };
    let current = { ...g, [axis]: list };
    const move = (ev: PointerEvent) => {
      const f = at(ev);
      const px = axis === 'vertical' ? width : height;
      // Whole pixels; Shift snaps to 10 px.
      const snap = ev.shiftKey ? 10 : 1;
      const v = Math.round((f * px) / snap) * snap;
      const next = [...current[axis]];
      next[i] = v / px;
      current = { ...current, [axis]: next };
      setG(current);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const f = at(ev);
      if (f < 0 || f > 1) setG({ ...current, [axis]: current[axis].filter((_, k) => k !== i) });
      document.body.classList.remove('dragging-guide');
    };
    document.body.classList.add('dragging-guide');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      {view.safe && (
        <>
          <div className="safe-area" style={{ inset: `${g.actionSafe * 100}%` }} title="Action safe" />
          <div className="safe-area title" style={{ inset: `${g.titleSafe * 100}%` }} title="Title safe" />
        </>
      )}
      {g.exclusions.map((x) => (
        <div key={x.id} className="exclusion" style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%`, width: `${x.width * 100}%`, height: `${x.height * 100}%` }}>
          <span>{x.name}</span>
        </div>
      ))}
      {view.guides && (
        <>
          {/* As in Photoshop: the top ruler gives horizontal guides, the left one vertical guides. */}
          <RulerBar axis="x" length={width} scale={scale} onGuide={(e) => dragGuide(e, 'horizontal', -1)} />
          <RulerBar axis="y" length={height} scale={scale} onGuide={(e) => dragGuide(e, 'vertical', -1)} />
          {g.vertical.map((v, i) =>
            v >= 0 && v <= 1 ? (
              <div key={`v${i}`} className="guide v" style={{ left: `${v * 100}%` }} onPointerDown={(e) => dragGuide(e, 'vertical', i)}>
                <span>{Math.round(v * width)}</span>
              </div>
            ) : null,
          )}
          {g.horizontal.map((v, i) =>
            v >= 0 && v <= 1 ? (
              <div key={`h${i}`} className="guide h" style={{ top: `${v * 100}%` }} onPointerDown={(e) => dragGuide(e, 'horizontal', i)}>
                <span>{Math.round(v * height)}</span>
              </div>
            ) : null,
          )}
        </>
      )}
    </>
  );
}

/** Toolbar menu: show safe areas / guides, snapping, margins and areas to keep clear. */
export function GuidesMenu({ project }: { project: Project }) {
  const view = useGuidesView();
  const [g, setG] = useProjectGuides(project);
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const W = project.width;
  const H = project.height;
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const setX = (id: string, patch: Partial<Guides['exclusions'][number]>) => setG({ ...g, exclusions: g.exclusions.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  return (
    <div className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button
        className={`btn small ${view.safe || view.guides ? 'on' : ''}`}
        title="Rulers, guides, snapping, safe areas and areas to keep clear"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { left: Math.min(r.left, window.innerWidth - 340), top: r.bottom + 6 });
        }}
      >
        <Ruler size={13} /> Guides <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu guides-menu" style={{ position: 'fixed', left: open.left, top: open.top }}>
          <label className="zm-toggle">
            <input type="checkbox" checked={view.guides} onChange={(e) => view.set({ guides: e.target.checked })} />
            Rulers and guides
          </label>
          <label className="zm-toggle">
            <input type="checkbox" checked={view.snap} onChange={(e) => view.set({ snap: e.target.checked })} />
            <Magnet size={12} /> Snap to guides, edges and areas (Alt to skip)
          </label>
          <label className="zm-toggle">
            <input type="checkbox" checked={view.safe} onChange={(e) => view.set({ safe: e.target.checked })} />
            Safe areas
          </label>
          <div className="gm-row">
            <label>
              Action safe
              <input type="number" min={0} max={40} step={0.5} value={pct(g.actionSafe)} onChange={(e) => setG({ ...g, actionSafe: Math.max(0, Math.min(40, +e.target.value)) / 100 })} />%
            </label>
            <label>
              Title safe
              <input type="number" min={0} max={40} step={0.5} value={pct(g.titleSafe)} onChange={(e) => setG({ ...g, titleSafe: Math.max(0, Math.min(40, +e.target.value)) / 100 })} />%
            </label>
          </div>
          <div className="gm-title">
            Areas to keep clear
            <button
              className="icon-btn ghost"
              title="Add an area (a channel bug top right)"
              onClick={() => setG({ ...g, exclusions: [...g.exclusions, { id: newId(), name: 'Channel bug', x: 0.85, y: 0.05, width: 0.1, height: 0.09 }] })}
            >
              <Plus size={13} />
            </button>
          </div>
          {!g.exclusions.length && <p className="hint">None. Add the channel bug, a clock or a sign language box: graphics snap around them.</p>}
          {g.exclusions.map((x) => (
            <div key={x.id} className="gm-excl">
              <div className="row">
                <input value={x.name} onChange={(e) => setX(x.id, { name: e.target.value })} />
                <button className="icon-btn ghost" title="Remove" onClick={() => setG({ ...g, exclusions: g.exclusions.filter((y) => y.id !== x.id) })}>
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="gm-xywh">
                {(
                  [
                    ['X', 'x', W],
                    ['Y', 'y', H],
                    ['W', 'width', W],
                    ['H', 'height', H],
                  ] as const
                ).map(([label, key, size]) => (
                  <label key={key}>
                    {label}
                    <input type="number" value={Math.round(x[key] * size)} onChange={(e) => setX(x.id, { [key]: Math.max(0, +e.target.value) / size })} />
                  </label>
                ))}
              </div>
            </div>
          ))}
          {(g.vertical.length > 0 || g.horizontal.length > 0) && (
            <button className="btn small" onClick={() => setG({ ...g, vertical: [], horizontal: [] })}>
              Remove the {g.vertical.length + g.horizontal.length} guides
            </button>
          )}
          <p className="hint">Drag a guide out of a ruler; drag it back onto the ruler to remove it. In px of the main format ({W}×{H}).</p>
        </div>
      )}
    </div>
  );
}
