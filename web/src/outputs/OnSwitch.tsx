import { tc } from '../i18n';

/** An on/off switch (outputs and inputs). */
export function OnSwitch({ on, onChange, label, mini }: { on: boolean; onChange: (on: boolean) => void; label?: string; mini?: boolean }) {
  return (
    <label className={`switch oc-switch ${mini ? 'mini' : ''}`} title={on ? tc('output', 'On') : tc('output', 'Off')} onPointerDown={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}
