// The Widget Builder's editor (/project/<id>/builder/<widget>): the widget's name and where it is
// kept, its spaces (Graphisme, Panneau, Logique), its draft saved as it goes and « Publish the
// version », which gives it to the templates. The Designer draws the Graphisme space.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, History, Puzzle, Share2, X } from 'lucide-react';
import { t, tn, useLang } from '../i18n';
import { useApp } from '../store';
import { closeBuilder, builderTemplate, defOf, openedFromTemplate, publishBuilt, unpublished } from '../designer/builder';
import { useBuilderUi } from '../designer/builderUi';
import { useDesigner } from '../designer/designerStore';
import { PanelBuilder } from './PanelBuilder';
import { DataSpace } from './DataSpace';
import { draftOf, getVersion, HOST_PROJECT, listVersions, shareWidget, useWidgets, type WidgetVersion } from '../widgetLibrary';
import { BUILT_ICONS } from '../widgets/built';

const Designer = lazy(() => import('../designer/Designer').then((m) => ({ default: m.Designer })));
const LogicEditor = lazy(() => import('../designer/LogicEditor').then((m) => ({ default: m.LogicEditor })));

type Space = 'graphics' | 'panel' | 'logic' | 'data';
const SPACES: [Space, string][] = [
  ['graphics', 'Graphics'],
  ['panel', 'Panel'],
  ['logic', 'Logic'],
  ['data', 'Data'],
];

export function BuilderPage({ widgetId }: { widgetId: string }) {
  const project = useApp((s) => s.project);
  const own = useApp((s) => s.project?.widgets?.find((d) => d.id === widgetId));
  const shared = useWidgets((s) => s.shared.find((d) => d.id === widgetId));
  const stored = own ?? shared;
  const base = useDesigner((s) => (s.builder?.defId === widgetId ? s.base : null));
  const saving = useBuilderUi((s) => s.saving);
  const [space, setSpace] = useState<Space>('graphics');
  const [versions, setVersions] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const ready = !!base?.builder;
  // What the Builder has made, against what the templates have.
  const working = useMemo(() => (base ? defOf(base) : null), [base]);
  const pending = useMemo(() => !!stored && !!working && unpublished(stored, draftOf(working)), [stored, working]);
  const isProject = !!own && project?.id !== HOST_PROJECT;
  const Icon = BUILT_ICONS[working?.icon ?? stored?.icon ?? ''] ?? Puzzle;
  const rev = stored?.rev ?? 0;

  // « Open its Logic » (a component of the panel): the Logic space.
  useEffect(() => {
    const open = () => setSpace('logic');
    window.addEventListener('strata:open-triggers', open);
    return () => window.removeEventListener('strata:open-triggers', open);
  }, []);
  useEffect(() => {
    if (stored) document.title = `${stored.name} · Widget Builder`;
  }, [stored?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = async () => {
    if (!base || publishing) return;
    setPublishing(true);
    const next = await publishBuilt(base);
    setPublishing(false);
    if (next) useApp.getState().toast(isProject ? t('Version {n} published: the templates of the project use it.', { n: next.rev ?? 0 }) : t('Version {n} published: each project gets it when it opens.', { n: next.rev ?? 0 }), 'info');
  };

  return (
    <div className="wb-editor">
      <div className="wb-bar">
        <button className="btn ghost small" onClick={() => void closeBuilder()} title={openedFromTemplate() ? t('Back to the template') : t('Back to the widgets')}>
          <ArrowLeft size={14} /> {openedFromTemplate() ? t('Template') : t('Widgets')}
        </button>
        <span className="wb-icon">
          <Icon size={16} />
        </span>
        <input
          className="wb-name"
          aria-label={t('Name of the widget')}
          value={base?.name ?? stored?.name ?? ''}
          disabled={!ready}
          onChange={(e) => useDesigner.getState().update((d) => void (d.name = e.target.value), 'builder-name')}
        />
        <span className={`wb-kept-chip ${isProject ? '' : 'shared'}`} title={isProject ? t('Only in this project') : t('Every project can use it')}>
          {isProject ? project?.name : t('Kept in: shared')}
          {rev ? ` · v${rev}` : ''}
        </span>
        {isProject && (
          <button className="icon-btn ghost" title={t('Share with every project')} onClick={() => void shareWidget(widgetId)}>
            <Share2 size={14} />
          </button>
        )}
        <nav className="wb-spaces-nav" aria-label={t('Spaces of the Widget Builder')}>
          {SPACES.map(([k, label]) => (
            <button key={k} className={space === k ? 'on' : ''} aria-current={space === k ? 'page' : undefined} onClick={() => setSpace(k)}>
              <span className={`wb-dot ${k}`} />
              {t(label)}
            </button>
          ))}
        </nav>
        <span className={`wb-saved ${saving ? 'busy' : ''}`}>{saving ? t('Saving…') : pending ? (rev ? t('Draft saved · not published') : t('Draft saved · never published')) : t('Published')}</span>
        <button className="btn small" disabled={!ready} onClick={() => setVersions(true)}>
          <History size={13} /> {t('Versions')}
        </button>
        <button className="btn small primary" disabled={!ready || !pending || publishing} onClick={() => void publish()} title={t('The templates using the widget get this version')}>
          {t('Publish version {n}', { n: rev + 1 })}
        </button>
      </div>
      <div className="wb-stage">
        {/* Always there: the Designer keeps the widget open and saves its draft, whatever the space shown. */}
        <div className={`wb-space ${space === 'graphics' ? 'on' : ''}`}>
          <Suspense fallback={<div className="loading">{t('Loading…')}</div>}>
            <Designer builder={widgetId} />
          </Suspense>
        </div>
        {ready && space === 'panel' && (
          <div className="wb-space on">
            <PanelBuilder />
          </div>
        )}
        {ready && space === 'data' && (
          <div className="wb-space on">
            <DataSpace />
          </div>
        )}
        {ready && space === 'logic' && (
          <div className="wb-space on wb-logic-space">
            <Suspense fallback={<div className="loading">{t('Loading…')}</div>}>
              <LogicEditor onClose={() => setSpace('graphics')} />
            </Suspense>
          </div>
        )}
      </div>
      {versions && <VersionsDialog widgetId={widgetId} current={rev} onClose={() => setVersions(false)} />}
    </div>
  );
}

/** The published versions of the widget: one can be taken back as the draft. */
function VersionsDialog({ widgetId, current, onClose }: { widgetId: string; current: number; onClose: () => void }) {
  const [list, setList] = useState<WidgetVersion[] | null>(null);
  const lang = useLang((s) => s.lang);
  useEffect(() => {
    listVersions(widgetId)
      .then(setList)
      .catch(() => setList([]));
  }, [widgetId]);
  const takeBack = async (rev: number) => {
    try {
      const v = await getVersion(widgetId, rev);
      if (!v.def) return;
      const tpl = builderTemplate({ ...v.def, id: widgetId, draft: undefined });
      // An edit like any other: Undo gives back the draft before.
      useDesigner.getState().update((d) => {
        d.name = tpl.name;
        d.layers = tpl.layers;
        d.fields = tpl.fields;
        d.logic = tpl.logic;
        d.builder = { ...tpl.builder!, id: widgetId };
      });
      useApp.getState().toast(t('Version {n} taken back as the draft: publish it to give it to the templates.', { n: rev }), 'info');
      onClose();
    } catch (e) {
      useApp.getState().toast((e as Error).message, 'error');
    }
  };
  const when = (ms: number) => (ms ? new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) : t('before versions were kept'));
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal wb-versions" role="dialog" aria-label={t('Versions')} onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{t('Versions')}</h2>
          <span className="grow" />
          <button type="button" className="icon-btn ghost" title={t('Close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="wb-muted">{t('Each « Publish » keeps a version (the latest 30). Taking one back makes it the draft.')}</p>
        {!list ? (
          <div className="loading">{t('Loading…')}</div>
        ) : !list.length ? (
          <p className="wb-muted">{current ? t('No version kept yet: the next « Publish » keeps one.') : t('The widget was never published.')}</p>
        ) : (
          <ul className="wb-vlist">
            {list.map((v) => (
              <li key={v.rev}>
                <b>v{v.rev}</b>
                <span>
                  {when(v.at)}
                  {v.by ? ` · ${v.by}` : ''}
                </span>
                {v.rev === current ? <em>{t('Published now')}</em> : <span />}
                <button className="btn small" onClick={() => void takeBack(v.rev)}>
                  {t('Take back')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer>
          <span className="wb-muted">{tn(list?.length ?? 0, '{n} version', '{n} versions')}</span>
        </footer>
      </div>
    </div>
  );
}
