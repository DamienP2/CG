import { designTemplates } from '../engine/drafts';
import { Dropdown } from '../ui/Dropdown';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { Zone } from '../engine/types';
import { useApp } from '../store';
import { t, tn } from '../i18n';

const COLORS = ['#8fa3ff', '#ff3b5c', '#22c55e', '#f5a524', '#38bdf8', '#e879f9', '#14b8a6', '#f97316'];

/**
 * Screen zones of the project: each shows one template at a time, zones are
 * on air independently. The list is the stacking order (top = front).
 */
export function ZonesDialog({ onClose }: { onClose: () => void }) {
  const { project, saveZones } = useApp();
  // Front-most first, like a layer panel.
  const [zones, setZones] = useState<Zone[]>(() => [...(project?.zones ?? [])].sort((a, b) => b.layer - a.layer));
  const [busy, setBusy] = useState(false);
  if (!project) return null;

  const used = (id: string) => designTemplates(project).filter((t) => t.zone === id).length + project.rundown.filter((r) => r.zone === id).length;
  const edit = (i: number, patch: Partial<Zone>) => setZones(zones.map((z, j) => (i === j ? { ...z, ...patch } : z)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= zones.length) return;
    const next = [...zones];
    [next[i], next[j]] = [next[j], next[i]];
    setZones(next);
  };
  const add = () => {
    let n = zones.length + 1;
    while (zones.some((z) => z.id === `zone-${n}`)) n++;
    setZones([{ id: `zone-${n}`, name: t('Zone {n}', { n }), layer: 0, color: COLORS[zones.length % COLORS.length], transition: 'sequential' }, ...zones]);
  };
  const save = async () => {
    setBusy(true);
    // Stacking positions follow the list order (bottom = 10, 20, 30…).
    const ordered = zones.map((z, i) => ({ ...z, name: z.name.trim(), layer: (zones.length - i) * 10 }));
    if (await saveZones(ordered)) onClose();
    setBusy(false);
  };

  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal wide" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{t('Zones of “{name}”', { name: project.name })}</h2>
          <button className="icon-btn ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="hint">
          {t('A zone is an area of the screen that shows {one} (lower third, bug, ticker, full screen…). Several zones can be on air together. Taking a template in a busy zone first plays the out animation of the graphic on air ({sequential}), or replaces it at once ({cut}). The top of the list is in front.')
            .split(/\{(\w+)\}/)
            .map((part, i) => (i % 2 ? <Fragment key={i}>{part === 'one' ? <strong>{t('one template at a time')}</strong> : <em>{part === 'cut' ? t('cut') : t('sequential')}</em>}</Fragment> : part))}
        </p>
        <div className="zone-list">
          {zones.map((z, i) => (
            <div key={i} className="zone-row" style={{ ['--zone' as string]: z.color }}>
              <input type="color" value={z.color.slice(0, 7)} title={t('Colour')} onChange={(e) => edit(i, { color: e.target.value })} />
              <input className="zone-name-input" value={z.name} placeholder={t('Name')} onChange={(e) => edit(i, { name: e.target.value })} />
              <span className="dd-cell" style={{ flex: '0 0 130px' }} title={t('When a template is taken while the zone is busy')}>
                <Dropdown
                  value={z.transition}
                  onChange={(v) => edit(i, { transition: v as Zone['transition'] })}
                  options={[
                    { value: 'sequential', label: t('Out, then in') },
                    { value: 'cut', label: t('Cut') },
                  ]}
                />
              </span>
              <span className="muted small">{used(z.id) ? tn(used(z.id), '{n} use', '{n} uses') : t('unused')}</span>
              <button className="icon-btn ghost" title={t('Bring forward')} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={13} />
              </button>
              <button className="icon-btn ghost" title={t('Send backward')} disabled={i === zones.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={13} />
              </button>
              <button className="icon-btn ghost" title={used(z.id) ? t('Move its templates and rundown items to another zone first') : t('Remove')} disabled={!!used(z.id) || zones.length === 1} onClick={() => setZones(zones.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <footer>
          <button className="btn" onClick={add}>
            <Plus size={14} /> {t('Add zone')}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || zones.some((z) => !z.name.trim())} onClick={save}>
            {t('Save zones')}
          </button>
        </footer>
      </div>
    </div>
  );
}
