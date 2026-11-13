// Builder › a folder repeated once per row of a « List of elements » (Répéter), going by in its box
// (Défilement); an element inside it shown for some rows only, coloured from a column (Dans la liste).
// Drawn by engine/lists.ts and crates/cg-core/src/lists.rs.
import { parseHex, toHex } from '../engine/evaluate';
import type { Color, InList, Layer, ListRepeat, Roll, WidgetVar } from '../engine/types';
import { t } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { ColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { findLayer, useDesigner } from './designerStore';
import { Group, RepeatSettings } from './Inspector';
import { allRows } from './rowsVar';

const ROLL: Roll = { mode: 'continuous', dir: 'left', by: 'speed', speed: 120, duration: 30, pause: 4, fade: 0 };

function useEdit(layer: Layer) {
  const update = useDesigner((s) => s.update);
  return (fn: (l: Layer) => void, key?: string) => update((tpl) => void fn(findLayer(tpl, layer.id)!), key);
}

/** The widget's « List of elements » variables. */
const useRowVars = () => (useDesigner((s) => s.template?.builder?.vars) ?? []).filter((v) => v.kind === 'rows');

/** The list folder an element is in (its nearest), if any. */
export function listFolderOf(layers: Layer[], layer: Layer): Layer | undefined {
  for (let p = layers.find((l) => l.id === layer.parent); p; p = layers.find((l) => l.id === p!.parent)) if (p.list) return p;
  return undefined;
}

/** Répéter: once, a number of copies (the Repeater), or one per row of a list. */
export function RepeatGroup({ layer }: { layer: Layer }) {
  const edit = useEdit(layer);
  const lists = useRowVars();
  const mode = layer.list ? 'rows' : layer.repeat ? 'count' : 'none';
  const r = layer.list;
  const setList = (patch: Partial<ListRepeat>, key?: string) => edit((l) => void (l.list = { ...l.list!, ...patch }), key);
  return (
    <Group id="b-repeat" title={t('Repeat')} defaultOpen>
      <div className="pp-general">
        <div className="row">
          <span className="prop-label">{t('Copies')}</span>
          <Segmented
            value={mode}
            options={[
              { value: 'none', label: t('Once') },
              { value: 'count', label: t('Number') },
              { value: 'rows', label: t('One per row') },
            ]}
            onChange={(v) =>
              edit((l) => {
                delete l.repeat;
                delete l.list;
                if (v === 'count') l.repeat = { count: 5, layout: 'row', gap: 8, off: 0.25 };
                if (v === 'rows') l.list = { key: lists[0]?.name ?? '', layout: 'row', gap: 24 };
              })
            }
          />
        </div>
        {mode === 'count' && <RepeatSettings layer={layer} />}
        {r && (
          <>
            <div className="row">
              <span className="prop-label">{t('List')}</span>
              <Dropdown value={r.key} placeholder={t('Choose a list')} options={lists.map((v) => ({ value: v.name, label: v.name }))} onChange={(key) => setList({ key })} />
            </div>
            <div className="row">
              <span className="prop-label">{t('Layout')}</span>
              <Segmented
                value={r.layout}
                options={[
                  { value: 'row', label: t('Row') },
                  { value: 'column', label: t('Column') },
                  { value: 'grid', label: t('Grid') },
                ]}
                onChange={(v) => setList({ layout: v as ListRepeat['layout'] })}
              />
            </div>
            {r.layout === 'grid' && (
              <div className="row">
                <span className="prop-label">{t('Per row')}</span>
                <NumberField value={r.cols ?? 3} min={1} max={20} onChange={(v) => setList({ cols: Math.max(1, Math.round(v)) }, `list-c-${layer.id}`)} />
              </div>
            )}
            <div className="row">
              <span className="prop-label">{t('Gap')}</span>
              <NumberField value={r.gap} suffix="px" onChange={(v) => setList({ gap: v }, `list-g-${layer.id}`)} />
            </div>
          </>
        )}
      </div>
    </Group>
  );
}

/** Défilement: the folder's content going by in its box (clipped to it). */
export function RollGroup({ layer }: { layer: Layer }) {
  const edit = useEdit(layer);
  const r = layer.roll;
  const set = (patch: Partial<Roll>, key?: string) => edit((l) => void (l.roll = { ...ROLL, ...l.roll, ...patch }), key);
  return (
    <Group id="b-roll" title={t('Scrolling')} defaultOpen>
      <div className="pp-general">
        <div className="row">
          <span className="prop-label">{t('Mode')}</span>
          <Segmented
            value={r?.mode ?? 'none'}
            options={[
              { value: 'none', label: t('None') },
              { value: 'continuous', label: t('Continuous') },
              { value: 'one', label: t('One by one') },
            ]}
            onChange={(v) =>
              edit((l) => {
                if (v === 'none') delete l.roll;
                else {
                  l.roll = { ...ROLL, ...l.roll, mode: v as Roll['mode'] };
                  if (l.type === 'group') l.clip = true;
                }
              })
            }
          />
        </div>
        {r && (
          <>
            <div className="row">
              <span className="prop-label">{t('Direction')}</span>
              <Segmented
                value={r.dir}
                options={[
                  { value: 'left', label: '←' },
                  { value: 'up', label: '↑' },
                ]}
                onChange={(v) => set({ dir: v as Roll['dir'] })}
              />
            </div>
            {r.mode === 'continuous' ? (
              <>
                <div className="row">
                  <span className="prop-label">{t('Set by')}</span>
                  <Segmented
                    value={r.by}
                    options={[
                      { value: 'speed', label: t('Speed') },
                      { value: 'duration', label: t('Duration') },
                    ]}
                    onChange={(v) => set({ by: v as Roll['by'] })}
                  />
                </div>
                {r.by === 'speed' ? (
                  <div className="row">
                    <span className="prop-label">{t('Speed')}</span>
                    <NumberField value={r.speed} min={1} max={2000} suffix="px/s" onChange={(v) => set({ speed: Math.max(1, v) }, `roll-s-${layer.id}`)} />
                  </div>
                ) : (
                  <div className="row">
                    <span className="prop-label">{t('Duration')}</span>
                    <NumberField value={r.duration} min={1} max={3600} suffix="s" onChange={(v) => set({ duration: Math.max(1, v) }, `roll-d-${layer.id}`)} />
                  </div>
                )}
              </>
            ) : (
              <div className="row">
                <span className="prop-label">{t('Pause')}</span>
                <NumberField value={r.pause} min={0.5} max={120} precision={1} suffix="s" onChange={(v) => set({ pause: Math.max(0.5, v) }, `roll-p-${layer.id}`)} />
              </div>
            )}
            <div className="row">
              <span className="prop-label">{t('Faded edges')}</span>
              <NumberField value={r.fade} min={0} max={600} suffix="px" onChange={(v) => set({ fade: Math.max(0, v) }, `roll-f-${layer.id}`)} />
            </div>
          </>
        )}
      </div>
    </Group>
  );
}

const TESTS = () => [
  { value: 'filled', label: t('is not empty') },
  { value: 'empty', label: t('is empty') },
  { value: 'is', label: t('is') },
  { value: 'isNot', label: t('is not') },
];

/** The values a column takes: its choices, else those of the list's rows at the start. */
function valuesOf(v: WidgetVar | undefined, col: string): string[] {
  const c = v?.columns?.find((x) => x.name === col);
  if (c?.choices?.length) return c.choices;
  return [...new Set(allRows(v?.initial).map((r) => r[col] ?? '').filter(Boolean))];
}

/** Dans la liste: an element of a list folder shown for some rows only, its colour from a column. */
export function InListGroup({ layer, folder }: { layer: Layer; folder: Layer }) {
  const edit = useEdit(layer);
  const v = (useDesigner((s) => s.template?.builder?.vars) ?? []).find((x) => x.name === folder.list?.key);
  const cols = (v?.columns ?? []).map((c) => c.name);
  const il = layer.inList ?? {};
  const set = (patch: Partial<InList>) =>
    edit((l) => {
      const next = { ...l.inList, ...patch };
      if (!next.when) delete next.when;
      if (!next.colors?.length) delete next.colors;
      l.inList = next.when || next.colors ? next : undefined;
    });
  const color = il.colors?.[0];
  const prop = layer.type === 'text' ? 'fill' : 'fill';
  return (
    <Group id="b-inlist" title={t('In the list')} defaultOpen>
      <div className="pp-general">
        <div className="row">
          <span className="prop-label">{t('Shown if')}</span>
          <span className="bl-pair">
            <Dropdown value={il.when?.col ?? ''} options={[{ value: '', label: t('Always') }, ...cols.map((c) => ({ value: c, label: c }))]} onChange={(col) => set({ when: col ? { col, test: il.when?.test ?? 'filled', value: il.when?.value } : undefined })} />
            {il.when && <Dropdown value={il.when.test} options={TESTS()} onChange={(test) => set({ when: { ...il.when!, test: test as NonNullable<InList['when']>['test'] } })} />}
          </span>
        </div>
        {il.when && (il.when.test === 'is' || il.when.test === 'isNot') && (
          <div className="row">
            <span className="prop-label">{t('Value')}</span>
            <TextInput value={il.when.value ?? ''} commitOnBlur onChange={(value) => set({ when: { ...il.when!, value } })} />
          </div>
        )}
        <div className="row">
          <span className="prop-label">{t('Colour from')}</span>
          <Dropdown value={color?.col ?? ''} options={[{ value: '', label: '—' }, ...cols.map((c) => ({ value: c, label: c }))]} onChange={(col) => set({ colors: col ? [{ prop, col, map: color?.col === col ? color.map : {} }] : undefined })} />
        </div>
        {color &&
          valuesOf(v, color.col).map((val) => (
            <div key={val} className="row">
              <span className="prop-label bl-val-name">{val}</span>
              <ColorField value={parseHex(color.map[val] ?? '') ?? ([1, 1, 1, 1] as Color)} onChange={(c) => set({ colors: [{ ...color, map: { ...color.map, [val]: toHex(c, true) } }] })} />
            </div>
          ))}
      </div>
    </Group>
  );
}
