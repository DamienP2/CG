import { useEffect, useState } from 'react';
import { Viewport } from '../engine/Scene';
import { useApp } from '../store';
import { Program } from './Program';

/**
 * HTML5 output of one channel: a transparent, chrome-less page meant for
 * browser sources (OBS, vMix, CasparCG HTML producer…).
 * URL: /output/<channel>. Query params: `scale=fit|1` (default fit),
 * `bg=<css color>` for checks.
 */
export function Output({ channelId }: { channelId: string }) {
  const { connect, channels, full, live } = useApp();
  const params = new URLSearchParams(location.search);
  const fixed = params.get('scale') === '1';
  const bg = params.get('bg') ?? 'transparent';
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });

  useEffect(() => {
    document.documentElement.classList.add('output-mode');
    connect(channelId);
    const onResize = () => setSize({ w: innerWidth, h: innerHeight });
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, [connect, channelId]);

  const channel = channels.find((c) => c.id === channelId);
  const project = channel?.projectId ? full[channel.projectId] : undefined;
  if (!channel) return null;
  // The channel format; the project is letterboxed into it like on SDI / 2110.
  const scale = fixed ? 1 : Math.min(size.w / channel.width, size.h / channel.height);
  const inner = project ? Math.min(channel.width / project.width, channel.height / project.height) : 1;
  return (
    <div style={{ position: 'fixed', inset: 0, background: bg, overflow: 'hidden' }}>
      <Viewport width={channel.width} height={channel.height} scale={scale}>
        {project && (
          <div
            style={{
              position: 'absolute',
              left: (channel.width - project.width * inner) / 2,
              top: (channel.height - project.height * inner) / 2,
              width: project.width,
              height: project.height,
              transform: `scale(${inner})`,
              transformOrigin: '0 0',
            }}
          >
            <Program project={project} live={live[channelId]} />
          </div>
        )}
      </Viewport>
    </div>
  );
}
