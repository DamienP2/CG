// The « How… » step of the Logic: the way the take, out, resume or clear after it goes.
import { useRef } from 'react';
import type { Easing, How, HowMode, Side } from '../engine/types';
import { Dropdown } from '../ui/Dropdown';
import { NumberField, Segmented } from '../ui/fields';
import { EasingCurve } from './Inspector';
import { t } from '../i18n';

export const HOW_DEFAULT: How = { mode: 'fade', seconds: 0.5, easing: { type: 'easeInOut' }, side: 'left' };
export const howOf = (n: Partial<How>): How => ({ ...HOW_DEFAULT, ...n, easing: n.easing ?? HOW_DEFAULT.easing });

const MODES: { value: HowMode; label: string }[] = [
  { value: 'cut', label: 'Cut' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'anim', label: 'Anim.' },
];

const CURVES: { label: string; easing: Easing }[] = [
  { label: 'Linear', easing: { type: 'linear' } },
  { label: 'Smooth', easing: { type: 'easeInOut' } },
  { label: 'Slows down', easing: { type: 'easeOut' } },
  { label: 'Speeds up', easing: { type: 'easeIn' } },
  { label: 'Overshoot', easing: { type: 'back' } },
  { label: 'Bezier', easing: { type: 'bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
];

const SIDES: { value: Side; label: string }[] = [
  { value: 'left', label: 'the left' },
  { value: 'right', label: 'the right' },
  { value: 'top', label: 'the top' },
  { value: 'bottom', label: 'the bottom' },
];

/** The settings of a How… node. */
export function HowBody({ how, set }: { how: How; set: (patch: Partial<How>, key?: string) => void }) {
  const moves = how.mode === 'fade' || how.mode === 'slide';
  return (
    <>
      <Segmented value={how.mode} onChange={(mode) => set({ mode: mode as HowMode })} options={MODES.map((m) => ({ value: m.value, label: t(m.label) }))} />
      {moves && (
        <>
          <label className="lx-field">
            <span>{t('Duration')}</span>
            <NumberField value={how.seconds} min={0.04} max={10} step={0.1} precision={2} suffix="s" onChange={(x) => set({ seconds: Math.max(0.04, x) }, 'how-s')} />
          </label>
          {how.mode === 'slide' && (
            <label className="lx-field">
              <span>{t('Through')}</span>
              <Dropdown value={how.side} options={SIDES.map((s) => ({ value: s.value, label: t(s.label) }))} onChange={(side) => set({ side: side as Side })} />
            </label>
          )}
          <div className="lx-curves">
            {CURVES.map((c) => (
              <button key={c.label} className={how.easing.type === c.easing.type ? 'on' : ''} title={t(c.label)} onClick={() => set({ easing: c.easing.type === 'bezier' && how.easing.type === 'bezier' ? how.easing : c.easing })}>
                <EasingCurve easing={c.easing.type === 'bezier' && how.easing.type === 'bezier' ? how.easing : c.easing} size={54} />
                <span>{t(c.label)}</span>
              </button>
            ))}
          </div>
          {how.easing.type === 'bezier' && <BezierPad easing={how.easing} onChange={(easing) => set({ easing }, 'how-b')} />}
        </>
      )}
    </>
  );
}

/** A free curve: its two handles dragged. */
function BezierPad({ easing, onChange }: { easing: Easing & { type: 'bezier' }; onChange: (e: Easing) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const W = 200;
  const H = 110;
  const pad = 12;
  const px = (x: number) => pad + x * (W - pad * 2);
  const py = (y: number) => H - pad - y * (H - pad * 2);
  const drag = (which: 1 | 2) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = ref.current;
    if (!svg) return;
    const move = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, ((ev.clientX - r.left) / r.width) * (W / (W - pad * 2)) - pad / (W - pad * 2)));
      const y = Math.min(1.5, Math.max(-0.5, ((r.bottom - ev.clientY) / r.height) * (H / (H - pad * 2)) - pad / (H - pad * 2)));
      const r2 = (v: number) => Math.round(v * 100) / 100;
      onChange(which === 1 ? { ...easing, x1: r2(x), y1: r2(y) } : { ...easing, x2: r2(x), y2: r2(y) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const { x1, y1, x2, y2 } = easing;
  return (
    <svg ref={ref} className="lx-bezier" viewBox={`0 0 ${W} ${H}`} onPointerDown={(e) => e.stopPropagation()}>
      <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} className="diag" />
      <line x1={px(0)} y1={py(0)} x2={px(x1)} y2={py(y1)} className="arm" />
      <line x1={px(1)} y1={py(1)} x2={px(x2)} y2={py(y2)} className="arm" />
      <path d={`M ${px(0)} ${py(0)} C ${px(x1)} ${py(y1)}, ${px(x2)} ${py(y2)}, ${px(1)} ${py(1)}`} className="curve" />
      <circle cx={px(x1)} cy={py(y1)} r={6} onPointerDown={drag(1)} />
      <circle cx={px(x2)} cy={py(y2)} r={6} onPointerDown={drag(2)} />
    </svg>
  );
}
