import { settingDefaults } from '../engine/settings';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LiveTime, useTicker } from '../engine/LiveTime';
import { hasLiveWidgets, Scene, Viewport } from '../engine/Scene';
import { defaultData, holdFrame, num, propValue } from '../engine/evaluate';
import { designTemplates } from '../engine/drafts';
import { inFormat } from '../engine/formats';
import { areaClip, zoneArea } from '../engine/zones';
import type { Project } from '../engine/types';
import { findLayer, runAge, setProp, useDesigner } from './designerStore';
import { ZoneOverlay } from './ZoneOverlay';
import { widgetOf } from '../widgets';
import { useBoundData } from '../data/dataStore';
import { snapShift, snapTargets, StageGuides, useGuidesView, useProjectGuides } from './Guides';

interface Box {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The canvas, at the size of the format being edited. */
export function Stage({ project: _project, size, showZones, background }: { project: Project; size: { width: number; height: number }; showZones: boolean; background: string }) {
  const project = { ..._project, width: size.width, height: size.height };
  const { template, frame, previewData, selected, format } = useDesigner();
  // Bound fields show their live value, like on air.
  const bound = useBoundData(template, previewData);
  const data = useMemo(() => ({ ...bound, ...settingDefaults(template) }), [bound, template]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [boxes, setBoxes] = useState<Box[]>([]);
  // The other layers: a faint frame, so the template's layout reads at a glance.
  const [ghosts, setGhosts] = useState<Box[]>([]);
  const widgetRun = useDesigner((s) => s.widgetRun);
  const widgetState = useDesigner((s) => s.widgetState);
  const running = Object.values(widgetRun).some((r) => r.pausedAge === undefined);
  const now = useTicker((!!template && hasLiveWidgets(template)) || running);
  const fps = project.frameRate.num / project.frameRate.den || 1;
  // Snapping targets, read by the drag handler.
  const [guides] = useProjectGuides(_project);
  const view = useGuidesView();
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
    setGhosts(
      [...root.querySelectorAll<HTMLElement>('[data-layer-id]')]
        .filter((el) => !selected.includes(el.dataset.layerId!))
        .map((el) => box(el.dataset.layerId!, el))
        .filter((b) => b.width > 0 && b.height > 0),
    );
    setBoxes(
      selected.flatMap((id) => {
        const el = root.querySelector<HTMLElement>(`[data-layer-id="${CSS.escape(id)}"]`);
        if (!el) return [];
        const r = el.getBoundingClientRect();
        return [{ id, left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height }];
      }),
    );
  }, [selected, template, frame, scale, previewData]);

  const drag = useRef<{
    mode: 'move' | Handle;
    startX: number;
    startY: number;
    start: Record<string, { x: number; y: number; w: number; h: number }>;
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
        const nx = first.x + dx;
        const ny = first.y + dy;
        if (d.mode === 'move') {
          dx += snapShift([nx, nx + first.w / 2, nx + first.w], tx, th);
          dy += snapShift([ny, ny + first.h / 2, ny + first.h], ty, th);
        } else {
          if (d.mode.includes('e')) dx += snapShift([first.x + first.w + dx], tx, th);
          if (d.mode.includes('w')) dx += snapShift([nx], tx, th);
          if (d.mode.includes('s')) dy += snapShift([first.y + first.h + dy], ty, th);
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
    const start: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const id of ids) {
      const l = findLayer(st.template, id);
      if (!l) continue;
      start[id] = {
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

  const onPointerDown = (e: React.PointerEvent) => {
    const st = useDesigner.getState();
    const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-layer-id]');
    const id = hit?.dataset.layerId;
    if (!id) {
      st.select([]);
      return;
    }
    const l = st.template && findLayer(st.template, id);
    if (l?.locked) return;
    let sel = st.selected;
    if (e.shiftKey) sel = sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id];
    else if (!sel.includes(id)) sel = [id];
    st.select(sel);
    beginDrag(e, 'move', sel);
  };

  if (!template) return <Overview project={_project} size={project} format={format} scale={scale} background={background} showZones={showZones} wrapRef={wrapRef} now={now} fps={fps} />;

  return (
    <div className="stage-wrap" ref={wrapRef} onPointerDown={() => useDesigner.getState().select([])}>
      <div className={`stage-frame bg-${background}`} onPointerDown={(e) => e.stopPropagation()}>
        <div ref={sceneRef} onPointerDown={onPointerDown} style={{ position: 'relative' }}>
          <Viewport width={project.width} height={project.height} scale={scale} style={{ overflow: 'visible' }}>
            {/* Widgets run on the playhead: scrub to see a ticker or a counter move. */}
            <LiveTime ageSecs={frame / fps} clientNow={now} layerAge={(l) => (widgetRun[l.id] ? runAge(widgetRun[l.id], now) : frame / fps)} widgetState={(id) => widgetState[id]} fps={fps} lang={_project.language}>
              <Scene template={template} frame={frame} data={data} interactive />
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
          {showZones && <ZoneOverlay zones={_project.zones ?? []} only={template.zone} format={format} width={project.width} height={project.height} scale={scale} current={template.zone} />}
          {ghosts.map((b) => (
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
    </div>
  );
}

/** Handles of a spec widget (web/src/widgets) over its selection box. */
function WidgetOverlay({ layerId, box, frame }: { layerId: string; box: Box; frame: number }) {
  const { template, update } = useDesigner();
  const layer = template && findLayer(template, layerId);
  const Ov = layer && widgetOf(layer.type)?.Overlay;
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
  showZones,
  wrapRef,
  now,
  fps,
}: {
  project: Project;
  size: { width: number; height: number };
  format: string;
  scale: number;
  background: string;
  showZones: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  now: number;
  fps: number;
}) {
  const load = useDesigner((s) => s.load);
  const sceneRef = useRef<HTMLDivElement>(null);
  const portrait = size.height > size.width;
  const zones = new Map(project.zones.map((z) => [z.id, z]));
  const templates = [...designTemplates(project)].sort((a, b) => (zones.get(a.zone)?.layer ?? 0) - (zones.get(b.zone)?.layer ?? 0));
  return (
    <div className="stage-wrap" ref={wrapRef}>
      <div className={`stage-frame bg-${background}`}>
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
          <Viewport width={size.width} height={size.height} scale={scale}>
            {templates.map((t) => {
              const z = zones.get(t.zone);
              const hold = holdFrame(t);
              return (
                <div key={t.id} className="overview-tpl" data-template-id={t.id} title={`${t.name} — click to open`} style={{ position: 'absolute', inset: 0, ...areaClip(z && zoneArea(z, format, portrait)) }}>
                  <LiveTime ageSecs={hold / fps} clientNow={now}>
                    <Scene template={inFormat(t, format)} frame={hold} data={defaultData(t)} interactive />
                  </LiveTime>
                </div>
              );
            })}
          </Viewport>
          <StageGuides project={project} width={size.width} height={size.height} scale={scale} frameRef={sceneRef} />
          {showZones && <ZoneOverlay zones={project.zones ?? []} format={format} width={size.width} height={size.height} scale={scale} current="" />}
        </div>
      </div>
      <div className="stage-info">
        All templates · {templates.length} · click a graphic to open its template · {size.width}×{size.height} · {Math.round(scale * 100)}%
      </div>
    </div>
  );
}
