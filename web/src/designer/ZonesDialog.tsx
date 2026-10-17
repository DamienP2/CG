import { designTemplates } from '../engine/drafts';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { Zone } from '../engine/types';
import { useApp } from '../store';

const COLORS = ['#7c5cff', '#ff3b5c', '#22c55e', '#f5a524', '#38bdf8', '#e879f9', '#14b8a6', '#f97316'];

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
    setZones([{ id: `zone-${n}`, name: `Zone ${n}`, layer: 0, color: COLORS[zones.length % COLORS.length], transition: 'sequential' }, ...zones]);
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
          <h2>Zones of “{project.name}”</h2>
          <button className="icon-btn ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="hint">
          A zone is an area of the screen that shows <strong>one template at a time</strong> (lower third, bug, ticker, full screen…). Several zones can be on air together. Taking a template in a busy zone first plays
          the out animation of the graphic on air (<em>sequential</em>), or replaces it at once (<em>cut</em>). The top of the list is in front.
        </p>
        <div className="zone-list">
          {zones.map((z, i) => (
            <div key={i} className="zone-row" style={{ ['--zone' as string]: z.color }}>
              <input type="color" value={z.color.slice(0, 7)} title="Colour" onChange={(e) => edit(i, { color: e.target.value })} />
              <input className="zone-name-input" value={z.name} placeholder="Name" onChange={(e) => edit(i, { name: e.target.value })} />
              <select value={z.transition} onChange={(e) => edit(i, { transition: e.target.value as Zone['transition'] })} title="When a template is taken while the zone is busy">
                <option value="sequential">Out, then in</option>
                <option value="cut">Cut</option>
              </select>
              <span className="muted small">{used(z.id) ? `${used(z.id)} use(s)` : 'unused'}</span>
              <button className="icon-btn ghost" title="Bring forward" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={13} />
              </button>
              <button className="icon-btn ghost" title="Send backward" disabled={i === zones.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={13} />
              </button>
              <button className="icon-btn ghost" title={used(z.id) ? 'Move its templates and rundown items to another zone first' : 'Remove'} disabled={!!used(z.id) || zones.length === 1} onClick={() => setZones(zones.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <footer>
          <button className="btn" onClick={add}>
            <Plus size={14} /> Add zone
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || zones.some((z) => !z.name.trim())} onClick={save}>
            Save zones
          </button>
        </footer>
      </div>
    </div>
  );
}
