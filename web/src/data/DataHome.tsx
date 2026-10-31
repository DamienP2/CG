import { CircleAlert, Copy, Database, FileUp, KeyRound, MessagesSquare, Plus, Save, Settings2, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DataSource, DataSourceInfo } from '../engine/types';
import { api, can, useApp } from '../store';
import { JsonTree } from './JsonTree';
import { useData, useSources } from './dataStore';
import { AddSourceMenu, SocialEditor, useSocialSources, connectionState, type SocialPick } from './SocialSources';
import { DataTable, KINDS, blank, mainList } from './DataPage';
import { NavItem, NavSection, PageHead, SidePage } from '../pages/SidePage';
import { Card } from '../settings/ui';
import { PlatformBadge } from '../social/PlatformBadge';
import { Segmented } from '../ui/fields';
import { confirmDialog } from '../ui/dialogs';
import { locale, t, tc, tn } from '../i18n';
import { errorProps } from '../ui/serverError';
import { InfoTip } from '../ui/InfoTip';

/*
 * Main menu › Data: the connections shared by every project, set up and
 * tested here. Nothing is read here but by Test; projects use them.
 */

type Pick = { source: string } | { draft: DataSource } | { social: SocialPick } | null;

export function DataHome() {
  const sources = useSources().filter((s) => !s.project);
  const socials = useSocialSources();
  const edit = can.design(useApp((s) => s.auth?.user));
  const [pick, setPick] = useState<Pick>(null);
  useEffect(() => {
    if (!pick && sources.length) setPick({ source: sources[0].id });
  }, [sources, pick]);
  const current = pick && 'source' in pick ? sources.find((s) => s.id === pick.source) : undefined;

  const nav = (
    <>
      <NavSection
        actions={
          edit && (
            <button className="icon-btn ghost" title={t('New data source')} onClick={() => setPick({ draft: blank('json', null) })}>
              <Plus size={14} />
            </button>
          )
        }
      >
        {t('Data sources')}
      </NavSection>
      {sources.map((s) => {
        const K = KINDS.find((k) => k.type === s.type)!;
        return <NavItem key={s.id} on={current?.id === s.id} icon={<K.icon size={15} />} label={s.name} status={s.error ? 'warn' : s.updatedAt ? 'ok' : 'off'} title={errorProps(s.error).title} onClick={() => setPick({ source: s.id })} />;
      })}
      {!sources.length && (
        <div className="lib-nav-empty">
          <Database size={13} /> {t('No shared source')}
        </div>
      )}
      <NavSection actions={edit && <AddSourceMenu ghost onSocial={(platform) => setPick({ social: { platform } })} />}>{t('Social networks')}</NavSection>
      {socials.map((s) => {
        const dot = connectionState(s).dot;
        return <NavItem key={s.id} on={!!pick && 'social' in pick && 'id' in pick.social && pick.social.id === s.id} icon={<PlatformBadge platform={s.platform} size={15} />} label={s.name} status={dot === 'ok' ? 'ok' : dot === 'err' || dot === 'soc-warn' ? 'warn' : 'off'} onClick={() => setPick({ social: { id: s.id } })} />;
      })}
      {!socials.length && (
        <div className="lib-nav-empty">
          <MessagesSquare size={13} /> {t('No social network')}
        </div>
      )}
    </>
  );

  return (
    <SidePage nav={nav} className="data-home">
      {pick && 'social' in pick ? (
        <SocialEditor key={'id' in pick.social ? pick.social.id : pick.social.platform} pick={pick.social} editable={edit} setup onSaved={(id) => setPick({ social: { id } })} onClose={() => setPick(null)} />
      ) : pick && 'draft' in pick ? (
        <SetupEditor key="new" source={pick.draft} isNew editable={edit} onSaved={(id) => setPick({ source: id })} onCancel={() => setPick(null)} />
      ) : current ? (
        <SetupEditor key={current.id} source={current} editable={edit} onSaved={() => {}} onDeleted={() => setPick(null)} />
      ) : (
        <div className="data-empty">
          <Database size={28} />
        </div>
      )}
    </SidePage>
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

/** A source: its page head (delete, save), its settings and its test. */
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
  const ok = !!result && !result.error && result.value !== null && result.value !== undefined;
  const list = ok ? mainList(result!.value) : null;
  return (
    <>
      <PageHead title={s.name.trim() || t('New data source')} sub={t(K.label)}>
        {editable && !isNew && (
          <button className="btn danger" onClick={remove}>
            <Trash2 size={14} /> {t('Delete')}
          </button>
        )}
        {isNew && (
          <button className="btn" onClick={onCancel}>
            {t('Cancel')}
          </button>
        )}
        {editable && (isNew || dirty) && (
          <button className="btn primary" disabled={busy || !s.name.trim()} onClick={save}>
            <Save size={14} /> {isNew ? t('Create') : t('Save')}
          </button>
        )}
      </PageHead>
      <Card icon={<Settings2 size={16} />} title={t('Settings')}>
        <div className="dp-form">
          <label>
            {t('Name')}
            <input placeholder={t('Name (e.g. Live score)')} value={s.name} disabled={!editable} onChange={(e) => patch({ name: e.target.value })} />
          </label>
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
        </div>
      </Card>
      <Card
        icon={<FileUp size={16} />}
        title={tc('heading', 'Test')}
        actions={
          <>
            {result && <span className={`dp-pill ${ok ? 'ok' : 'err'}`}>{ok ? t('OK') : t('Error')}</span>}
            {result && (
              <span className="dp-meta">
                {[list && list.path, list && tn(list.list.length, '{n} row', '{n} rows'), `${(result.ms / 1000).toFixed(1)} s`, new Date(result.at).toLocaleTimeString(locale(), { hour12: false })].filter(Boolean).join(' · ')}
              </span>
            )}
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
            <button className="btn small" disabled={busy || (s.type === 'push' ? !!isNew : !url)} onClick={test}>
              <FileUp size={13} /> {t('Test')}
            </button>
          </>
        }
      >
        <div className="dp-test">
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
      </Card>
    </>
  );
}
