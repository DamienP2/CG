import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { TimeContext } from './Scene';
import type { Layer } from './types';

/** Client clock that ticks every animation frame while `active`. */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return active ? now : Date.now();
}

/** Provides widget time (server clock + time on air) to a scene. */
export function LiveTime({ ageSecs, clientNow, layerAge, widgetState, fps, children }: { ageSecs: number; clientNow: number; layerAge?: (l: Layer) => number; widgetState?: (layerId: string) => unknown; fps?: number; children: React.ReactNode }) {
  const offset = useApp((s) => s.serverOffset);
  const tz = useApp((s) => s.timezone);
  return <TimeContext.Provider value={{ nowMs: clientNow + offset, ageSecs, defaultTz: tz, layerAge, widgetState, fps }}>{children}</TimeContext.Provider>;
}
