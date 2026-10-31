import { CircleAlert, Copy, Database, FileUp, KeyRound, MessagesSquare, Plus, RefreshCw, Rss, Save, Sheet, Trash2, Upload, Webhook, Braces, Code2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DataSource, DataSourceInfo } from '../engine/types';
import { api, can, useApp } from '../store';
import { JsonTree } from './JsonTree';
import { isBad, issuesOf, type DataIssue, type RuledSource } from './dataRules';
import { hasWarnings, RulesTabs, SourceRules, SumIssues, WarnLine } from './SourceRules';
import { useData, useSources } from './dataStore';
import { AddSourceMenu, SocialEditor, SocialSection, type SocialPick } from './SocialSources';
import { Segmented } from '../ui/fields';
import { confirmDialog } from '../ui/dialogs';
import { navigate } from '../router';
import { locale, t, tc, tn } from '../i18n';
import { errorProps } from '../ui/serverError';
import { InfoTip } from '../ui/InfoTip';

const KINDS: { type: DataSource['type']; label: string; hint: string; icon: typeof Database }[] = [
  { type: 'json', label: 'JSON API', hint: 'Any web service answering JSON (scores, weather, elections…)', icon: Braces },
  { type: 'csv', label: 'CSV / Google Sheet', hint: 'A CSV address, or a Google Sheets link shared with anyone who has it', icon: Sheet },
  { type: 'rss', label: 'RSS / Atom feed', hint: 'News headlines for tickers', icon: Rss },
  { type: 'xml', label: 'XML', hint: 'Sports or election feeds in XML', icon: Code2 },
  { type: 'push', label: 'Push (API / file)', hint: 'Automation or a person sends the values (JSON, CSV or XML)', icon: Webhook },
];

const blank = (type: DataSource['type'], project?: string | null): DataSource =>
  ({
    id: '',
    name: '',
    ...(project ? { project } : {}),
    interval: 30,
    enabled: true,
    ...(type === 'push' ? { type, format: 'json' } : type === 'csv' ? { type, url: '', header: true } : { type, url: '' }),
  }) as DataSource;

const ago = (ms?: number | null) => {
  if (!ms) return t('never');
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? t('{n}s ago', { n: s }) : s < 3600 ? t('{n} min ago', { n: Math.round(s / 60) }) : new Date(ms).toLocaleString(locale());
};

/**
 * Data connectors: where live values come from. In a project (`projectId`):
 * its own connectors, the shared ones listed below; in the main menu: the
 * connectors shared by every project.
 */
export function DataPage({ projectId = null }: { projectId?: string | null }) {
  const all = useSources();
  const sources = all.filter((s) => (projectId ? s.project === projectId : !s.project));
  const shared = projectId ? all.filter((s) => !s.project) : [];
  const user = useApp((s) => s.auth?.user);
  const edit = can.design(user);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<DataSource | null>(null);
  // A social network connection (main menu only).
  const [social, setSocial] = useState<SocialPick | null>(null);
  const current = [...sources, ...shared].find((s) => s.id === sel) ?? null;
  // The main menu's page: connections set up and tested, nothing more.
  const setup = !projectId;
  const item = (s: DataSourceInfo) => {
    const K = KINDS.find((k) => k.type === s.type)!;
    return (
      <button
        key={s.id}
        className={`data-item ${sel === s.id && !draft && !social ? 'selected' : ''}`}
        onClick={() => {
          setDraft(null);
          setSocial(null);
          setSel(s.id);
        }}
      >
        <K.icon size={14} />
        <span>
          <strong>{s.name}</strong>
          <em>{t(K.label)}</em>
        </span>
        <i className={`status-dot ${s.error ? 'err' : s.updatedAt ? 'ok' : 'idle'}`} title={errorProps(s.error).title} />
      </button>
    );
  };
  useEffect(() => {
    if (!sel && sources.length && !draft) setSel(sources[0].id);
  }, [sources, sel, draft]);

  return (
    <div className="data-page">
      <aside className={`data-list ${setup ? 'dp-blocks' : ''}`}>
        {setup ? (
          <>
            <section className="dp-block">
              <header>
                <span className="dp-ic">
                  <Database size={14} />
                </span>
                <h3>{t('Data sources')}</h3>
                {edit && (
                  <button className="icon-btn" title={t('New data source')} onClick={() => (setSocial(null), setSel(null), setDraft(blank('json', null)))}>
                    <Plus size={15} />
                  </button>
                )}
              </header>
              {sources.map((s) => item(s))}
              {!sources.length && !draft && (
                <div className="ux3-empty-mini">
                  <Database size={14} /> {t('No shared source')}
                </div>
              )}
            </section>
            <section className="dp-block">
              <header>
                <span className="dp-ic">
                  <MessagesSquare size={14} />
                </span>
                <h3>{t('Social networks')}</h3>
                {edit && <AddSourceMenu onSocial={(platform) => (setDraft(null), setSocial({ platform }))} />}
              </header>
              <SocialSection bare selected={social && 'id' in social ? social.id : null} onSelect={(id) => (setDraft(null), setSocial({ id }))} />
            </section>
          </>
        ) : (
          <>
          <header>
            <Database size={15} />
            <h2>{projectId ? t('Data') : t('Shared data sources')}</h2>
            <div className="spacer" />
            {edit && projectId && (
              <button
                className="icon-btn"
                title={t('New data source')}
                onClick={() => {
                  setSel(null);
                  setDraft(blank('json', projectId));
                }}
              >
                <Plus size={15} />
              </button>
            )}
          </header>
          {sources.map((s) => {
            const K = KINDS.find((k) => k.type === s.type)!;
            return (
              <button
                key={s.id}
                className={`data-item ${sel === s.id && !draft && !social ? 'selected' : ''}`}
                onClick={() => {
                  setDraft(null);
                  setSocial(null);
                  setSel(s.id);
                }}
              >
                <K.icon size={14} />
                <span>
                  <strong>{s.name}</strong>
                  <em title={errorProps(s.error).title}>{s.error ? errorProps(s.error).text : hasWarnings(s) ? <WarnLine source={s} /> : s.type === 'push' ? t('{kind} · updated {ago}', { kind: t(K.label), ago: ago(s.updatedAt) }) : t('{kind} · checked {ago}', { kind: t(K.label), ago: ago(s.checkedAt) })}</em>
                </span>
                <i className={`status-dot ${s.error ? 'err' : hasWarnings(s) ? 'dr-warn' : s.updatedAt ? 'ok' : 'idle'}`} />
              </button>
            );
          })}
          {!sources.length && !draft && (
            <div className="ux3-empty-mini">
              <Database size={14} /> {projectId ? t('No source in this project') : t('No shared source')}
            </div>
          )}
          {projectId && (
            <>
              <div className="data-sep">
                <span>{t('Shared by every project')}</span>
                <button className="link-btn" title={t('Manage the shared sources (main menu > Data)')} onClick={() => navigate('/data')}>
                  {t('Manage')}
                </button>
              </div>
              {shared.map((s) => {
                const K = KINDS.find((k) => k.type === s.type)!;
                return (
                  <button key={s.id} className={`data-item shared ${sel === s.id && !draft ? 'selected' : ''}`} onClick={() => (setDraft(null), setSel(s.id))}>
                    <K.icon size={14} />
                    <span>
                      <strong data-badge={t('shared')}>{s.name}</strong>
                      <em title={errorProps(s.error).title}>{s.error ? errorProps(s.error).text : hasWarnings(s) ? <WarnLine source={s} /> : t('{kind} · shared', { kind: t(K.label) })}</em>
                    </span>
                    <i className={`status-dot ${s.error ? 'err' : hasWarnings(s) ? 'dr-warn' : s.updatedAt ? 'ok' : 'idle'}`} />
                  </button>
                );
              })}
              {!shared.length && (
                <div className="ux3-empty-mini">
                  <Database size={14} /> {t('No shared source')}
                </div>
              )}
            </>
          )}
          </>
        )}
      </aside>
      <main className="data-main">
        {social ? (
          <SocialEditor pick={social} editable={edit} setup={setup} onSaved={(id) => setSocial({ id })} onClose={() => setSocial(null)} />
        ) : draft ? (
          setup ? (
            <SetupEditor key="new" source={draft} isNew editable={edit} onSaved={(id) => (setDraft(null), setSel(id))} onCancel={() => setDraft(null)} />
          ) : (
          <SourceEditor key="new" source={draft} isNew editable={edit} onSaved={(id) => (setDraft(null), setSel(id))} onCancel={() => setDraft(null)} />
          )
        ) : current && setup ? (
          <SetupEditor key={current.id} source={current} editable={edit} onSaved={() => {}} onDeleted={() => setSel(null)} />
        ) : current ? (
          // A shared source is changed in the main menu's Data page.
          <SourceEditor key={current.id} source={current} info={current} editable={edit && (!projectId || current.project === projectId)} onSaved={() => {}} onDeleted={() => setSel(null)} />
        ) : (
          <div className="data-empty">
            <Database size={28} />
            {!setup && <p>{t('Pick a source, or create one with +.')}</p>}
          </div>
        )}
      </main>
    </div>
  );
}

function SourceEditor({ source, info, isNew, editable, onSaved, onCancel, onDeleted }: { source: DataSource; info?: DataSourceInfo; isNew?: boolean; editable: boolean; onSaved: (id: string) => void; onCancel?: () => void; onDeleted?: () => void }) {
  const toast = useApp((s) => s.toast);
  const load = useData((s) => s.load);
  const version = useData((s) => (info ? (s.versions[info.id] ?? 0) : 0));
  const [s, setS] = useState<DataSource>(source);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ value: unknown; error?: string | null } | null>(null);
  const [raw, setRaw] = useState(false);
  const [pushKey, setPushKey] = useState('');
  const [tab, setTab] = useState<'source' | 'rules'>('source');
  const rules = (s as RuledSource).rules ?? [];
  const issues = issuesOf(info);
  const me = useApp((st) => st.auth?.user);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(s) !== JSON.stringify(source);

  // The saved source's current value.
  useEffect(() => {
    if (isNew || !info) return;
    let live = true;
    api('GET', `/api/data/sources/${encodeURIComponent(info.id)}/value`)
      .then((value) => live && setPreview({ value }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isNew, info?.id, version, info]);

  const patch = (p: Partial<DataSource>) => setS({ ...s, ...p } as DataSource);
  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const created = await api<DataSourceInfo>('POST', '/api/data/sources', s);
        await load();
        onSaved(created.id);
      } else {
        await api('PUT', `/api/data/sources/${encodeURIComponent(s.id)}`, s);
        await load();
        onSaved(s.id);
      }
      toast(t('“{name}” saved', { name: s.name }), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await api<{ value: unknown; error?: string }>('POST', '/api/data/test', s);
      setPreview({ value: r.value, error: r.error });
    } catch (e) {
      setPreview({ value: null, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const push = async (file: File) => {
    try {
      const res = await fetch(`/api/data/sources/${encodeURIComponent(s.id)}/value`, { method: 'PUT', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error(await res.text());
      toast(t('{file} sent to “{name}”', { file: file.name, name: s.name }), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const K = KINDS.find((k) => k.type === s.type)!;
  const url = 'url' in s ? s.url : '';
  const origin = location.origin;
  const curl = `curl -X PUT -H "Authorization: Bearer ${pushKey || 'pcg_…'}" \\\n  --data-binary @values.${s.type === 'push' ? (s.format ?? 'json') : 'json'} \\\n  ${origin}/api/data/sources/${s.id}/value`;
  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast(t('Copied'), 'info'))
      .catch(() => toast(text));
  // A key made for this source, shown in the command.
  const newKey = async () => {
    try {
      const r = await api<{ secret: string }>('POST', '/api/keys', { name: t('Push · {name}', { name: s.name }) });
      setPushKey(r.secret);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="source-editor">
      <div className="se-form">
        <RulesTabs tab={tab} onTab={setTab} count={rules.length} />
        {tab === 'rules' ? (
          <SourceRules rules={rules} value={preview?.value} editable={editable} onChange={(r) => setS({ ...s, rules: r.length ? r : undefined } as RuledSource)} />
        ) : (
          <>
            <div className="se-head">
              <K.icon size={18} />
              <input className="se-name" placeholder={t('Name (e.g. Live score)')} value={s.name} disabled={!editable} onChange={(e) => patch({ name: e.target.value })} />
              {!isNew && info && (
                <span className={`se-status ${info.error ? 'err' : ''}`} title={errorProps(info.error).title}>
                  {info.error ? (
                    <>
                      <CircleAlert size={13} /> {errorProps(info.error).text}
                    </>
                  ) : (
                    <>{t('Updated {ago}', { ago: ago(info.updatedAt) })}</>
                  )}
                </span>
              )}
            </div>
            {isNew && (
              <div className="kind-picker">
                {KINDS.map((k) => (
                  <button key={k.type} className={k.type === s.type ? 'on' : ''} onClick={() => setS({ ...blank(k.type), name: s.name })}>
                    <k.icon size={15} />
                    <strong>{t(k.label)}</strong>
                    <em>{t(k.hint)}</em>
                  </button>
                ))}
              </div>
            )}
            {s.type !== 'push' ? (
              <>
                <label>
                  {t('Address')}
                  <input placeholder={s.type === 'csv' ? 'https://docs.google.com/spreadsheets/d/…' : 'https://…'} value={url} disabled={!editable} onChange={(e) => patch({ url: e.target.value } as Partial<DataSource>)} />
                </label>
                {s.type === 'csv' && (
                  <label className="check">
                    <input type="checkbox" checked={s.header !== false} disabled={!editable} onChange={(e) => patch({ header: e.target.checked } as Partial<DataSource>)} />
                    {t('The first line names the columns')}
                  </label>
                )}
                {(s.type === 'json' || s.type === 'xml') && (
                  <label>
                    <span>
                      {t('Headers')}
                      <InfoTip text={t('One per line: “Name: value” (an API key…)')} />
                    </span>
                    <textarea
                      rows={2}
                      disabled={!editable}
                      value={Object.entries(s.headers ?? {})
                        .map(([k, v]) => `${k}: ${v}`)
                        .join('\n')}
                      onChange={(e) =>
                        patch({
                          headers: Object.fromEntries(
                            e.target.value
                              .split('\n')
                              .map((l) => l.split(/:(.*)/s).map((x) => x.trim()))
                              .filter(([k]) => k),
                          ),
                        } as Partial<DataSource>)
                      }
                    />
                  </label>
                )}
                <div className="row">
                  <label>
                    {t('Check every')}
                    <span className="with-suffix">
                      <input type="number" min={2} value={s.interval} disabled={!editable} onChange={(e) => patch({ interval: Math.max(2, +e.target.value) })} />
                      <em>s</em>
                    </span>
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={s.enabled} disabled={!editable} onChange={(e) => patch({ enabled: e.target.checked })} />
                    {t('Enabled')}
                  </label>
                </div>
              </>
            ) : (
              <>
                <label>
                  {t('Format sent')}
                  <select value={s.format ?? 'json'} disabled={!editable} onChange={(e) => patch({ format: e.target.value as 'json' } as Partial<DataSource>)}>
                    <option value="json">JSON</option>
                    <option value="csv">CSV</option>
                    <option value="xml">XML</option>
                  </select>
                </label>
                {!isNew && (
                  <div className="push-help">
                    <pre>{curl}</pre>
                    <div className="row">
                      {me && me.role !== 'viewer' && !pushKey && (
                        <button className="btn small" onClick={newKey}>
                          <KeyRound size={13} /> {t('Create a key')}
                        </button>
                      )}
                      <button className="btn small" onClick={() => copy(curl)}>
                        <Copy size={13} /> {t('Copy')}
                      </button>
                      <button className="btn small" onClick={() => fileRef.current?.click()}>
                        <Upload size={13} /> {t('Send a file now')}
                      </button>
                    </div>
                    <input ref={fileRef} type="file" hidden accept=".json,.csv,.xml,.txt" onChange={(e) => e.target.files?.[0] && push(e.target.files[0])} />
                  </div>
                )}
              </>
            )}
          </>
        )}
        <div className="se-actions">
          {editable && !isNew && (
            <button
              className="btn small danger"
              onClick={async () => {
                if (!(await confirmDialog({ title: t('Delete the data source “{name}”?', { name: s.name }), message: t('Fields bound to it keep their last value.'), confirm: t('Delete'), danger: true }))) return;
                await api('DELETE', `/api/data/sources/${encodeURIComponent(s.id)}`);
                await load();
                onDeleted?.();
              }}
            >
              <Trash2 size={13} /> {t('Delete')}
            </button>
          )}
          <div className="spacer" />
          {isNew && (
            <button className="btn small" onClick={onCancel}>
              {t('Cancel')}
            </button>
          )}
          {s.type !== 'push' && (
            <button className="btn small" disabled={busy || !url} onClick={test}>
              <FileUp size={13} /> {t('Test')}
            </button>
          )}
          {!isNew && s.type !== 'push' && !dirty && (
            <button className="btn small" onClick={() => api('POST', `/api/data/sources/${encodeURIComponent(s.id)}/refresh`)}>
              <RefreshCw size={13} /> {t('Refresh now')}
            </button>
          )}
          {editable && (isNew || dirty) && (
            <button className="btn small primary" disabled={busy || !s.name.trim()} onClick={save}>
              <Save size={13} /> {isNew ? t('Create') : t('Save')}
            </button>
          )}
        </div>
      </div>
      <div className="se-preview">
        <div className="se-preview-head">
          <strong>{t('Value')}</strong>
          <div className="spacer" />
          <label className="check small">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
            {t('Raw data')}
          </label>
        </div>
        {preview?.error && (
          <p className="error-text" title={errorProps(preview.error).title}>
            <CircleAlert size={13} /> {errorProps(preview.error).text}
          </p>
        )}
        <SumIssues issues={issues} />
        {preview && preview.value !== undefined && preview.value !== null ? raw ? <JsonTree value={preview.value} /> : <DataTable value={preview.value} issues={issues} /> : !preview?.error && <p className="muted small">{isNew ? t('Press Test to fetch it.') : t('No value yet.')}</p>}
      </div>
    </div>
  );
}

/** The fields of a source: its address, the CSV header line, request headers; a push source's format and how to send to it. */
function SourceFields({ s, isNew, editable, patch }: { s: DataSource; isNew?: boolean; editable: boolean; patch: (p: Partial<DataSource>) => void }) {
  const toast = useApp((st) => st.toast);
  const me = useApp((st) => st.auth?.user);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pushKey, setPushKey] = useState('');
  if (s.type !== 'push') {
    return (
      <>
        <label>
          {t('Address')}
          <input placeholder={s.type === 'csv' ? 'https://docs.google.com/spreadsheets/d/…' : 'https://…'} value={s.url} disabled={!editable} onChange={(e) => patch({ url: e.target.value } as Partial<DataSource>)} />
        </label>
        {s.type === 'csv' && (
          <label className="check">
            <input type="checkbox" checked={s.header !== false} disabled={!editable} onChange={(e) => patch({ header: e.target.checked } as Partial<DataSource>)} />
            {t('The first line names the columns')}
          </label>
        )}
        {(s.type === 'json' || s.type === 'xml') && (
          <label>
            <span>
              {t('Headers')}
              <InfoTip text={t('One per line: “Name: value” (an API key…)')} />
            </span>
            <textarea
              rows={2}
              disabled={!editable}
              value={Object.entries(s.headers ?? {})
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')}
              onChange={(e) =>
                patch({
                  headers: Object.fromEntries(
                    e.target.value
                      .split('\n')
                      .map((l) => l.split(/:(.*)/s).map((x) => x.trim()))
                      .filter(([k]) => k),
                  ),
                } as Partial<DataSource>)
              }
            />
          </label>
        )}
      </>
    );
  }
  const curl = `curl -X PUT -H "Authorization: Bearer ${pushKey || 'pcg_…'}" \\\n  --data-binary @values.${s.format ?? 'json'} \\\n  ${location.origin}/api/data/sources/${s.id}/value`;
  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast(t('Copied'), 'info'))
      .catch(() => toast(text));
  const newKey = async () => {
    try {
      const r = await api<{ secret: string }>('POST', '/api/keys', { name: t('Push · {name}', { name: s.name }) });
      setPushKey(r.secret);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const send = async (file: File) => {
    try {
      const res = await fetch(`/api/data/sources/${encodeURIComponent(s.id)}/value`, { method: 'PUT', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error(await res.text());
      toast(t('{file} sent to “{name}”', { file: file.name, name: s.name }), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      <label>
        {t('Format sent')}
        <select value={s.format ?? 'json'} disabled={!editable} onChange={(e) => patch({ format: e.target.value as 'json' } as Partial<DataSource>)}>
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
          <option value="xml">XML</option>
        </select>
      </label>
      {!isNew && (
        <div className="push-help">
          <pre>{curl}</pre>
          <div className="row">
            {me && me.role !== 'viewer' && !pushKey && (
              <button className="btn small" onClick={newKey}>
                <KeyRound size={13} /> {t('Create a key')}
              </button>
            )}
            <button className="btn small" onClick={() => copy(curl)}>
              <Copy size={13} /> {t('Copy')}
            </button>
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              <Upload size={13} /> {t('Send a file now')}
            </button>
          </div>
          <input ref={fileRef} type="file" hidden accept=".json,.csv,.xml,.txt" onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
        </div>
      )}
    </>
  );
}

/** A test's outcome: what came back, how long it took, when. */
type TestResult = { value: unknown; error?: string | null; ms: number; at: number };

/**
 * A source in the main menu: its settings and a test on demand, shown as a
 * table or as it came. Nothing is fetched here but by Test.
 */
function SetupEditor({ source, isNew, editable, onSaved, onCancel, onDeleted }: { source: DataSource; isNew?: boolean; editable: boolean; onSaved: (id: string) => void; onCancel?: () => void; onDeleted?: () => void }) {
  const toast = useApp((st) => st.toast);
  const load = useData((st) => st.load);
  const [s, setS] = useState<DataSource>(source);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [view, setView] = useState<'table' | 'raw'>('table');
  const dirty = JSON.stringify(s) !== JSON.stringify(source);
  const patch = (p: Partial<DataSource>) => setS({ ...s, ...p } as DataSource);
  const K = KINDS.find((k) => k.type === s.type)!;
  const url = 'url' in s ? s.url : '';

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const created = await api<DataSourceInfo>('POST', '/api/data/sources', s);
        await load();
        onSaved(created.id);
      } else {
        await api('PUT', `/api/data/sources/${encodeURIComponent(s.id)}`, s);
        await load();
        onSaved(s.id);
      }
      toast(t('“{name}” saved', { name: s.name }), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  // A pulled source is read once with these settings; a push source shows what it last received.
  const test = async () => {
    setBusy(true);
    const start = performance.now();
    const done = (value: unknown, error?: string | null) => setResult({ value, error, ms: performance.now() - start, at: Date.now() });
    try {
      if (s.type === 'push') {
        const value = await api('GET', `/api/data/sources/${encodeURIComponent(s.id)}/value`);
        done(value, value === null || value === undefined ? t('Nothing received yet') : null);
      } else {
        const r = await api<{ value: unknown; error?: string }>('POST', '/api/data/test', s);
        done(r.value, r.error);
      }
    } catch (e) {
      done(null, (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Delete the data source “{name}”?', { name: s.name }), message: t('Fields bound to it keep their last value.'), confirm: t('Delete'), danger: true }))) return;
    await api('DELETE', `/api/data/sources/${encodeURIComponent(s.id)}`);
    await load();
    onDeleted?.();
  };
  const ok = result && !result.error && result.value !== null && result.value !== undefined;
  const list = ok ? mainList(result.value) : null;
  return (
    <div className="source-editor dp-setup">
      <div className="se-form">
        <div className="se-head">
          <span className="dp-kind-ic">
            <K.icon size={17} />
          </span>
          <input className="se-name" placeholder={t('Name (e.g. Live score)')} value={s.name} disabled={!editable} onChange={(e) => patch({ name: e.target.value })} />
          {!isNew && <span className="dp-kind">{t(K.label)}</span>}
        </div>
        {isNew && (
          <div className="kind-picker">
            {KINDS.map((k) => (
              <button key={k.type} className={k.type === s.type ? 'on' : ''} onClick={() => setS({ ...blank(k.type), name: s.name })}>
                <k.icon size={15} />
                <strong>{t(k.label)}</strong>
                <em>{t(k.hint)}</em>
              </button>
            ))}
          </div>
        )}
        <SourceFields s={s} isNew={isNew} editable={editable} patch={patch} />
        <div className="se-actions">
          {editable && !isNew && (
            <button className="btn small danger" onClick={remove}>
              <Trash2 size={13} /> {t('Delete')}
            </button>
          )}
          <div className="spacer" />
          {isNew && (
            <button className="btn small" onClick={onCancel}>
              {t('Cancel')}
            </button>
          )}
          <button className="btn small" disabled={busy || (s.type === 'push' ? !!isNew : !url)} onClick={test}>
            <FileUp size={13} /> {t('Test')}
          </button>
          {editable && (isNew || dirty) && (
            <button className="btn small primary" disabled={busy || !s.name.trim()} onClick={save}>
              <Save size={13} /> {isNew ? t('Create') : t('Save')}
            </button>
          )}
        </div>
      </div>
      <div className="se-preview">
        <div className="se-preview-head">
          <strong className="dp-test-title">{tc('heading', 'Test')}</strong>
          {result && <span className={`dp-pill ${ok ? 'ok' : 'err'}`}>{ok ? t('OK') : t('Error')}</span>}
          {result && (
            <span className="dp-meta">
              {[list && list.path, list && tn(list.list.length, '{n} row', '{n} rows'), `${(result.ms / 1000).toFixed(1)} s`, new Date(result.at).toLocaleTimeString(locale(), { hour12: false })].filter(Boolean).join(' · ')}
            </span>
          )}
          <div className="spacer" />
          {ok && (
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'table', label: t('Table') },
                { value: 'raw', label: t('Raw') },
              ]}
            />
          )}
        </div>
        {busy ? (
          <p className="muted small">{t('Testing…')}</p>
        ) : !result ? (
          <div className="dp-test-empty">
            <FileUp size={20} />
            <span>{t('Not tested yet')}</span>
          </div>
        ) : result.error ? (
          <p className="error-text" title={errorProps(result.error).title}>
            <CircleAlert size={13} /> {errorProps(result.error).text}
          </p>
        ) : view === 'raw' ? (
          <JsonTree value={result.value} />
        ) : (
          <DataTable value={result.value} issues={[]} />
        )}
      </div>
    </div>
  );
}

const isRow = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The longest list in a value (its rows), up to three levels down, with where it is. */
function mainList(v: unknown, path = '', depth = 0): { path: string; list: unknown[] } | null {
  if (Array.isArray(v)) return { path, list: v };
  if (!isRow(v) || depth > 2) return null;
  let best: { path: string; list: unknown[] } | null = null;
  for (const [k, x] of Object.entries(v)) {
    const found = mainList(x, path ? `${path}.${k}` : k, depth + 1);
    if (found && (!best || found.list.length > best.list.length)) best = found;
  }
  return best;
}

const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** An object's values, nested ones under dotted names (`away.score`); lists stay whole. */
function flat(v: Record<string, unknown>, prefix = '', out: [string, unknown][] = [], depth = 0): [string, unknown][] {
  for (const [k, x] of Object.entries(v)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (isRow(x) && depth < 4) flat(x, name, out, depth + 1);
    else out.push([name, x]);
  }
  return out;
}

/** A source's value as a table, to read: its main list (one row per item), else its fields. */
function DataTable({ value, issues }: { value: unknown; issues: DataIssue[] }) {
  const found = mainList(value);
  const MAX = 500;
  if (!found || !found.list.length) {
    const entries = isRow(value) ? flat(value) : [['', value] as [string, unknown]];
    return (
      <div className="data-table-wrap">
        <table className="data-table">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td className={`${typeof v === 'number' ? 'num' : ''} ${isBad(issues, null, null, k) ? 'dr-bad' : ''}`}>{cell(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const rows = found.list.slice(0, MAX).map((r) => (isRow(r) ? Object.fromEntries(flat(r)) : r));
  const objects = rows.some(isRow);
  const cols = objects ? [...new Set(rows.flatMap((r) => (isRow(r) ? Object.keys(r) : [])))] : [''];
  return (
    <>
      <span className="data-table-meta">
        {found.path ? `${found.path} · ` : ''}
        {found.list.length > MAX ? t('{n} of {total} rows', { n: MAX, total: found.list.length }) : t('{n} rows', { n: found.list.length })}
      </span>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="n">{i + 1}</td>
                {cols.map((c) => {
                  const v = objects ? (isRow(r) ? r[c] : undefined) : r;
                  return (
                    <td key={c} className={`${typeof v === 'number' ? 'num' : ''} ${isBad(issues, found.path, i, c) ? 'dr-bad' : ''}`} title={cell(v)}>
                      {cell(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
