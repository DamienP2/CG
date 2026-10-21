import { useEffect, useState } from 'react';
import { Viewport } from '../engine/Scene';
import { useApp } from '../store';
import { Program } from './Program';

/**
 * HTML5 output of one channel picture: a transparent, chrome-less page meant
 * for browser sources (OBS, vMix, CasparCG HTML producer…).
 * URL: /output/<channel>[/<rendition>]. Query params: `scale=fit|1`
 * (default fit), `bg=<css color>` for checks.
 */
export function Output({ channelId, rendition }: { channelId: string; rendition?: string | null }) {
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
  if (!channel) return null;
  const picture = channel.renditions.find((r) => r.id === rendition) ?? channel;
  const project = channel.projectId ? full[channel.projectId] : undefined;
  const scale = fixed ? 1 : Math.min(size.w / picture.width, size.h / picture.height);
  return (
    <div style={{ position: 'fixed', inset: 0, background: bg, overflow: 'hidden' }}>
      <Viewport width={picture.width} height={picture.height} scale={scale}>
        {project && <Program project={project} live={live[channelId]} width={picture.width} height={picture.height} />}
        {/* No project loaded: the picture's still image, filling the frame (as on the other outputs). */}
        {!channel.projectId && picture.slate && <img src={picture.slate} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
      </Viewport>
    </div>
  );
}
