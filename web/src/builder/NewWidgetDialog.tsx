// A new widget: its name, where it is kept, what it starts from (blank at a size, or a copy) and
// its category. It opens in the Widget Builder, unpublished.
import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { WidgetCategory, WidgetDef } from '../engine/types';
import { t } from '../i18n';
import { can, useApp } from '../store';
import { Dropdown } from '../ui/Dropdown';
import { Segmented } from '../ui/fields';
import { newWidget } from '../designer/builder';
import { useWidgets, workingCopy, type WidgetHome } from '../widgetLibrary';
import { CATEGORIES } from './WidgetGallery';

/** Usual sizes of a blank widget. */
const SIZES: { id: string; label: string; width: number; height: number }[] = [
  { id: 'third', label: 'Lower third · 1200 × 160', width: 1200, height: 160 },
  { id: 'band', label: 'Full-width band · 1920 × 80', width: 1920, height: 80 },
  { id: 'score', label: 'Score bug · 760 × 64', width: 760, height: 64 },
  { id: 'square', label: 'Square · 600 × 600', width: 600, height: 600 },
  { id: 'panel', label: 'Side panel · 560 × 900', width: 560, height: 900 },
  { id: 'custom', label: 'Custom size', width: 600, height: 120 },
];

export function NewWidgetDialog({ from, canShared, preferProject, onClose }: { from?: WidgetDef; canShared: boolean; preferProject?: string; onClose: () => void }) {
  const user = useApp((s) => s.auth?.user);
  const projects = useApp((s) => s.projects);
  const shared = useWidgets((s) => s.shared);
  const others = useWidgets((s) => s.projects);
  // Where the user may make one: the shared widgets, or a project they design (none outside their scope).
  const homes = useMemo(
    () => [...(canShared ? [{ value: 'shared', label: t('Shared with every project') }] : []), ...(can.design(user) ? projects.filter((p) => !user?.projects || user.projects.includes(p.id)).map((p) => ({ value: p.id, label: t('Project: {name}', { name: p.name }) })) : [])],
    [canShared, projects, user],
  );
  const [home, setHome] = useState(preferProject && homes.some((h) => h.value === preferProject) ? preferProject : (homes[0]?.value ?? ''));
  const all = useMemo(() => [...shared, ...others.flatMap((p) => p.widgets)], [shared, others]);
  const [start, setStart] = useState<'blank' | 'copy'>(from ? 'copy' : 'blank');
  const [source, setSource] = useState(from?.id ?? all[0]?.id ?? '');
  const copied = all.find((d) => d.id === source);
  const [name, setName] = useState(from ? t('{name} (copy)', { name: from.name }) : '');
  const [size, setSize] = useState('third');
  const [custom, setCustom] = useState({ width: 600, height: 120 });
  const [cat, setCat] = useState<WidgetCategory>((from && workingCopy(from).category) ?? 'other');
  const [busy, setBusy] = useState(false);

  const dims = size === 'custom' ? custom : SIZES.find((s) => s.id === size)!;
  const ok = !!name.trim() && !!home && (start === 'blank' || !!copied) && dims.width > 0 && dims.height > 0;
  const create = async () => {
    if (!ok || busy) return;
    setBusy(true);
    const where: WidgetHome = home === 'shared' ? 'shared' : { project: home };
    const made = await newWidget(where, { name: name.trim(), category: cat, ...(start === 'copy' ? { from: copied } : { width: Math.round(dims.width), height: Math.round(dims.height) }) });
    setBusy(false);
    if (made) onClose();
  };

  return (
    <div className="modal-back" onPointerDown={onClose}>
      <form
        className="modal wb-new"
        role="dialog"
        aria-label={t('New widget')}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <header>
          <h2>{t('New widget')}</h2>
          <span className="grow" />
          <button type="button" className="icon-btn ghost" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <label className="wb-field">
          <span>{t('Name')}</span>
          <input autoFocus value={name} placeholder={t('Score, ticker, results…')} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="wb-field">
          <span>{t('Kept in')}</span>
          {homes.length ? <Dropdown value={home} options={homes} onChange={setHome} /> : <em>{t('You cannot make widgets.')}</em>}
        </div>
        <div className="wb-field">
          <span>{t('Starts from')}</span>
          <Segmented
            value={start}
            onChange={setStart}
            options={[
              { value: 'blank', label: t('Blank') },
              { value: 'copy', label: t('A copy of a widget'), disabled: !all.length },
            ]}
          />
        </div>
        {start === 'blank' ? (
          <div className="wb-field">
            <span>{t('Size')}</span>
            <Dropdown value={size} options={SIZES.map((s) => ({ value: s.id, label: t(s.label) }))} onChange={setSize} />
            {size === 'custom' && (
              <div className="wb-size">
                <input type="number" min={8} max={7680} value={custom.width} onChange={(e) => setCustom({ ...custom, width: +e.target.value })} aria-label={t('Width')} />
                <span>×</span>
                <input type="number" min={8} max={4320} value={custom.height} onChange={(e) => setCustom({ ...custom, height: +e.target.value })} aria-label={t('Height')} />
                <span>px</span>
              </div>
            )}
          </div>
        ) : (
          <div className="wb-field">
            <span>{t('Widget copied')}</span>
            <Dropdown value={source} options={all.map((d) => ({ value: d.id, label: d.name }))} onChange={setSource} />
          </div>
        )}
        <div className="wb-field">
          <span>{t('Category')}</span>
          <Dropdown value={cat} options={CATEGORIES.map(([value, label]) => ({ value, label: t(label) }))} onChange={setCat} />
        </div>
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!ok || busy}>
            {t('Create and open')}
          </button>
        </footer>
      </form>
    </div>
  );
}
