import { useShallow } from 'zustand/react/shallow';
import { feedTable, tableKeyAt, tablePortOf, unfeedTable } from '../designer/DataCanvas';
import { useDesigner } from '../designer/designerStore';
import { useSources } from '../data/dataStore';
import { newFieldKey } from '../engine/settings';
import type { FieldKind, Layer, Template } from '../engine/types';
import { t } from '../i18n';
import { useDesk, useSocial } from '../social/socialStore';
import { useApp } from '../store';
import { FirstSection, Row, Section, Seg, Select, setPath, Text, useBound } from './kit';

/*
 * « Source » of a widget that can read the project's Social source (what
 * the moderation lets through): by hand, or one of the readings below.
 * Picking a value makes the template variable bound to the source's path
 * and writes {{variable}} in the layer. Picking a list (the approved
 * messages) builds the Data canvas chain instead, as wiring a data set's
 * All rows by hand does: source › approved → data set → the layer's table
 * port, which reads {{key__table}}. The Data canvas shows either wiring.
 */

/** One layer property fed by a path of the Social source. */
export interface SocialTarget {
  path: string;
  /** The path in the source's value; `{tag}` is the hashtag picked. */
  from: string;
  kind: FieldKind;
  /** The variable's label. */
  label: string;
  /** A list: it comes through a data set into the layer's table port (`path` is the old variable's place). */
  table?: boolean;
  /** Where the layer keeps what the port held by hand while the data set feeds it (back by hand, it returns). */
  hand?: string;
}

/** A reading of the Social source. */
export interface SocialPick {
  id: string;
  label: string;
  fields: SocialTarget[];
}

export const socialSourceId = (projectId: string) => `social-${projectId}`;

/** The readings most widgets share. */
export const ON_AIR = {
  name: (path: string): SocialPick => ({ id: 'name', label: t('On air · name'), fields: [{ path, from: 'onAir.name', kind: 'text', label: t('Name') }] }),
  text: (path: string): SocialPick => ({ id: 'text', label: t('On air · message'), fields: [{ path, from: 'onAir.text', kind: 'multiline', label: t('Message') }] }),
  city: (path: string): SocialPick => ({ id: 'city', label: t('On air · city'), fields: [{ path, from: 'onAir.city', kind: 'text', label: t('City') }] }),
  platform: (path: string): SocialPick => ({ id: 'platform', label: t('On air · platform'), fields: [{ path, from: 'onAir.platform', kind: 'text', label: t('Platform') }] }),
  platformName: (path: string): SocialPick => ({ id: 'platformName', label: t('On air · platform name'), fields: [{ path, from: 'onAir.platformName', kind: 'text', label: t('Platform') }] }),
  time: (path: string): SocialPick => ({ id: 'time', label: t('On air · time'), fields: [{ path, from: 'onAir.time', kind: 'text', label: t('Time') }] }),
  avatar: (path: string): SocialPick => ({ id: 'avatar', label: t('On air · avatar'), fields: [{ path, from: 'onAir.avatar', kind: 'image', label: t('Avatar') }] }),
  photo: (path: string): SocialPick => ({ id: 'photo', label: t('On air · photo'), fields: [{ path, from: 'onAir.photo', kind: 'image', label: t('Photo') }] }),
  approved: (path: string, hand?: string): SocialPick => ({ id: 'approved', label: t('Approved messages'), fields: [{ path, from: 'approved', kind: 'multiline', label: t('Approved messages'), table: true, hand }] }),
  count: (path: string): SocialPick => ({ id: 'count', label: t('Approved · count'), fields: [{ path, from: 'count', kind: 'number', label: t('Approved messages') }] }),
  tag: (path: string): SocialPick => ({ id: 'tag', label: t('Hashtag · name'), fields: [{ path, from: 'hashtags.{tag}.tag', kind: 'text', label: t('Hashtag') }] }),
  tagCount: (path: string): SocialPick => ({ id: 'tagCount', label: t('Hashtag · total'), fields: [{ path, from: 'hashtags.{tag}.count', kind: 'number', label: t('Hashtag total') }] }),
  tagPerMin: (path: string): SocialPick => ({ id: 'tagPerMin', label: t('Hashtag · per minute'), fields: [{ path, from: 'hashtags.{tag}.perMin', kind: 'number', label: t('Per minute') }] }),
  tagSeries: (path: string): SocialPick => ({ id: 'tagSeries', label: t('Hashtag · curve'), fields: [{ path, from: 'hashtags.{tag}.series', kind: 'multiline', label: t('Hashtag curve') }] }),
};

const token = (v: unknown) => /^\{\{(\w+)\}\}$/.exec(String(v ?? '').trim())?.[1];
const getPath = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
const TAG = /^hashtags\.([^.]+)\./;

/** The data set in the layer's table port when it reads `list` of the source (the chain built here, or by hand). */
function datasetAt(layer: Layer, template: Template, source: string, list: string) {
  const key = tableKeyAt(layer);
  const ds = key ? template.datasets?.find((d) => d.key === key) : undefined;
  return ds && ds.source === source && ds.list === list ? ds : null;
}

/** The variable `{{key}}` at `path` of the layer when it is bound to the source: its field. */
function fieldAt(layer: Layer, template: Template, source: string, path: string) {
  const key = token(getPath(layer, path));
  const field = key ? template.fields.find((x) => x.key === key) : undefined;
  return field?.binding?.source === source ? field : undefined;
}

/** What the layer reads now: the pick, and the hashtag of its first field. */
function current(layer: Layer, template: Template, source: string, picks: SocialPick[]): { pick: SocialPick | null; tag: string } {
  for (const p of picks) {
    const f = p.fields[0];
    if (f.table && datasetAt(layer, template, source, f.from)) return { pick: p, tag: '' };
    // A variable (a value; a list in a template made before the data set).
    const b = fieldAt(layer, template, source, f.path)?.binding;
    if (!b?.path) continue;
    const tag = TAG.exec(b.path)?.[1] ?? '';
    if (b.path === f.from.replace('{tag}', tag)) return { pick: p, tag };
  }
  return { pick: null, tag: '' };
}

/** The variable at `path` of the layer goes: the layer gets its default back, the field goes when no other layer reads it. */
function unwireField(tpl: Template, l: Layer, source: string, path: string) {
  const field = fieldAt(l, tpl, source, path);
  if (!field) return;
  setPath(l, path, field.default);
  const still = tpl.layers.some((x) => x.id !== l.id && JSON.stringify(x).includes(`{{${field.key}}}`));
  if (!still) tpl.fields = tpl.fields.filter((x) => x.key !== field.key);
}

/** The data set chain into the layer's table port, from `f.from` of the source (what it held by hand is kept at `f.hand`). */
function wireTable(tpl: Template, l: Layer, source: string, f: SocialTarget) {
  const port = tablePortOf(l);
  if (!port) return;
  if (datasetAt(l, tpl, source, f.from)) return;
  // A variable there (an older template), or another data set: it goes first.
  unwireField(tpl, l, source, f.path);
  if (tableKeyAt(l)) unfeedTable(tpl, l);
  const was = getPath(l, port);
  if (f.hand && typeof was === 'string' && was.trim() && !token(was)) setPath(l, f.hand, was);
  feedTable(tpl, l, source, f.from);
}

/** The chain goes (with its data set when nothing else reads it); the port gets back what it held by hand. */
function unwireTable(tpl: Template, l: Layer, f: SocialTarget) {
  const port = tablePortOf(l);
  if (!port) return;
  unfeedTable(tpl, l);
  const r = l as unknown as Record<string, unknown>;
  if (!f.hand) return;
  const hand = r[f.hand];
  if (typeof hand === 'string' && hand) setPath(l, port, hand);
  delete r[f.hand];
}

/**
 * The « Source » rows of a widget. `label`: what the layer shows (« Messages »,
 * « Text »…). `picks`: the readings offered (the first is the default).
 * `after`: more to set on the layer when a reading is picked (the ticker's
 * item format).
 */
export function SocialSource({ label, picks, after }: { label: string; picks: SocialPick[]; after?: (l: Layer) => void }) {
  const projectId = useApp((s) => s.project?.id ?? '');
  const source = socialSourceId(projectId);
  const sources = useSources();
  const { template, update } = useDesigner(useShallow((s) => ({ template: s.template, update: s.update })));
  const { obj } = useBound();
  const layer = obj as Layer;
  if (!projectId || !template || !layer?.id || !sources.some((s) => s.id === source)) return null;
  return <Rows label={label} picks={picks} after={after} projectId={projectId} source={source} template={template} update={update} layer={layer} />;
}

function Rows({ label, picks, after, projectId, source, template, update, layer }: { label: string; picks: SocialPick[]; after?: (l: Layer) => void; projectId: string; source: string; template: Template; update: (recipe: (t: Template) => void, key?: string) => void; layer: Layer }) {
  useDesk(projectId);
  const desk = useSocial((s) => (s.projectId === projectId ? s.desk : null));
  const { pick, tag } = current(layer, template, source, picks);
  const needsTag = (p: SocialPick | null) => !!p?.fields.some((f) => f.from.includes('{tag}'));
  const tags = (desk?.hashtags ?? []).map((h) => h.tag.replace(/^#/, ''));

  const wire = (p: SocialPick, tagName: string) =>
    update((tpl) => {
      const l = tpl.layers.find((x) => x.id === layer.id);
      if (!l) return;
      for (const f of p.fields) {
        if (f.table) {
          wireTable(tpl, l, source, f);
          continue;
        }
        const path = f.from.replace('{tag}', tagName);
        const was = getPath(l, f.path);
        const key = token(was);
        const field = key ? tpl.fields.find((x) => x.key === key) : undefined;
        if (field && field.binding?.source === source) {
          field.binding = { source, path };
          field.kind = f.kind;
          field.label = f.label;
          continue;
        }
        const k = newFieldKey(tpl, `social ${f.label}`);
        tpl.fields.push({ key: k, label: f.label, kind: f.kind, default: key ? '' : String(was ?? ''), binding: { source, path } });
        setPath(l, f.path, `{{${k}}}`);
      }
      after?.(l);
    });
  const unwire = () =>
    update((tpl) => {
      const l = tpl.layers.find((x) => x.id === layer.id);
      if (!l || !pick) return;
      for (const f of pick.fields) {
        if (f.table && datasetAt(l, tpl, source, f.from)) unwireTable(tpl, l, f);
        else unwireField(tpl, l, source, f.path);
      }
    });

  const status = () => {
    if (!pick || !desk) return null;
    const from = pick.fields[0].from.replace('{tag}', tag);
    if (from === 'approved' || from === 'count') return t('{n} approved', { n: desk.approved.length });
    if (from.startsWith('onAir')) return desk.onAir ? t('On air: {name}', { name: desk.onAir.author }) : t('Nothing on air');
    if (tag) {
      const h = desk.hashtags.find((x) => x.tag.replace(/^#/, '') === tag);
      return h ? t('{n} messages', { n: h.count.toLocaleString() }) : t('Hashtag not counted');
    }
    return null;
  };

  // Open by default (it comes after the sources are loaded: it never claims the first place).
  return (
    <FirstSection.Provider value={null}>
      <Section id="social-source" title={t('Source')}>
      <Seg
        label={label}
        value={pick ? 'social' : 'hand'}
        options={[
          ['hand', t('By hand')],
          ['social', t('Project Social')],
        ]}
        onChange={(v) => (v === 'hand' ? unwire() : wire(picks[0], tag || tags[0] || ''))}
      />
      {pick && picks.length > 1 && <Select label={t('Reading')} value={pick.id} options={picks.map((p) => [p.id, p.label] as [string, string])} onChange={(id) => wire(picks.find((p) => p.id === id)!, tag || tags[0] || '')} />}
      {pick && needsTag(pick) && (tags.length ? <Select label={t('Hashtag')} value={tags.includes(tag) ? tag : ''} options={[...(tags.includes(tag) ? [] : [['', '—'] as [string, string]]), ...tags.map((x) => [x, `#${x}`] as [string, string])]} onChange={(x) => wire(pick, x)} /> : <Text label={t('Hashtag')} value={tag} placeholder="JT20H" onChange={(x) => wire(pick, x.replace(/^#/, '').trim())} />)}
      {pick && (
        <Row label="">
          <span className="soc-wired">
            <i className="status-dot ok" />
            {t('Wired')}
            {status() && <span className="muted"> · {status()}</span>}
          </span>
        </Row>
      )}
      </Section>
    </FirstSection.Provider>
  );
}
