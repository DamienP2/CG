import { LiveTime, useTicker } from '../engine/LiveTime';
import { hasLiveWidgets, Scene } from '../engine/Scene';
import type { Project } from '../engine/types';
import type { Live } from '../store';

/** Composites every playout layer of a channel, lowest layer number first. */
export function Program({ project, live }: { project: Project; live: Live | undefined }) {
  const items = Object.entries(live?.state.layers ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  const templates = items.map(([, item]) => project.templates.find((x) => x.id === item.templateId));
  const now = useTicker(templates.some((t) => t && hasLiveWidgets(t)));
  const fps = project.frameRate.num / project.frameRate.den || 1;
  return (
    <>
      {items.map(([layer, item], i) => {
        const t = templates[i];
        if (!t) return null;
        // The server only sends states when timelines move: extrapolate time on air.
        const age = (item.age ?? 0) / fps + Math.max(0, now - (live?.at ?? now)) / 1000;
        return (
          <div key={layer} style={{ position: 'absolute', inset: 0 }}>
            <LiveTime ageSecs={age} clientNow={now}>
              <Scene template={t} frame={item.frame} data={item.data} />
            </LiveTime>
          </div>
        );
      })}
    </>
  );
}
