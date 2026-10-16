import { useEffect, useState } from 'react';
import { Viewport } from '../engine/Scene';
import { useApp } from '../store';
import { Program } from './Program';

/**
 * HTML5 output: a transparent, chrome-less page meant for browser sources
 * (OBS, vMix, CasparCG HTML producer, Singular-style overlays).
 * Query params: `scale=fit|1` (default fit), `bg=<css color>` for checks.
 */
export function Output() {
  const { project, channel } = useApp();
  const params = new URLSearchParams(location.search);
  const fixed = params.get('scale') === '1';
  const bg = params.get('bg') ?? 'transparent';
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });

  useEffect(() => {
    document.documentElement.classList.add('output-mode');
    const onResize = () => setSize({ w: innerWidth, h: innerHeight });
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);

  if (!project) return null;
  const scale = fixed ? 1 : Math.min(size.w / project.width, size.h / project.height);
  return (
    <div style={{ position: 'fixed', inset: 0, background: bg, overflow: 'hidden' }}>
      <Viewport width={project.width} height={project.height} scale={scale}>
        <Program project={project} channel={channel} />
      </Viewport>
    </div>
  );
}
