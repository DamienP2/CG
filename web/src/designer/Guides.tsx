import { ChevronDown, Eye, EyeOff, Magnet, Move, Plus, Ruler, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { newId } from '../engine/evaluate';
import type { Area, Guides, Project } from '../engine/types';
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
type View = { safe: boolean; guides: boolean; snap: boolean; /** Safe areas and areas to keep clear moved on the stage (not kept). */ editSafe?: boolean };
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
    if (v.editSafe && !get().safe) set({ safe: true });
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
    for (const a of safeRects(g)) {
      x.push(a.x * w, (a.x + a.width) * w);
      y.push(a.y * h, (a.y + a.height) * h);
    }
  for (const e of g.exclusions) {
    x.push(e.x * w, (e.x + e.width) * w);
    y.push(e.y * h, (e.y + e.height) * h);
  }
  return { x, y };
}

const margin = (m: number): Area => ({ x: m, y: m, width: 1 - 2 * m, height: 1 - 2 * m });

/** Action safe and title safe: placed by hand, or from the margins. */
export function safeRects(g: Guides): [Area, Area] {
  return [g.actionArea ?? margin(g.actionSafe), g.titleArea ?? margin(g.titleSafe)];
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
      {view.safe && !view.editSafe && (
        <>
          {safeRects(g).map((a, i) => (
            <div key={i} className={`safe-area ${i ? 'title' : ''}`} style={pct(a)} title={i ? 'Title safe' : 'Action safe'} />
          ))}
          {g.exclusions.map((x) => (
            <div key={x.id} className="exclusion" style={pct(x)}>
              <span>{x.name}</span>
            </div>
          ))}
        </>
      )}
      {view.editSafe && (
        <RectEditor
          width={width * scale}
          height={height * scale}
          px={{ width, height }}
          rects={[
            { id: 'action', label: 'Action safe', kind: 'safe', area: safeRects(g)[0] },
            { id: 'title', label: 'Title safe', kind: 'title', area: safeRects(g)[1] },
            ...g.exclusions.map((x) => ({ id: x.id, label: x.name, kind: 'exclusion' as const, area: { x: x.x, y: x.y, width: x.width, height: x.height } })),
          ]}
          onChange={(id, a) =>
            setG(
              id === 'action'
                ? { ...g, actionArea: a }
                : id === 'title'
                  ? { ...g, titleArea: a }
                  : { ...g, exclusions: g.exclusions.map((x) => (x.id === id ? { ...x, ...a } : x)) },
            )
          }
          onDone={() => view.set({ editSafe: false })}
        />
      )}
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

const pct = (a: Area) => ({ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.width * 100}%`, height: `${a.height * 100}%` });

type Handle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const round = (v: number) => Math.round(v * 10000) / 10000;

/** Rectangles moved and resized on the stage (safe areas, areas to keep clear), like the zones. */
function RectEditor({
  width,
  height,
  px,
  rects,
  onChange,
  onDone,
}: {
  width: number;
  height: number;
  px: { width: number; height: number };
  rects: { id: string; label: string; kind: 'safe' | 'title' | 'exclusion'; area: Area }[];
  onChange: (id: string, a: Area) => void;
  onDone: () => void;
}) {
  const drag = useRef<{ id: string; mode: Handle; x: number; y: number; start: Area } | null>(null);
  const [draft, setDraft] = useState<{ id: string; area: Area } | null>(null);
  const draftRef = useRef(draft);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const step = e.shiftKey ? 0.01 : 0.001;
      const r = (v: number) => Math.round(v / step) * step;
      const dx = (e.clientX - d.x) / width;
      const dy = (e.clientY - d.y) / height;
      let { x, y, width: w, height: h } = d.start;
      if (d.mode === 'move') {
        x = Math.min(1 - w, Math.max(0, r(x + dx)));
        y = Math.min(1 - h, Math.max(0, r(y + dy)));
      } else {
        if (d.mode.includes('e')) w = Math.min(1 - x, Math.max(0.01, r(w + dx)));
        if (d.mode.includes('s')) h = Math.min(1 - y, Math.max(0.01, r(h + dy)));
        if (d.mode.includes('w')) {
          const nx = Math.max(0, Math.min(x + w - 0.01, r(x + dx)));
          w += x - nx;
          x = nx;
        }
        if (d.mode.includes('n')) {
          const ny = Math.max(0, Math.min(y + h - 0.01, r(y + dy)));
          h += y - ny;
          y = ny;
        }
      }
      draftRef.current = { id: d.id, area: { x, y, width: w, height: h } };
      setDraft(draftRef.current);
    };
    const up = () => {
      const d = drag.current;
      const cur = draftRef.current;
      drag.current = null;
      draftRef.current = null;
      setDraft(null);
      if (d && cur) onChange(cur.id, { x: round(cur.area.x), y: round(cur.area.y), width: round(cur.area.width), height: round(cur.area.height) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [width, height, onChange, onDone]);
  const begin = (e: React.PointerEvent, id: string, mode: Handle, area: Area) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = { id, mode, x: e.clientX, y: e.clientY, start: area };
  };
  return (
    <div className="rect-editor" onPointerDown={(e) => e.stopPropagation()}>
      {rects.map((r) => {
        const a = draft?.id === r.id ? draft.area : r.area;
        return (
          <div key={r.id} className={`re-box ${r.kind}`} style={pct(a)}>
            <span className="re-tab" title="Drag to move (Shift: 1 % steps)" onPointerDown={(e) => begin(e, r.id, 'move', a)}>
              <Move size={10} /> {r.label}
              {draft?.id === r.id && <em>{`${Math.round(a.x * px.width)}, ${Math.round(a.y * px.height)} · ${Math.round(a.width * px.width)}×${Math.round(a.height * px.height)}`}</em>}
            </span>
            {HANDLES.map((h) => (
              <span key={h} className={`zone-handle h-${h}`} onPointerDown={(e) => begin(e, r.id, h, a)} />
            ))}
          </div>
        );
      })}
      <button className="btn small primary re-done" onClick={onDone}>
        Done (Esc)
      </button>
    </div>
  );
}

/** A toolbar button whose main part shows / hides, and whose arrow opens the settings. */
export function SplitButton({ icon, label, on, onToggle, title, children, width = 300 }: { icon: React.ReactNode; label: string; on: boolean; onToggle: () => void; title: string; children: React.ReactNode; width?: number }) {
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="menu-wrap split-btn" onPointerDown={(e) => e.stopPropagation()}>
      <button className={`btn small ${on ? 'on' : 'off'}`} title={`${on ? 'Hide' : 'Show'} ${title}`} onClick={onToggle}>
        {on ? icon : <EyeOff size={13} />} {label}
      </button>
      <button
        className={`btn small split-arrow ${on ? 'on' : 'off'}`}
        title={`${title}: settings`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { left: Math.min(r.left - 80, window.innerWidth - width - 10), top: r.bottom + 6 });
        }}
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu guides-menu" style={{ position: 'fixed', left: open.left, top: open.top, width }} onClick={(e) => (e.target as HTMLElement).closest('[data-close]') && setOpen(null)}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Toolbar: rulers and guides (show / hide), snapping. */
export function GuidesMenu({ project }: { project: Project }) {
  const view = useGuidesView();
  const [g, setG] = useProjectGuides(project);
  return (
    <SplitButton icon={<Ruler size={13} />} label="Guides" on={view.guides} onToggle={() => view.set({ guides: !view.guides })} title="rulers and guides">
      <label className="zm-toggle">
        <input type="checkbox" checked={view.snap} onChange={(e) => view.set({ snap: e.target.checked })} />
        <Magnet size={12} /> Snap to guides, edges and areas (Alt to skip)
      </label>
      {g.vertical.length + g.horizontal.length > 0 ? (
        <button className="btn small" onClick={() => setG({ ...g, vertical: [], horizontal: [] })}>
          Remove the {g.vertical.length + g.horizontal.length} guides
        </button>
      ) : (
        <p className="hint">No guide yet.</p>
      )}
      <p className="hint">Drag a guide out of a ruler (Shift: 10 px steps); drag it back onto the ruler to remove it.</p>
    </SplitButton>
  );
}

/** Toolbar: safe areas and areas to keep clear (show / hide, edit on the stage, margins). */
export function SafeMenu({ project }: { project: Project }) {
  const view = useGuidesView();
  const [g, setG] = useProjectGuides(project);
  const W = project.width;
  const H = project.height;
  const pctv = (v: number) => Math.round(v * 1000) / 10;
  return (
    <SplitButton icon={<ShieldCheck size={13} />} label="Safe area" on={view.safe} onToggle={() => view.set({ safe: !view.safe, editSafe: false })} title="safe areas and areas to keep clear" width={330}>
      <button className={`btn small ${view.editSafe ? 'primary' : ''}`} data-close onClick={() => view.set({ editSafe: !view.editSafe })}>
        <Move size={13} /> {view.editSafe ? 'Done editing' : 'Edit on the stage'}
      </button>
      <div className="gm-row">
        <label title="Margin on every side; resets a safe area placed by hand">
          Action safe
          <input type="number" min={0} max={40} step={0.5} value={pctv(g.actionSafe)} onChange={(e) => setG({ ...g, actionSafe: Math.max(0, Math.min(40, +e.target.value)) / 100, actionArea: undefined })} />%
        </label>
        <label title="Margin on every side; resets a safe area placed by hand">
          Title safe
          <input type="number" min={0} max={40} step={0.5} value={pctv(g.titleSafe)} onChange={(e) => setG({ ...g, titleSafe: Math.max(0, Math.min(40, +e.target.value)) / 100, titleArea: undefined })} />%
        </label>
      </div>
      {(g.actionArea || g.titleArea) && <p className="hint">Placed by hand on the stage; a margin above puts it back in the centre.</p>}
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
            <input value={x.name} onChange={(e) => setG({ ...g, exclusions: g.exclusions.map((y) => (y.id === x.id ? { ...y, name: e.target.value } : y)) })} />
            <button className="icon-btn ghost" title="Remove" onClick={() => setG({ ...g, exclusions: g.exclusions.filter((y) => y.id !== x.id) })}>
              <Trash2 size={12} />
            </button>
          </div>
          <span className="muted small">
            {Math.round(x.x * W)}, {Math.round(x.y * H)} · {Math.round(x.width * W)}×{Math.round(x.height * H)} px
          </span>
        </div>
      ))}
      <p className="hint">
        <Eye size={11} /> In px of the main format ({W}×{H}). Edit on the stage to move and resize them.
      </p>
    </SplitButton>
  );
}
