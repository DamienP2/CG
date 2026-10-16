import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LiveTime, useTicker } from '../engine/LiveTime';
import { hasLiveWidgets, Scene, Viewport } from '../engine/Scene';
import { num, propValue } from '../engine/evaluate';
import type { Project } from '../engine/types';
import { findLayer, setProp, useDesigner } from './designerStore';

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
export function Stage({ project: _project, size, showSafe, background }: { project: Project; size: { width: number; height: number }; showSafe: boolean; background: string }) {
  const project = { ..._project, width: size.width, height: size.height };
  const { template, frame, previewData, selected } = useDesigner();
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const now = useTicker(!!template && hasLiveWidgets(template));
  const fps = project.frameRate.num / project.frameRate.den || 1;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const pad = 48;
      setScale(Math.min((el.clientWidth - pad) / project.width, (el.clientHeight - pad) / project.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  // Selection boxes come from the DOM so they follow nested transforms.
  useLayoutEffect(() => {
    const root = sceneRef.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
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
      const dx = (e.clientX - d.startX) / scale;
      const dy = (e.clientY - d.startY) / scale;
      const snap = e.shiftKey ? 10 : 1;
      const r = (v: number) => Math.round(v / snap) * snap;
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

  if (!template) return <div className="stage-wrap" ref={wrapRef} />;

  return (
    <div className="stage-wrap" ref={wrapRef} onPointerDown={() => useDesigner.getState().select([])}>
      <div className={`stage-frame bg-${background}`} onPointerDown={(e) => e.stopPropagation()}>
        <div ref={sceneRef} onPointerDown={onPointerDown} style={{ position: 'relative' }}>
          <Viewport width={project.width} height={project.height} scale={scale}>
            {/* Widgets run on the playhead: scrub to see a ticker or a counter move. */}
            <LiveTime ageSecs={frame / fps} clientNow={now}>
              <Scene template={template} frame={frame} data={previewData} interactive />
            </LiveTime>
          </Viewport>
          {showSafe && (
            <>
              <div className="safe-area" style={{ inset: '5%' }} />
              <div className="safe-area title" style={{ inset: '10%' }} />
            </>
          )}
          {boxes.map((b) => (
            <div key={b.id} className="sel-box" style={{ left: b.left, top: b.top, width: b.width, height: b.height }}>
              {selected.length === 1 &&
                HANDLES.map((h) => <div key={h} className={`handle h-${h}`} onPointerDown={(e) => beginDrag(e, h, [b.id])} />)}
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
