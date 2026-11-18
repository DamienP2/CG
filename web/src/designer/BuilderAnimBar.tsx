// Above the timeline of the Widget Builder: the widget's drawing and its internal animations. The one
// chosen shows its keyframes on the timeline, with what starts it and its length.
import { useEffect } from 'react';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import type { AnimTrigger, WidgetAnim } from '../engine/types';
import { t } from '../i18n';
import { useApp } from '../store';
import { Dropdown } from '../ui/Dropdown';
import { confirmDialog } from '../ui/dialogs';
import { adoptStrayKeys, deleteAnim, newAnim, selectAnim, setAnim, timelineFps } from './builderAnims';
import { useDesigner } from './designerStore';

type On = AnimTrigger['on'];

/** What starts it, in words (the chips). */
export function triggerText(tr: AnimTrigger): string {
  switch (tr.on) {
    case 'arrival':
      return t('When it arrives on air');
    case 'logic':
      return t('By its Logic (« Play »)');
    case 'change':
      return t('When {var} changes', { var: tr.var || '…' });
    case 'increase':
      return t('When {var} goes up', { var: tr.var || '…' });
    case 'decrease':
      return t('When {var} goes down', { var: tr.var || '…' });
    case 'while':
      return t('Looping while {var} {test} {value}', { var: tr.var || '…', test: TESTS.find(([k]) => k === tr.test)?.[1] ?? tr.test, value: tr.value });
  }
}

const TESTS: [Extract<AnimTrigger, { on: 'while' }>['test'], string][] = [
  ['lt', '<'],
  ['le', '≤'],
  ['gt', '>'],
  ['ge', '≥'],
  ['eq', '='],
  ['ne', '≠'],
];

export function BuilderAnimBar() {
  const tpl = useDesigner((s) => s.template);
  const anims = tpl?.builder?.anims ?? [];
  const current = tpl?.builderAnim ?? null;
  const vars = tpl?.builder?.vars ?? [];
  // Keyframes set on the drawing make an animation (the drawing has none).
  const stray = useDesigner((s) => !!s.template?.builder && !s.template.builderAnim && s.template.layers.some((l) => Object.values(l.tracks ?? {}).some((k) => (k as unknown[] | undefined)?.length)));
  useEffect(() => {
    if (stray && adoptStrayKeys()) useApp.getState().toast(t('Keyframes belong to an animation: a new one holds them.'), 'info');
  }, [stray]);
  if (!tpl?.builder) return null;
  const a = anims.find((x) => x.id === current);
  const fps = timelineFps();
  const setTrigger = (x: WidgetAnim, on: On) => {
    const v = vars[0]?.name ?? '';
    const tr: AnimTrigger = on === 'arrival' || on === 'logic' ? { on } : on === 'while' ? { on, var: v, test: 'le', value: '5' } : { on, var: 'var' in x.trigger ? x.trigger.var : v };
    setAnim(x.id, { trigger: tr });
  };
  return (
    <div className="bl-anims">
      <div className="bl-anim-tabs" role="tablist" aria-label={t('Drawing and animations')}>
        <button role="tab" aria-selected={!current} className={!current ? 'on' : ''} onClick={() => selectAnim(null)} title={t('The widget as drawn: no keyframes')}>
          <Pencil size={12} /> {t('Drawing')}
        </button>
        {anims.map((x) => (
          <button key={x.id} role="tab" aria-selected={current === x.id} className={`anim ${current === x.id ? 'on' : ''}`} onClick={() => selectAnim(x.id)} title={triggerText(x.trigger)}>
            <Zap size={12} /> {x.name}
          </button>
        ))}
        <button className="bl-anim-add" onClick={() => newAnim()} title={t('An animation of the widget: keyframes started by its arrival, a variable or its Logic')}>
          <Plus size={13} /> {t('Animation')}
        </button>
      </div>
      {a ? (
        <div className="bl-anim-edit">
          <input className="bl-anim-name" aria-label={t('Name of the animation')} value={a.name} onChange={(e) => setAnim(a.id, { name: e.target.value }, `anim-name-${a.id}`)} />
          <span className="bl-anim-lbl">{t('Starts')}</span>
          <Dropdown
            value={a.trigger.on}
            onChange={(on: On) => setTrigger(a, on)}
            options={[
              { value: 'arrival', label: t('When it arrives on air') },
              { value: 'change', label: t('When a variable changes') },
              { value: 'increase', label: t('When a variable goes up') },
              { value: 'decrease', label: t('When a variable goes down') },
              { value: 'while', label: t('Looping while…') },
              { value: 'logic', label: t('By its Logic (« Play »)') },
            ]}
          />
          {'var' in a.trigger && (
            <Dropdown
              value={a.trigger.var}
              placeholder={t('Variable')}
              options={vars.map((v) => ({ value: v.name, label: v.name }))}
              onChange={(v) => setAnim(a.id, { trigger: { ...(a.trigger as Extract<AnimTrigger, { var: string }>), var: v } })}
            />
          )}
          {a.trigger.on === 'while' && (
            <>
              <Dropdown value={a.trigger.test} options={TESTS.map(([value, label]) => ({ value, label }))} onChange={(test) => setAnim(a.id, { trigger: { ...(a.trigger as Extract<AnimTrigger, { on: 'while' }>), test } })} />
              <input className="bl-anim-val" aria-label={t('Value')} value={a.trigger.value} onChange={(e) => setAnim(a.id, { trigger: { ...(a.trigger as Extract<AnimTrigger, { on: 'while' }>), value: e.target.value } }, `anim-val-${a.id}`)} />
            </>
          )}
          <span className="bl-anim-lbl">{t('Length')}</span>
          <input
            className="bl-anim-len"
            type="number"
            min={0.1}
            step={0.1}
            aria-label={t('Length in seconds')}
            value={Math.round((tpl.duration / fps) * 100) / 100}
            onChange={(e) => +e.target.value > 0 && useDesigner.getState().update((d) => void (d.duration = Math.max(1, Math.round(+e.target.value * fps))), `anim-len-${a.id}`)}
          />
          <span className="bl-anim-lbl">s</span>
          <span className="grow" />
          <button
            className="icon-btn ghost"
            title={t('Delete the animation')}
            onClick={() => void confirmDialog({ title: t('Delete “{name}”?', { name: a.name }), confirm: t('Delete'), danger: true }).then((ok) => ok && deleteAnim(a.id))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : (
        <div className="bl-anim-edit hint">{anims.length ? t('Choose an animation to see its keyframes on the timeline.') : t('The widget as drawn. Its entry and exit are its templates’: here, the animations of its own life (a score that pulses, a clock that blinks).')}</div>
      )}
    </div>
  );
}
