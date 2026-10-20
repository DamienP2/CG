import type { Tone } from './format';
import './perf.css';

/** A thin bar filled to `value` of `max`, coloured by tone. `mark`: a tick (e.g. the budget). */
export function Bar({ value, max = 100, tone, mark, className = '' }: { value: number; max?: number; tone: Tone; mark?: number; className?: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className={`perf-bar tone-${tone} ${className}`}>
      <span className="perf-bar-fill" style={{ width: `${w}%` }} />
      {mark !== undefined && max > 0 && <span className="perf-bar-mark" style={{ left: `${Math.min(100, (mark / max) * 100)}%` }} />}
    </span>
  );
}

export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  return <span className={`perf-dot tone-${tone}`} title={title} />;
}
