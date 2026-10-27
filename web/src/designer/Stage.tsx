import { useTableEditor } from '../widgets/table-editor-store';
import { useShallow } from 'zustand/react/shallow';
import { settingDefaults } from '../engine/settings';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LiveTime, type Ticking } from '../engine/LiveTime';
import { Scene, Viewport } from '../engine/Scene';
import { defaultData, holdFrame, num, propValue } from '../engine/evaluate';
import { designTemplates } from '../engine/drafts';
import { inFormat } from '../engine/formats';
import { areaClip, zoneArea } from '../engine/zones';
import type { Layer, Project, Template } from '../engine/types';
import { findLayer, runAge, setProp, useDesigner } from './designerStore';
import { ZoneOverlay } from './ZoneOverlay';
import { useZoneEdit, ZonesEditOverlay } from './ZoneEditor';
import { ClipboardMenu, type ClipMenuAt } from './ClipboardMenu';
import { widgetOf } from '../widgets';
import { useBoundData } from '../data/dataStore';
import { snapShift, snapTargets, StageGuides, stageViewStyle, useGuidesView, useProjectGuides } from './Guides';
import { t, tn } from '../i18n';
import { useLiveFrame } from '../engine/liveInputs';

interface Box {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The boxes as they were when they did not change (no new state, no redraw). */
const same = (was: Box[], now: Box[]) => (was.length === now.length && was.every((b, i) => b.id === now[i].id && b.left === now[i].left && b.top === now[i].top && b.width === now[i].width && b.height === now[i].height) ? was : now);

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The canvas, at the size of the format being edited. */
export function Stage({ project: _project, size, showZones, background, bgInput }: { project: Project; size: { width: number; height: number }; showZones: boolean; background: string; /** The live input shown behind (« video » background). */ bgInput: string }) {
  const project = { ..._project, width: size.width, height: size.height };
  const { template, frame, previewData, selected, format } = useDesigner(useShallow((s) => ({ template: s.template, frame: s.frame, previewData: s.previewData, selected: s.selected, format: s.format })));
  // Bound fields show their live value, like on air.
  const bound = useBoundData(template, previewData);
  const data = useMemo(() => ({ ...bound, ...settingDefaults(template) }), [bound, template]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [boxes, setBoxes] = useState<Box[]>([]);
  // The other layers: a faint frame, so the template's layout reads at a glance.
  const [ghosts, setGhosts] = useState<Box[]>([]);
  // Right-click menu of the layer under the pointer (the timeline's, ClipboardMenu).
  const [ctx, setCtx] = useState<ClipMenuAt | null>(null);
  const widgetRun = useDesigner((s) => s.widgetRun);
  const widgetState = useDesigner((s) => s.widgetState);
  const running = Object.values(widgetRun).some((r) => r.pausedAge === undefined);
  const fps = project.frameRate.num / project.frameRate.den || 1;
  // Only the widgets that move redraw on each frame: all of them while a try-out runs, else those moving with the wall clock (a clock…).
  const ticking: Ticking = running ? 'all' : 'wall';
  const layerAge = useCallback((l: Layer, age: number, now: number) => (widgetRun[l.id] ? runAge(widgetRun[l.id], now) : age), [widgetRun]);
  const clocked = useCallback((l: Layer) => !!widgetRun[l.id], [widgetRun]);
  const stateOf = useCallback((id: string) => widgetState[id], [widgetState]);
  // Snapping targets, read by the drag handler.
  const [guides] = useProjectGuides(_project);
  const view = useGuidesView();
  const zonesEdit = useZoneEdit((s) => s.on);
  const snapRef = useRef({ on: view.snap, targets: snapTargets(guides, project.width, project.height, view.safe) });
  snapRef.current = { on: view.snap, targets: snapTargets(guides, project.width, project.height, view.safe) };

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const pad = 48;
      setScale(Math.max(0.05, Math.min((el.clientWidth - pad) / project.width, (el.clientHeight - pad) / project.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The overview and a template have their own stage element.
  }, [project.width, project.height, !!template]);

  // Selection boxes come from the DOM so they follow nested transforms.
  useLayoutEffect(() => {
    const root = sceneRef.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const box = (id: string, el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { id, left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
    };
    // Kept when nothing moved (a playback where these layers stand still): the stage is not drawn twice per frame.
    setGhosts((was) =>
      same(
        was,
        [...root.querySelectorAll<HTMLElement>('[data-layer-id]')]
          .filter((el) => !selected.includes(el.dataset.layerId!))
          .map((el) => box(el.dataset.layerId!, el))
          .filter((b) => b.width > 0 && b.height > 0),
      ),
    );
    setBoxes((was) =>
      same(
        was,
        selected.flatMap((id) => {
          const el = root.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(id)}"]`);
          if (!el) return [];
          const r = el.getBoundingClientRect();
          return [{ id, left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height }];
        }),
      ),
    );
  }, [selected, template, frame, scale, previewData]);

  const drag = useRef<{
    mode: 'move' | Handle;
    startX: number;
    startY: number;
    start: Record<string, { x: number; y: number; w: number; h: number; ox: number; oy: number }>;
  } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      const st = useDesigner.getState();
      if (!d || !st.template) return;
      let dx = (e.clientX - d.startX) / scale;
      let dy = (e.clientY - d.startY) / scale;
      // Shift while moving: one axis only, the one moved the most.
      const axis = d.mode === 'move' && e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y') : null;
      const snap = e.shiftKey && d.mode !== 'move' ? 10 : 1;
      const r = (v: number) => Math.round(v / snap) * snap;
      // Snap the box's edges (and centre when moving) to the guides, edges and areas.
      const first = Object.values(d.start)[0];
      if (first && snapRef.current.on && !e.altKey) {
        const { x: tx, y: ty } = snapRef.current.targets;
        const th = 6 / scale;
        // In a group, x / y are from the group: the guides are on the stage.
        const nx = first.ox + first.x + dx;
        const ny = first.oy + first.y + dy;
        if (d.mode === 'move') {
          dx += snapShift([nx, nx + first.w / 2, nx + first.w], tx, th);
          dy += snapShift([ny, ny + first.h / 2, ny + first.h], ty, th);
        } else {
          if (d.mode.includes('e')) dx += snapShift([nx + first.w], tx, th);
          if (d.mode.includes('w')) dx += snapShift([nx], tx, th);
          if (d.mode.includes('s')) dy += snapShift([ny + first.h], ty, th);
          if (d.mode.includes('n')) dy += snapShift([ny], ty, th);
        }
      }
      if (axis === 'x') dy = 0;
      if (axis === 'y') dx = 0;
      st.update((t) => {
        for (const [id, s] of Object.entries(d.start)) {
          const l = findLayer(t, id);
          if (!l || l.locked) continue;
          if (d.mode === 'move') {
            setProp(l, 'x', r(s.x + dx), st.frame);
            setProp(l, 'y', r(s.y + dy), st.frame);
            continue;
          }
          let { x, y, w, h } = s;
          if (d.mode.includes('e')) w = Math.max(1, r(s.w + dx));
          if (d.mode.includes('s')) h = Math.max(1, r(s.h + dy));
          if (d.mode.includes('w')) {
            w = Math.max(1, r(s.w - dx));
            x = s.x + (s.w - w);
          }
          if (d.mode.includes('n')) {
            h = Math.max(1, r(s.h - dy));
            y = s.y + (s.h - h);
          }
          // Width / height locked: the ratio stays (a corner follows the side moved the most).
          if (l.lockRatio && s.w > 0 && s.h > 0) {
            const k = s.w / s.h;
            const horiz = /[ew]/.test(d.mode);
            const vert = /[ns]/.test(d.mode);
            if (horiz && (!vert || Math.abs(w - s.w) / s.w >= Math.abs(h - s.h) / s.h)) h = Math.max(1, Math.round(w / k));
            else w = Math.max(1, Math.round(h * k));
            if (d.mode.includes('w')) x = s.x + (s.w - w);
            if (d.mode.includes('n')) y = s.y + (s.h - h);
          }
          if (x !== s.x) setProp(l, 'x', x, st.frame);
          if (y !== s.y) setProp(l, 'y', y, st.frame);
          if (w !== s.w) setProp(l, 'width', w, st.frame);
          if (h !== s.h) setProp(l, 'height', h, st.frame);
        }
      }, 'stage-drag');
    };
    const onUp = () => (drag.current = null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [scale]);

  const beginDrag = (e: React.PointerEvent, mode: 'move' | Handle, ids: string[]) => {
    const st = useDesigner.getState();
    if (!st.template) return;
    const start: Record<string, { x: number; y: number; w: number; h: number; ox: number; oy: number }> = {};
    for (const id of ids) {
      const l = findLayer(st.template, id);
      if (!l) continue;
      // Where its group is on the stage.
      let ox = 0;
      let oy = 0;
      const seen = new Set<string>();
      for (let p = l.parent ? findLayer(st.template, l.parent) : undefined; p && !seen.has(p.id); p = p.parent ? findLayer(st.template, p.parent) : undefined) {
        seen.add(p.id);
        ox += num(propValue(p, 'x', st.frame));
        oy += num(propValue(p, 'y', st.frame));
      }
      start[id] = {
        ox,
        oy,
        x: num(propValue(l, 'x', st.frame)),
        y: num(propValue(l, 'y', st.frame)),
        w: num(propValue(l, 'width', st.frame)),
        h: num(propValue(l, 'height', st.frame)),
      };
    }
    drag.current = { mode, startX: e.clientX, startY: e.clientY, start };
    useDesigner.setState({ lastCoalesce: null });
    e.stopPropagation();
  };

  // The layer under the pointer: the one drawn there, else one whose box is there but which its group's
  // mask cuts (not drawn outside it, so not under the pointer for the page).
  const layerAt = (e: { target: EventTarget; clientX: number; clientY: number }) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-layer-id]');
    if (hit) return hit.dataset.layerId;
    const els = [...(sceneRef.current?.querySelectorAll<HTMLElement>('[data-layer-id]') ?? [])];
    for (let i = els.length - 1; i >= 0; i--) {
      const r = els[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return els[i].dataset.layerId;
    }
    return undefined;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const st = useDesigner.getState();
    const id = layerAt(e);
    if (!id) {
      st.select([]);
      return;
    }
    const l = st.template && findLayer(st.template, id);
    // Right button: the layer is selected for its menu (onContextMenu), not dragged.
    if (e.button === 2) {
      if (!st.selected.includes(id)) st.select([id]);
      return;
    }
    if (l?.locked) return;
    // Pressed beside the picture: no text of the page gets selected while dragging.
    e.preventDefault();
    let sel = st.selected;
    if (e.shiftKey) sel = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
    else if (!sel.includes(id)) sel = [id];
    st.select(sel);
    beginDrag(e, 'move', sel);
  };

  // A double-click on a Table opens its editor.
  const onDoubleClick = (e: React.MouseEvent) => {
    const id = layerAt(e);
    const st = useDesigner.getState();
    const l = id && st.template ? findLayer(st.template, id) : undefined;
    if (l?.type === 'table' && !l.locked) useTableEditor.getState().open(l.id);
  };

  // Program, fill or key, for the whole stage (canvas toolbar).
  const shown = stageViewStyle(view.stageView, background);
  if (!template) return <Overview project={_project} size={project} format={format} scale={scale} background={shown.background} bgInput={bgInput} filter={shown.filter} showZones={showZones} wrapRef={wrapRef} ticking={running ? 'all' : false} fps={fps} />;

  return (
    // Around the picture too: a layer dragged out of it is still picked there (or nothing: deselects).
    <div className="stage-wrap" ref={wrapRef} onPointerDown={onPointerDown}>
      <div className={`stage-frame bg-${shown.background}`} onPointerDown={(e) => e.stopPropagation()}>
        {shown.background === 'video' && <StageVideo input={bgInput} />}
        <div
          ref={sceneRef}
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => {
            const id = layerAt(e);
            if (!id) return;
            e.preventDefault();
            const st = useDesigner.getState();
            if (!st.selected.includes(id)) st.select([id]);
            setCtx({ x: e.clientX, y: e.clientY, layerId: id });
          }}
          style={{ position: 'relative' }}
        >
          <Viewport width={project.width} height={project.height} scale={scale} style={{ overflow: 'visible' }}>
            {/* Widgets run on the playhead: scrub to see a ticker or a counter move. */}
            <LiveTime ageSecs={frame / fps} ticking={ticking} layerAge={layerAge} clocked={clocked} widgetState={stateOf} fps={fps} lang={_project.language || 'fr'}>
              <div style={{ position: 'absolute', inset: 0, filter: shown.filter }}>
                <Scene template={template} frame={frame} data={data} interactive />
              </div>
            </LiveTime>
          </Viewport>
          {/* What is outside the picture still shows, greyed (it is cut on air). */}
          <div className="stage-outside" aria-hidden>
            <i style={{ left: -5000, top: -5000, width: 10000 + project.width * scale, height: 5000 }} />
            <i style={{ left: -5000, top: project.height * scale, width: 10000 + project.width * scale, height: 5000 }} />
            <i style={{ left: -5000, top: 0, width: 5000, height: project.height * scale }} />
            <i style={{ left: project.width * scale, top: 0, width: 5000, height: project.height * scale }} />
          </div>
          <StageGuides project={_project} width={project.width} height={project.height} scale={scale} frameRef={sceneRef} />
          {zonesEdit ? <ZonesEditOverlay format={format} width={project.width} height={project.height} scale={scale} /> : showZones && <ZoneOverlay zones={_project.zones ?? []} only={template.zone} format={format} width={project.width} height={project.height} scale={scale} current={template.zone} />}
          {view.frames && ghosts.map((b) => (
            <div key={`g${b.id}`} className="ghost-box" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
          ))}
          {boxes.map((b) => (
            <div key={b.id} className="sel-box" style={{ left: b.left, top: b.top, width: b.width, height: b.height }}>
              {selected.length === 1 && HANDLES.map((h) => <div key={h} className={`handle h-${h}`} onPointerDown={(e) => beginDrag(e, h, [b.id])} />)}
              {selected.length === 1 && <WidgetOverlay layerId={b.id} box={b} frame={frame} />}
            </div>
          ))}
        </div>
      </div>
      <div className="stage-info">
        {project.width}×{project.height} · {Math.round(scale * 100)}%
      </div>
      {/* Its clicks do not reach the stage (which would drop the selection). */}
      {ctx && (
        <div onPointerDown={(e) => e.stopPropagation()}>
          <ClipboardMenu at={ctx} onClose={() => setCtx(null)} />
        </div>
      )}
    </div>
  );
}

/** Handles of a spec widget (web/src/widgets) over its selection box. */
function WidgetOverlay({ layerId, box, frame }: { layerId: string; box: Box; frame: number }) {
  const { template, update } = useDesigner(useShallow((s) => ({ template: s.template, update: s.update })));
  const layer = template && findLayer(template, layerId);
  const Ov = layer && widgetOf(layer)?.Overlay;
  if (!layer || !Ov) return null;
  const w = num(propValue(layer, 'width', frame));
  const h = num(propValue(layer, 'height', frame));
  const edit = (fn: (l: never) => void, key?: string) => update((t) => fn(findLayer(t, layerId)! as never), key);
  return (
    <div className="wk-overlay">
      <Ov layer={layer as never} w={w} h={h} scale={w > 0 ? box.width / w : 1} edit={edit} />
    </div>
  );
}

/**
 * No template open: every template of the project at its on-air point,
 * each cut to its zone, over the zones. Clicking a graphic opens its
 * template; Esc in a template comes back here.
 */
function Overview({
  project,
  size,
  format,
  scale,
  background,
  bgInput,
  filter,
  showZones,
  wrapRef,
  ticking,
  fps,
}: {
  project: Project;
  size: { width: number; height: number };
  format: string;
  scale: number;
  background: string;
  bgInput: string;
  filter?: string;
  showZones: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  ticking: Ticking;
  fps: number;
}) {
  const load = useDesigner((s) => s.load);
  const zonesEdit = useZoneEdit((s) => s.on);
  const sceneRef = useRef<HTMLDivElement>(null);
  const portrait = size.height > size.width;
  const zones = new Map(project.zones.map((z) => [z.id, z]));
  const templates = [...designTemplates(project)].sort((a, b) => (zones.get(a.zone)?.layer ?? 0) - (zones.get(b.zone)?.layer ?? 0));
  return (
    <div className="stage-wrap" ref={wrapRef}>
      <div className={`stage-frame bg-${background}`}>
        {background === 'video' && <StageVideo input={bgInput} />}
        <div
          ref={sceneRef}
          className="overview"
          style={{ position: 'relative' }}
          onPointerDown={(e) => {
            const id = (e.target as HTMLElement).closest<HTMLElement>('[data-template-id]')?.dataset.templateId;
            const t = id && templates.find((x) => x.id === id);
            if (t) load(t);
          }}
        >
          <Viewport width={size.width} height={size.height} scale={scale} style={{ filter }}>
            {templates.map((tpl) => {
              const z = zones.get(tpl.zone);
              return (
                <div key={tpl.id} className="overview-tpl" data-template-id={tpl.id} title={t('{name} — click to open', { name: tpl.name })} style={{ position: 'absolute', inset: 0, ...areaClip(z && zoneArea(z, format, portrait)) }}>
                  <OverviewScene template={tpl} format={format} ticking={ticking} fps={fps} lang={project.language || 'fr'} />
                </div>
              );
            })}
          </Viewport>
          <StageGuides project={project} width={size.width} height={size.height} scale={scale} frameRef={sceneRef} />
          {zonesEdit ? <ZonesEditOverlay format={format} width={size.width} height={size.height} scale={scale} /> : showZones && <ZoneOverlay zones={project.zones ?? []} format={format} width={size.width} height={size.height} scale={scale} current="" />}
        </div>
      </div>
      <div className="stage-info">
        {tn(templates.length, '{n} template', '{n} templates')} · {size.width}×{size.height} · {Math.round(scale * 100)}%
      </div>
    </div>
  );
}

/**
 * One template of the overview, drawn as the open template draws it: its
 * default values, bound fields and data sets read like on air, its settings.
 */
function OverviewScene({ template, format, ticking, fps, lang }: { template: Template; format: string; ticking: Ticking; fps: number; lang?: string }) {
  const defaults = useMemo(() => defaultData(template), [template]);
  const bound = useBoundData(template, defaults);
  const data = useMemo(() => ({ ...bound, ...settingDefaults(template) }), [bound, template]);
  const shown = useMemo(() => inFormat(template, format), [template, format]);
  const hold = holdFrame(template);
  return (
    <LiveTime ageSecs={hold / fps} ticking={ticking} fps={fps} lang={lang}>
      <Scene template={shown} frame={hold} data={data} interactive />
    </LiveTime>
  );
}

/** A live video input behind the stage, filling it. */
function StageVideo({ input }: { input: string }) {
  const { url } = useLiveFrame(input, 'preview');
  return url ? <img className="stage-video" src={url} alt="" draggable={false} /> : null;
}
