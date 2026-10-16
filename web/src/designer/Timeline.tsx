import { ChevronDown, ChevronLeft, ChevronRight, Diamond, Flag, LogOut, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, Tv } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { childrenMap } from '../engine/Scene';
import { newId } from '../engine/evaluate';
import { PROPS, type Keyframe, type Layer, type MarkerKind, type Prop, type Template } from '../engine/types';
import { findLayer, toggleKeyAt, useDesigner, type KeyRef } from './designerStore';
import { PROP_LABELS } from './Inspector';

const LEFT_W = 260;

export function formatTime(frame: number, fps: number): string {
  const f = Math.round(frame);
  const r = Math.round(fps);
  const s = Math.floor(f / r);
  const ff = f % r;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

function flatten(t: Template): { layer: Layer; depth: number }[] {
  const tree = childrenMap(t.layers, true);
  const out: { layer: Layer; depth: number }[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const l of [...(tree.get(pid) ?? [])].reverse()) {
      out.push({ layer: l, depth });
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function tickStep(zoom: number): number {
  for (const s of [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]) if (s * zoom >= 56) return s;
  return 1000;
}

const sameKey = (a: KeyRef, b: KeyRef) => a.layerId === b.layerId && a.prop === b.prop && a.frame === b.frame;

export function Timeline({ fps }: { fps: number }) {
  const st = useDesigner();
  const { template, frame, zoom, expanded, selectedKeys, playing, loop, playoutPreview, selected } = st;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (template ? flatten(template) : []), [template]);

  // Keep the playhead visible while playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = frame * zoom;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - LEFT_W - 40) el.scrollLeft = Math.max(0, x - 40);
  }, [frame, zoom, playing]);

  if (!template) return null;
  const width = template.duration * zoom + 200;
  const step = tickStep(zoom);
  const outF = template.markers.find((m) => m.kind === 'out')?.frame;

  const frameAt = (clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return (clientX - r.left - LEFT_W + el.scrollLeft) / zoom;
  };

  const scrub = (e: React.PointerEvent) => {
    st.setPlaying(false);
    st.setFrame(Math.round(frameAt(e.clientX)));
    const move = (ev: PointerEvent) => useDesigner.getState().setFrame(Math.round(frameAt(ev.clientX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragKeys = (e: React.PointerEvent, ref: KeyRef) => {
    e.stopPropagation();
    const s = useDesigner.getState();
    let sel = s.selectedKeys;
    const isSel = sel.some((k) => sameKey(k, ref));
    if (e.shiftKey) sel = isSel ? sel.filter((k) => !sameKey(k, ref)) : [...sel, ref];
    else if (!isSel) sel = [ref];
    s.selectKeys(sel);
    if (!sel.some((k) => sameKey(k, ref))) return;
    const base = s.template!;
    const startX = e.clientX;
    let lastDelta = 0;
    useDesigner.setState({ lastCoalesce: null });
    const move = (ev: PointerEvent) => {
      const delta = Math.round((ev.clientX - startX) / zoom);
      if (delta === lastDelta) return;
      lastDelta = delta;
      const moved: KeyRef[] = [];
      useDesigner.getState().update((t) => {
        const groups = new Map<string, KeyRef[]>();
        for (const k of sel) groups.set(`${k.layerId}|${k.prop}`, [...(groups.get(`${k.layerId}|${k.prop}`) ?? []), k]);
        for (const [gk, refs] of groups) {
          const [layerId, prop] = gk.split('|') as [string, Prop];
          const baseTrack = findLayer(base, layerId)?.tracks[prop] ?? [];
          const frames = new Set(refs.map((r) => r.frame));
          const movedKeys: Keyframe[] = baseTrack
            .filter((k) => frames.has(k.frame))
            .map((k) => ({ ...k, frame: Math.max(0, Math.min(t.duration, k.frame + delta)) }));
          const newFrames = new Set(movedKeys.map((k) => k.frame));
          const kept = baseTrack.filter((k) => !frames.has(k.frame) && !newFrames.has(k.frame));
          findLayer(t, layerId)!.tracks[prop] = [...kept, ...movedKeys].sort((a, b) => a.frame - b.frame);
          moved.push(...movedKeys.map((k) => ({ layerId, prop, frame: k.frame })));
        }
      }, 'key-drag');
      useDesigner.getState().selectKeys(moved);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragMarker = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    useDesigner.setState({ lastCoalesce: null });
    // "On air" and "Out" on the same frame move together (Alt: just this one).
    const m0 = template.markers.find((m) => m.id === id)!;
    const linked = e.altKey ? [id] : template.markers.filter((m) => m.frame === m0.frame && m.kind !== 'label').map((m) => m.id);
    const move = (ev: PointerEvent) => {
      const f = Math.max(0, Math.min(template.duration, Math.round(frameAt(ev.clientX))));
      useDesigner.getState().update((t) => {
        for (const m of t.markers) if (linked.includes(m.id)) m.frame = f;
      }, `marker-${id}`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addMarker = (kind: MarkerKind) =>
    st.update((t) => {
      if (kind === 'out') t.markers = t.markers.filter((m) => m.kind !== 'out');
      t.markers.push({ id: newId(), frame: Math.round(frame), name: kind === 'out' ? 'Out' : t.markers.some((m) => m.kind === 'pause') ? 'Pause' : 'On air', kind });
    });

  /** ◀ ◆ ▶ of a timeline row: previous key, key at the playhead, next key. */
  const keyNav = (layer: Layer, props: Prop[], canToggle: boolean) => {
    const frames = [...new Set(props.flatMap((p) => (layer.tracks[p] ?? []).map((k) => k.frame)))].sort((a, b) => a - b);
    const prev = [...frames].reverse().find((f) => f < frame - 0.5);
    const next = frames.find((f) => f > frame + 0.5);
    const here = frames.some((f) => Math.abs(f - frame) < 0.5);
    return (
      <span className="tl-keynav" onClick={(e) => e.stopPropagation()}>
        <button title="Previous keyframe" disabled={prev === undefined} onClick={() => prev !== undefined && st.setFrame(prev)}>
          <ChevronLeft size={12} />
        </button>
        {canToggle && (
          <button
            className={here ? 'on' : ''}
            title={here ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'}
            onClick={() => st.update((t) => toggleKeyAt(findLayer(t, layer.id)!, props[0], frame))}
          >
            <Diamond size={11} fill={here ? 'currentColor' : 'none'} />
          </button>
        )}
        <button title="Next keyframe" disabled={next === undefined} onClick={() => next !== undefined && st.setFrame(next)}>
          <ChevronRight size={12} />
        </button>
      </span>
    );
  };

  const markers = [...template.markers].sort((a, b) => a.frame - b.frame);
  const jumpMarker = (dir: 1 | -1) => {
    const stops = [0, ...markers.map((m) => m.frame), template.duration];
    const target = dir > 0 ? stops.find((f) => f > frame + 0.5) : [...stops].reverse().find((f) => f < frame - 0.5);
    if (target !== undefined) st.setFrame(target);
  };

  const diamond = (ref: KeyRef, k: Keyframe, summary = false) => {
    const isSel = selectedKeys.some((s) => sameKey(s, ref));
    return (
      <div
        key={`${ref.prop}-${k.frame}`}
        className={`kf ${isSel ? 'sel' : ''} ${summary ? 'summary' : ''} e-${k.easing.type}`}
        style={{ left: k.frame * zoom }}
        title={`${PROP_LABELS[ref.prop]} @ ${k.frame} · ${k.easing.type}`}
        onPointerDown={summary ? undefined : (e) => dragKeys(e, ref)}
        onDoubleClick={() => st.setFrame(k.frame)}
      />
    );
  };

  const body: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];
  for (const { layer, depth } of rows) {
    const animated = PROPS.filter((p) => layer.tracks[p]?.length);
    const open = expanded[layer.id];
    const isSel = selected.includes(layer.id);
    labels.push(
      <div key={layer.id} className={`tl-label ${isSel ? 'selected' : ''} ${layer.visible ? '' : 'dim'}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => st.select([layer.id])}>
        <span
          className="twirl"
          onClick={(e) => {
            e.stopPropagation();
            st.toggleExpanded(layer.id);
          }}
        >
          {animated.length > 0 && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <span className="layer-name">{layer.name}</span>
        {animated.length > 0 && <span className="badge">{animated.length}</span>}
        {animated.length > 0 && keyNav(layer, animated, false)}
      </div>,
    );
    const allFrames = new Map<number, Keyframe>();
    for (const p of animated) for (const k of layer.tracks[p]!) allFrames.set(k.frame, k);
    body.push(
      <div key={layer.id} className={`tl-row layer ${isSel ? 'selected' : ''}`}>
        <div className="tl-bar" style={{ width: template.duration * zoom }} />
        {[...allFrames.values()].map((k) => diamond({ layerId: layer.id, prop: 'x', frame: k.frame }, k, true))}
      </div>,
    );
    if (open) {
      for (const p of animated) {
        labels.push(
          <div key={`${layer.id}-${p}`} className="tl-label prop" style={{ paddingLeft: 30 + depth * 14 }}>
            <span className="prop-name">{PROP_LABELS[p]}</span>
            {keyNav(layer, [p], true)}
          </div>,
        );
        body.push(
          <div key={`${layer.id}-${p}`} className="tl-row prop">
            {layer.tracks[p]!.map((k) => diamond({ layerId: layer.id, prop: p, frame: k.frame }, k))}
          </div>,
        );
      }
    }
  }

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <div className="transport">
          <button className="icon-btn" title="Go to start (Home)" onClick={() => st.setFrame(0)}>
            <SkipBack size={15} />
          </button>
          <button className="icon-btn" title="Previous marker" onClick={() => jumpMarker(-1)}>
            <StepBack size={15} />
          </button>
          <button className="icon-btn play" title="Play / pause (Space)" onClick={() => st.setPlaying(!playing)}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button className="icon-btn" title="Next marker" onClick={() => jumpMarker(1)}>
            <StepForward size={15} />
          </button>
          <button className="icon-btn" title="Go to end (End)" onClick={() => st.setFrame(template.duration)}>
            <SkipForward size={15} />
          </button>
        </div>
        <div className="timecode">
          <strong>{formatTime(frame, fps)}</strong>
          <span>
            {Math.round(frame)} / {template.duration}
          </span>
        </div>
        <button className={`btn small ${loop ? 'on' : ''}`} title="Loop playback" onClick={() => st.set({ loop: !loop })}>
          <Repeat size={13} /> Loop
        </button>
        <button className={`btn small ${playoutPreview ? 'on' : ''}`} title="Stop on pause markers, like on air" onClick={() => st.set({ playoutPreview: !playoutPreview })}>
          <Tv size={13} /> Playout preview
        </button>
        <div className="spacer" />
        <button className="btn small" title="Add a pause marker at the playhead" onClick={() => addMarker('pause')}>
          <Flag size={13} /> Pause
        </button>
        <button className="btn small" title="Set the out marker at the playhead" onClick={() => addMarker('out')}>
          <LogOut size={13} /> Out
        </button>
        <label className="zoom">
          Zoom
          <input type="range" min={1} max={40} step={0.5} value={zoom} onChange={(e) => st.set({ zoom: +e.target.value })} />
        </label>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-grid" style={{ width: LEFT_W + width }}>
          <div className="tl-left" style={{ width: LEFT_W }}>
            <div className="tl-corner">Layers</div>
            {labels}
          </div>
          <div className="tl-right" style={{ width }}>
            <div className="tl-ruler" onPointerDown={scrub}>
              {Array.from({ length: Math.floor(template.duration / step) + 1 }, (_, i) => (
                <div key={i} className="tick" style={{ left: i * step * zoom }}>
                  <span>{i * step}</span>
                </div>
              ))}
              {markers.map((m) => (
                <div
                  key={m.id}
                  className={`tl-marker ${m.kind}`}
                  style={{ left: m.frame * zoom }}
                  title={`${m.name} (${m.kind}) @ ${m.frame} — drag to move`}
                  onPointerDown={(e) => dragMarker(e, m.id)}
                  onDoubleClick={() => st.setFrame(m.frame)}
                >
                  <span>{m.name}</span>
                </div>
              ))}
            </div>
            <div className="tl-rows" onPointerDown={() => st.selectKeys([])}>
              {outF !== undefined && <div className="out-zone" style={{ left: outF * zoom, width: (template.duration - outF) * zoom }} />}
              {markers.map((m) => (
                <div key={m.id} className={`marker-line ${m.kind}`} style={{ left: m.frame * zoom }} />
              ))}
              {body}
              <div className="tl-end" style={{ left: template.duration * zoom }} />
            </div>
            <div className="playhead" style={{ left: frame * zoom }} />
          </div>
        </div>
      </div>
    </div>
  );
}

