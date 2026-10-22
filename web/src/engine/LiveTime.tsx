import { useEffect, useState } from 'react';
import { clientNow, useApp } from '../store';
import { TimeContext } from './Scene';
import type { Layer } from './types';

/**
 * Client clock that ticks every animation frame while `active`: the frame's
 * own time stamp (not when its callback happens to run), so what moves by the
 * clock steps evenly from frame to frame.
 */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(clientNow);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = (t: number) => {
      setNow(performance.timeOrigin + t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return active ? now : clientNow();
}

/** Provides widget time (server clock + time on air) to a scene. */
export function LiveTime({ ageSecs, clientNow, layerAge, clocked, widgetState, fps, lang, children }: { ageSecs: number; clientNow: number; layerAge?: (l: Layer) => number; clocked?: (l: Layer) => boolean; widgetState?: (layerId: string) => unknown; fps?: number; lang?: string; children: React.ReactNode }) {
  const offset = useApp((s) => s.serverOffset);
  const tz = useApp((s) => s.timezone);
  return <TimeContext.Provider value={{ nowMs: clientNow + offset, ageSecs, defaultTz: tz, layerAge, clocked, widgetState, fps, lang }}>{children}</TimeContext.Provider>;
}
