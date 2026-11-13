import type { Resolved } from './evaluate';
import type { Motion, Prop } from './types';

/**
 * Adds a layer's repeated movement (Layer.motion) to its values, at `ageSecs`
 * of its time on air (mirror of cg_core::anim::apply_motion).
 */
export function applyMotion(r: Resolved, m: Motion, frame: number, fps: number, ageSecs: number): Resolved {
  if (frame < m.from || m.period <= 0) return r;
  // From 0, where the in animation ends (the layer as set), smoothly.
  const t = Math.max(0, ageSecs - m.from / Math.max(1, fps));
  const phase = (t / m.period) * Math.PI * 2;
  const wave = Math.sin(phase);
  const swell = (1 - Math.cos(phase)) / 2;
  const out = { ...r };
  const num = (p: Prop) => (typeof out[p] === 'number' ? (out[p] as number) : 0);
  const w = num('width');
  const h = num('height');
  switch (m.kind) {
    case 'pulse':
      out.scaleX = num('scaleX') * (1 + 0.06 * swell);
      out.scaleY = num('scaleY') * (1 + 0.06 * swell);
      break;
    case 'blink':
      out.opacity = num('opacity') * (1 - 0.75 * swell);
      break;
    case 'swing':
      out.rotation = num('rotation') + 3 * wave;
      break;
    case 'float':
      out.y = num('y') + Math.max(4, h * 0.05) * wave;
      break;
    case 'shake':
      out.x = num('x') + Math.max(3, w * 0.01) * wave;
      break;
    case 'kenBurns':
      out.scaleX = num('scaleX') * (1 + 0.08 * swell);
      out.scaleY = num('scaleY') * (1 + 0.08 * swell);
      break;
    // A scrolling folder's content (engine/lists.ts), moved along its axis: negative = left / up.
    case 'crawl': {
      // In from `lead` px away, then on by `distance` (once, or round and round).
      const d = m.distance ?? 0;
      const lead = m.lead ?? 0;
      const speed = d / m.period;
      const s = speed * t;
      const u = s - lead;
      along(m, out, num, s < lead ? lead - s : m.once ? -Math.min(u, d) : d > 0 ? -(u % d) : 0);
      break;
    }
    case 'step': {
      // One page of `distance` px every `pause` s, sliding in 0.6 s (eased in and out).
      const slide = 0.6;
      const pageDur = (m.pause ?? 0) + slide;
      if (pageDur <= 0) break;
      const steps = Math.max(1, m.steps ?? 1);
      const n = Math.floor(t / pageDur);
      const k = n % steps;
      const f = Math.min(1, Math.max(0, ((t % pageDur) - (m.pause ?? 0)) / slide));
      const eased = f < 0.5 ? 4 * f * f * f : 1 - ((-2 * f + 2) * (-2 * f + 2) * (-2 * f + 2)) / 2;
      along(m, out, num, -(k + eased) * (m.distance ?? 0));
      break;
    }
  }
  return out;
}

/** `offset` added to x or y (the motion's axis). */
function along(m: Motion, out: Resolved, num: (p: Prop) => number, offset: number) {
  if (m.axis === 'y') out.y = num('y') + offset;
  else out.x = num('x') + offset;
}
