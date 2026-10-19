import { useMemo } from 'react';
import { formatFor, inFormat } from '../engine/formats';
import { LiveTime, useTicker } from '../engine/LiveTime';
import { hasLiveWidgets, Scene } from '../engine/Scene';
import { layerAgeFrames } from '../engine/widgets';
import { areaClip, zoneArea } from '../engine/zones';
import type { Project, Template } from '../engine/types';
import type { Live } from '../store';

/**
 * Composites every playout layer of a channel into a `width` × `height`
 * picture: the project format closest to that shape (16:9, 9:16…) is used
 * and letterboxed, like the Rust renderer does for SDI / ST 2110.
 */
export function Program({ project, live, width, height }: { project: Project; live: Live | undefined; width: number; height: number }) {
  const format = formatFor(project, width, height);
  // Templates laid out in that format, computed once per project change.
  const templates = useMemo(() => new Map<string, Template>(project.templates.map((t) => [t.id, inFormat(t, format.id)])), [project, format.id]);
  const items = Object.entries(live?.state.layers ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  const now = useTicker(
    items.some(([, item]) => {
      const t = templates.get(item.templateId);
      return !!t && hasLiveWidgets(t);
    }),
  );
  const fps = project.frameRate.num / project.frameRate.den || 1;
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
        const age = (item.age ?? 0) / fps + Math.max(0, now - (live?.at ?? now)) / 1000;
        return (
          // Only what is inside the zone shows on air.
          <div key={layer} style={{ position: 'absolute', inset: 0, ...areaClip(zoneOf(Number(layer))) }}>
            <LiveTime ageSecs={age} clientNow={now} layerAge={item.clocks || t.layers.some((l) => l.manualStart) ? (l) => layerAgeFrames(item, age * fps, l) / fps : undefined} widgetState={(id) => item.widgets?.[id]} fps={fps} lang={project.language}>
              <Scene template={t} frame={item.frame} data={item.data} />
            </LiveTime>
          </div>
        );
      })}
    </div>
  );
}
