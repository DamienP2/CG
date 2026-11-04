import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { movesAt, movingLayers, oldData, shownData, ValueMotionContext } from '../engine/valueMotion';
import { formatFor, inFormat } from '../engine/formats';
import { LiveTime, useTicker } from '../engine/LiveTime';
import { Scene } from '../engine/Scene';
import { layerAgeFrames } from '../engine/widgets';
import { onAirKey, onAirWatched, presence } from '../engine/logic';
import { holdFrame, motionLook } from '../engine/evaluate';
import { areaClip, zoneArea } from '../engine/zones';
import type { Layer, PlayoutItem, Project, Template } from '../engine/types';
import type { Live } from '../store';
import { busItems } from '../engine/buses';

/**
 * Composites every playout layer of a channel into a `width` × `height`
 * picture: the project format closest to that shape (16:9, 9:16…) is used
 * and letterboxed, like the Rust renderer does for SDI / ST 2110.
 */
export const Program = memo(function Program({ project, live, width, height, maxFps, bus = 0 }: { project: Project; live: Live | undefined; width: number; height: number; /** A monitor: at most this many frames a second (the HTML5 output: every frame). */ maxFps?: number; /** The output shown (0: the antenne). */ bus?: number }) {
  const format = formatFor(project, width, height);
  // Templates laid out in that format, computed once per project change.
  const templates = useMemo(() => new Map<string, Template>(project.templates.map((t) => [t.id, inFormat(t, format.id)])), [project, format.id]);
  const items = busItems(live?.state.layers ?? {}, bus).sort(([a], [b]) => Number(a) - Number(b));
  // Redrawn on each frame while a timeline or a fade moves; the widgets that move by themselves (a ticker…) redraw alone.
  // A presence on air still gliding (« On air » nodes of the Logic, seen at the last frame): redrawn too.
  const [gliding, setGliding] = useState(false);
  const now = useTicker(items.some(([, item]) => moving(item)) || gliding, maxFps);
  const fps = project.frameRate.num / project.frameRate.den || 1;
  // Frames shown last, by playout layer: never step back when a state
  // arrives a little behind what was extrapolated.
  const shown = useRef(new Map<string, { templateId: string; frame: number }>());
  // The server sends a state per tick while timelines move, over a network
  // that delivers them unevenly: the picture moves on at the display rate
  // from the last state instead, as far as its target.
  const since = Math.max(0, now - (live?.at ?? now)) / 1000;
  const frameOf = (layer: string, item: PlayoutItem) => {
    let f = advancing(item) ? Math.min(item.target, item.frame + since * fps) : item.frame;
    const last = shown.current.get(layer);
    if (last && last.templateId === item.templateId && advancing(item) && f < last.frame && last.frame - f < 3) f = Math.min(item.target, last.frame);
    shown.current.set(layer, { templateId: item.templateId, frame: f });
    return f;
  };
  // The presence on air of the graphics a Logic reads (« On air » nodes), as the Rust renderer gives it.
  const air = items.map(([, i]) => i);
  const holdOf = (id: string) => {
    const x = templates.get(id);
    return x ? holdFrame(x) : 0;
  };
  let glides = false;
  const withPresence = (d: Record<string, string>, t: Template) => {
    const watched = onAirWatched(t.logic);
    if (!watched.length) return d;
    const out = { ...d };
    for (const [id, tr] of watched) {
      const k = presence(air, holdOf, id, tr, fps, since);
      if (k > 0 && k < 1) glides = true;
      out[onAirKey(id)] = k.toFixed(4);
    }
    return out;
  };
  // After this frame: still gliding or not (decides the redraws above).
  useEffect(() => setGliding((g) => (g === glides ? g : glides)));
  const scale = Math.min(width / format.width, height / format.height);
  const zoneOf = (layer: number) => {
    const z = project.zones.find((x) => x.layer === layer);
    return z && zoneArea(z, format.id, format.height > format.width);
  };
  return (
    <div
      style={{
        position: 'absolute',
        left: (width - format.width * scale) / 2,
        top: (height - format.height * scale) / 2,
        width: format.width,
        height: format.height,
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
      }}
    >
      {items.map(([layer, item]) => {
        const t = templates.get(item.templateId);
        if (!t) return null;
        // The server only sends states when timelines move: extrapolate time on air.
        const age = (item.age ?? 0) / fps;
        const frame = frameOf(layer, item);
        const fade = item.fade ? Math.min(item.fade.length, item.fade.frame + since * fps) : null;
        // Values a data source changed: counting, sliding or turning over in the layers showing them.
        const moves = movesAt(item, since * fps);
        const shown = withPresence(shownData(item.vals ? { ...item.data, ...item.vals } : item.data, moves), t);
        const turning = movingLayers(t, moves);
        // The graphic replaced in a « Fade » zone, fading out under the new one.
        const going = item.leaving;
        const goingT = going && templates.get(going.item.templateId);
        const goingFrame = going ? going.frame + since * fps : 0;
        const goingLook = going?.item.motion ? motionLook({ ...going.item.motion, length: going.length }, goingFrame) : { alpha: going ? 1 - Math.min(1, goingFrame / Math.max(1, going.length)) : 0, dx: 0, dy: 0 };
        const goingAlpha = goingLook.alpha;
        // Fading or sliding in or out the way a Logic said (« How… »).
        const look = motionLook(item.motion, item.motion ? item.motion.frame + since * fps : 0);
        if (look.alpha <= 0) return null;
        // Properties a Logic changed, on their way.
        const tweaks = item.tweaks?.length ? item.tweaks.map((tw) => ({ ...tw, frame: Math.min(tw.length, tw.frame + since * fps) })) : undefined;
        const laid = (l: { alpha: number; dx: number; dy: number }) => ({ position: 'absolute' as const, inset: 0, ...(l.alpha < 1 ? { opacity: l.alpha } : {}), ...(l.dx || l.dy ? { transform: `translate(${l.dx * 100}%, ${l.dy * 100}%)` } : {}) });
        return (
          // Only what is inside the zone shows on air.
          <div key={layer} style={{ position: 'absolute', inset: 0, ...areaClip(zoneOf(Number(layer))) }}>
            {going && goingT && goingAlpha > 0 && (
              <div style={laid(goingLook)}>
                <LayerTime item={going.item} template={goingT} ageSecs={(going.item.age ?? 0) / fps} since={live?.at ?? now} now={now} maxFps={maxFps} fps={fps} lang={project.language}>
                  <Scene template={goingT} frame={going.item.frame} data={going.item.data} />
                </LayerTime>
              </div>
            )}
            <div style={laid(look)}>
            <LayerTime item={item} template={t} ageSecs={age} since={live?.at ?? now} now={now} maxFps={maxFps} fps={fps} lang={project.language}>
              {/*
               * A row or an Update fading: the graphic with the new values fades in while the one with
               * the old values fades out, added up (plus-lighter): what both cover stays opaque.
               */}
              {(() => {
                const k = item.fade && fade !== null && fade < item.fade.length ? Math.min(1, Math.max(0, fade / Math.max(1, item.fade.length))) : 1;
                return (
                  <div style={{ position: 'absolute', inset: 0, ...(k < 1 ? { isolation: 'isolate' as const } : {}) }}>
                    <div style={k < 1 ? { position: 'absolute', inset: 0, opacity: k } : { position: 'absolute', inset: 0 }}>
                      {turning.size ? (
                        <>
                          <ValueMotionContext.Provider value={{ layers: turning, old: false }}>
                            <Scene template={t} frame={frame} data={shown} tweaks={tweaks} />
                          </ValueMotionContext.Provider>
                          <ValueMotionContext.Provider value={{ layers: turning, old: true }}>
                            <Scene template={t} frame={frame} data={oldData(shown, moves)} />
                          </ValueMotionContext.Provider>
                        </>
                      ) : (
                        <Scene template={t} frame={frame} data={shown} tweaks={tweaks} />
                      )}
                    </div>
                    {k < 1 && item.fade && (
                      <div style={{ position: 'absolute', inset: 0, opacity: 1 - k, mixBlendMode: 'plus-lighter' }}>
                        <Scene template={t} frame={frame} data={item.fade.data} />
                      </div>
                    )}
                  </div>
                );
              })()}
            </LayerTime>
            </div>
          </div>
        );
      })}
    </div>
  );
});

/** The time of one playout layer: on air, it runs on from the last state received. */
function LayerTime({ item, template, ageSecs, since, now, maxFps, fps, lang, children }: { item: PlayoutItem; template: Template; ageSecs: number; since: number; now: number; maxFps?: number; fps: number; lang?: string; children: React.ReactNode }) {
  // Kept while the item is the same: the widgets that do not move are not drawn again.
  const manual = useMemo(() => template.layers.some((l) => l.manualStart), [template]);
  const layerAge = useMemo(() => (item.clocks || manual ? (l: Layer, age: number) => layerAgeFrames(item, age * fps, l) / fps : undefined), [item, manual, fps]);
  const clocked = useCallback((l: Layer) => !!item.clocks?.[l.id] || !!l.manualStart, [item]);
  const widgetState = useCallback((id: string) => item.widgets?.[id], [item]);
  return (
    <LiveTime ageSecs={ageSecs} since={since} clientNow={now} ticking="all" maxFps={maxFps} layerAge={layerAge} clocked={clocked} widgetState={widgetState} fps={fps} lang={lang}>
      {children}
    </LiveTime>
  );
}

/** A timeline on its way to its target (not held at a stop). */
const advancing = (item: PlayoutItem) => item.phase !== 'holding' && item.phase !== 'outHold' && item.frame < item.target;
/** Something moves: the timeline, or a fade. */
const moving = (item: PlayoutItem) => advancing(item) || (!!item.fade && item.fade.frame < item.fade.length) || !!item.changes?.length || (!!item.leaving && item.leaving.frame < item.leaving.length) || (!!item.motion && item.motion.frame < item.motion.length) || !!item.tweaks?.some((tw) => tw.frame < tw.length);
