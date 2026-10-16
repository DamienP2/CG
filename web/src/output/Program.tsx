import { Scene } from '../engine/Scene';
import type { ChannelState, Project } from '../engine/types';

/** Composites every playout layer of a channel, lowest layer number first. */
export function Program({ project, channel }: { project: Project; channel: ChannelState }) {
  const items = Object.entries(channel.layers).sort(([a], [b]) => Number(a) - Number(b));
  return (
    <>
      {items.map(([layer, item]) => {
        const t = project.templates.find((x) => x.id === item.templateId);
        if (!t) return null;
        return (
          <div key={layer} style={{ position: 'absolute', inset: 0 }}>
            <Scene template={t} frame={item.frame} data={item.data} />
          </div>
        );
      })}
    </>
  );
}
