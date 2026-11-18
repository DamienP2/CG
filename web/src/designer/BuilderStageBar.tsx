// The Widget Builder's Graphisme toolbar: the 8 px grid, and the picture the widget is seen in.
import { Grid3x3 } from 'lucide-react';
import type { Project } from '../engine/types';
import { t } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { PLACES } from '../builder/FormatPreview';
import { useBuilderUi, type PreviewPlace } from './builderUi';

/** The picture of « Voir dans »: the project's, wide (16:9) or tall (9:16). */
export function previewPicture(project: Project, kind: 'h' | 'v') {
  const long = Math.max(project.width, project.height);
  const short = Math.min(project.width, project.height);
  return kind === 'h' ? { width: long, height: short } : { width: short, height: long };
}

export function BuilderStageBar() {
  const { grid, preview, place } = useBuilderUi();
  const set = useBuilderUi.setState;
  return (
    <div className="bl-stagebar">
      <button className={`btn small ${grid ? 'on' : ''}`} disabled={preview !== 'none'} aria-pressed={grid} title={t('Show the 8 px grid; the elements snap to it')} onClick={() => set({ grid: !grid })}>
        <Grid3x3 size={13} /> {t('Grid')}
      </button>
      <span className="bl-sb-label">{t('Seen in')}</span>
      <div className="segmented">
        {(
          [
            ['none', t('Widget size')],
            ['h', '16:9'],
            ['v', '9:16'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" className={preview === k ? 'on' : ''} onClick={() => set({ preview: k })}>
            {l}
          </button>
        ))}
      </div>
      {preview !== 'none' && <Dropdown value={place} options={PLACES.map(([value, label]) => ({ value, label: t(label) }))} onChange={(v: PreviewPlace) => set({ place: v })} />}
    </div>
  );
}
