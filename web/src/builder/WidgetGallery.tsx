// The Widget Builder's gallery (/widgets): the shared widgets and those of each project the user
// sees, the ways to start a new one, and each widget's card (open, duplicate, share, delete).
import { useEffect, useMemo, useState } from 'react';
import { Copy, LayoutTemplate, MoreHorizontal, Pencil, Plus, Puzzle, Search, Share2, Trash2 } from 'lucide-react';
import type { WidgetCategory, WidgetDef } from '../engine/types';
import { newId } from '../engine/evaluate';
import { t, tn, useLang } from '../i18n';
import { api, can, useApp } from '../store';
import { ContextMenu } from '../ui/ContextMenu';
import { confirmDialog } from '../ui/dialogs';
import { Dropdown } from '../ui/Dropdown';
import { Empty } from '../ui/Empty';
import { Segmented } from '../ui/fields';
import { openBuilderPage, openSharedBuilder, unpublished } from '../designer/builder';
import { neverPublished, saveDef, useWidgets, workingCopy, type WidgetHome } from '../widgetLibrary';
import { BUILT_ICONS } from '../widgets/built';
import { NewWidgetDialog } from './NewWidgetDialog';
import { WidgetThumb } from './WidgetThumb';

export const CATEGORIES: [WidgetCategory, string][] = [
  ['sport', 'Sport'],
  ['info', 'News'],
  ['election', 'Election'],
  ['weather', 'Weather'],
  ['social', 'Social networks'],
  ['other', 'Other'],
];

/** A widget of the gallery: where it is kept. */
interface Entry {
  def: WidgetDef;
  /** Its project (none: shared). */
  project?: { id: string; name: string };
  /** Projects (shared) or templates (a project's) using it. */
  uses: number;
  canEdit: boolean;
}

type Where = 'all' | 'shared' | string;
type Sort = 'recent' | 'name' | 'used';

export function WidgetGallery() {
  const user = useApp((s) => s.auth?.user);
  const { shared, projects, uses, loaded } = useWidgets();
  useEffect(() => void useWidgets.getState().load(), []);
  // Opened from a project's Library: its widgets first.
  const [where, setWhere] = useState<Where>(() => new URLSearchParams(location.search).get('project') ?? 'all');
  const [cat, setCat] = useState<WidgetCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [creating, setCreating] = useState<{ from?: WidgetDef } | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; e: Entry } | null>(null);
  const lang = useLang((s) => s.lang);
  const canShared = can.design(user) && (can.admin(user) || !user?.projects);

  const entries = useMemo<Entry[]>(
    () => [
      ...shared.map((def) => ({ def, uses: uses[def.id] ?? 0, canEdit: canShared })),
      ...projects.flatMap((p) => p.widgets.map((def) => ({ def, project: { id: p.id, name: p.name }, uses: p.uses[def.id] ?? 0, canEdit: p.canEdit }))),
    ],
    [shared, projects, uses, canShared],
  );
  const q = query.trim().toLowerCase();
  const list = entries
    .filter((e) => where === 'all' || (where === 'shared' ? !e.project : e.project?.id === where))
    .filter((e) => cat === 'all' || (workingCopy(e.def).category ?? 'other') === cat)
    .filter((e) => !q || `${e.def.name} ${workingCopy(e.def).description ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => (sort === 'name' ? a.def.name.localeCompare(b.def.name) : sort === 'used' ? b.uses - a.uses : (b.def.at ?? 0) - (a.def.at ?? 0)));

  const open = (e: Entry) => (e.project ? openBuilderPage(e.def.id, { project: e.project.id }) : openSharedBuilder(e.def.id));
  const home = (e: Entry): WidgetHome => (e.project ? { project: e.project.id } : 'shared');
  const duplicate = async (e: Entry) => {
    const copy: WidgetDef = { ...structuredClone(e.def), id: newId(), name: t('{name} (copy)', { name: e.def.name }) };
    await saveDef(copy, home(e));
  };
  const share = async (e: Entry) => {
    if (!e.project) return;
    try {
      await api('POST', `/api/projects/${encodeURIComponent(e.project.id)}/widgets/${encodeURIComponent(e.def.id)}/share`);
      await useWidgets.getState().load();
    } catch (err) {
      useApp.getState().toast((err as Error).message, 'error');
    }
  };
  const remove = async (e: Entry) => {
    if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: e.def.name }), confirm: t('Delete'), danger: true }))) return;
    try {
      if (e.project) await api('DELETE', `/api/projects/${encodeURIComponent(e.project.id)}/widgets/${encodeURIComponent(e.def.id)}`);
      else await api('DELETE', `/api/widgets/${encodeURIComponent(e.def.id)}`);
      await useWidgets.getState().load();
    } catch (err) {
      useApp.getState().toast((err as Error).message, 'error');
    }
  };
  const date = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(lang, { day: 'numeric', month: 'short' }) : '');
  const canCreate = canShared || projects.some((p) => p.canEdit) || can.design(user);
  const starters = shared.filter((d) => !neverPublished(d)).slice(0, 4);
  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }));

  return (
    <div className="wb-gallery">
      <header className="wb-head">
        <div>
          <h1>{t('Widget Builder')}</h1>
          <p>{t('Widgets are living graphics: a design with its animations, a control panel for the Operator, logic and data. They are then placed in the templates of the Designer.')}</p>
        </div>
        <span className="grow" />
        {canCreate && (
          <button className="btn primary" onClick={() => setCreating({})}>
            <Plus size={14} /> {t('New widget')}
          </button>
        )}
      </header>

      {canCreate && (
        <div className="wb-starts">
          <button className="wb-start blank" onClick={() => setCreating({})}>
            <LayoutTemplate size={20} />
            <b>{t('Blank')}</b>
            <span>{t('Choose its size, then draw.')}</span>
          </button>
          {starters.map((d) => {
            const Icon = BUILT_ICONS[d.icon ?? ''] ?? Puzzle;
            return (
              <button key={d.id} className="wb-start" onClick={() => setCreating({ from: d })}>
                <Icon size={20} />
                <b>{t('From “{name}”', { name: d.name })}</b>
                <span>{d.description ?? ''}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="wb-filters">
        <label className="wb-search">
          <Search size={14} />
          <input value={query} placeholder={t('Search a widget')} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Segmented
          value={where === 'all' || where === 'shared' ? where : 'project'}
          onChange={(v) => setWhere(v === 'project' ? (projects[0]?.id ?? 'all') : v)}
          options={[
            { value: 'all', label: `${t('All')} · ${entries.length}` },
            { value: 'shared', label: `${t('Shared ones')} · ${shared.length}` },
            ...(projects.length ? [{ value: 'project', label: t('Of a project') }] : []),
          ]}
        />
        {where !== 'all' && where !== 'shared' && <Dropdown className="wb-sort" value={where} options={projectOptions} onChange={setWhere} />}
        <Segmented value={cat} onChange={setCat} options={[{ value: 'all' as const, label: t('Every category') }, ...CATEGORIES.filter(([c]) => entries.some((e) => (workingCopy(e.def).category ?? 'other') === c)).map(([value, label]) => ({ value, label: t(label) }))]} />
        <span className="grow" />
        <span className="wb-muted">{t('Sort by')}</span>
        <Dropdown
          className="wb-sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'recent', label: t('Recently changed') },
            { value: 'name', label: t('Name') },
            { value: 'used', label: t('Most used') },
          ]}
        />
      </div>

      {!loaded ? (
        <div className="loading">{t('Loading…')}</div>
      ) : list.length ? (
        <div className="wb-cards">
          {list.map((e) => {
            const w = workingCopy(e.def);
            const draft = unpublished(e.def);
            const anims = w.anims?.length ?? 0;
            const sources = w.sources?.length ?? 0;
            return (
              <div key={e.def.id} className="wb-card" onDoubleClick={() => e.canEdit && void open(e)}>
                <button className="wb-thumb" onClick={() => e.canEdit && void open(e)} title={e.canEdit ? t('Open in the Widget Builder') : undefined}>
                  <WidgetThumb def={neverPublished(e.def) ? w : e.def} />
                  <span className={`wb-kept ${e.project ? '' : 'shared'}`}>{e.project ? e.project.name : t('Kept in: shared')}</span>
                  {draft && <span className="wb-draft">{neverPublished(e.def) ? t('Never published') : t('Changes not published')}</span>}
                </button>
                <div className="wb-body">
                  <div className="wb-title">
                    <b title={e.def.name}>{e.def.name}</b>
                    {e.canEdit && (
                      <button className="icon-btn ghost" title={t('More')} onClick={(ev) => setMenu({ at: { x: ev.clientX, y: ev.clientY }, e })}>
                        <MoreHorizontal size={15} />
                      </button>
                    )}
                  </div>
                  <p>{w.description || t('No description.')}</p>
                  <div className="wb-stats">
                    <span className="wb-chip ctl">{tn(w.controls.length, '{n} control', '{n} controls')}</span>
                    {!!anims && <span className="wb-chip anim">{tn(anims, '{n} animation', '{n} animations')}</span>}
                    {!!sources && <span className="wb-chip data">{tn(sources, '{n} source', '{n} sources')}</span>}
                    {!!(e.def.rev ?? 0) && <span className="wb-chip">v{e.def.rev}</span>}
                  </div>
                  <div className="wb-foot">
                    <span>{e.uses ? (e.project ? tn(e.uses, 'In {n} template', 'In {n} templates') : tn(e.uses, 'In {n} project', 'In {n} projects')) : t('Unused')}</span>
                    {e.def.at && <span>{t('Changed {date}', { date: date(e.def.at) })}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="lib-void">
          <Empty icon={Puzzle} text={entries.length ? t('No widget matches.') : t('No widget yet.')} />
        </div>
      )}

      {menu && (
        <ContextMenu
          at={menu.at}
          onClose={() => setMenu(null)}
          items={[
            { icon: <Pencil size={13} />, label: t('Open'), run: () => open(menu.e) },
            { icon: <Copy size={13} />, label: t('Duplicate'), run: () => duplicate(menu.e) },
            menu.e.project && canShared ? { icon: <Share2 size={13} />, label: t('Share with every project'), run: () => share(menu.e) } : null,
            { icon: <Trash2 size={13} />, label: menu.e.uses ? t('Used: it cannot be deleted') : t('Delete'), danger: true, disabled: menu.e.uses > 0, run: () => remove(menu.e) },
          ]}
        />
      )}
      {creating && <NewWidgetDialog from={creating.from} canShared={canShared} preferProject={where !== 'all' && where !== 'shared' ? where : undefined} onClose={() => setCreating(null)} />}
    </div>
  );
}
