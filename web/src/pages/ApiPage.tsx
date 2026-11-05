import { BookOpen, Download, FileJson, Hash, LayoutGrid } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t, tc, tn } from '../i18n';
import { api } from '../store';
import { navigate, systemPath } from '../router';
import { ApiButtons } from './ApiButtons';
import { ApiOverview, ApiTag, useApiSpec } from './ApiDocs';
import { ApiKeys, type ApiKey } from './ApiKeys';
import { NavItem, PageHead, SidePage, SubTabs } from './SidePage';

type View = { kind: 'keys' } | { kind: 'buttons' } | { kind: 'overview' } | { kind: 'tag'; name: string };

/** Automation: the API keys (`keys`), or the documentation of the API and Bitfocus Buttons. */
export function ApiPage({ part }: { part: 'keys' | 'docs' }) {
  const { spec, byTag } = useApiSpec();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [view, setView] = useState<View>(part === 'keys' ? { kind: 'keys' } : { kind: 'overview' });
  const loadKeys = () => api<ApiKey[]>('GET', '/api/keys').then(setKeys).catch(() => {});
  useEffect(() => void loadKeys(), []);

  // Documentation or Bitfocus Buttons, as tabs under the title; the open one's actions at their right.
  const head = (actions: React.ReactNode) => (
    <>
      <PageHead title={t('API and Bitfocus')} />
      <SubTabs
        value={view.kind === 'buttons' ? 'buttons' : 'docs'}
        onChange={(v) => setView(v === 'buttons' ? { kind: 'buttons' } : { kind: 'overview' })}
        items={[
          { id: 'docs', icon: <BookOpen size={14} />, label: t('Documentation') },
          { id: 'buttons', icon: <LayoutGrid size={14} />, label: 'Bitfocus Buttons' },
        ]}
      >
        {actions}
      </SubTabs>
    </>
  );
  const tools = (
    <span className="api-tools">
      <a className="btn" href="/premiere/strata-premiere.zip" title={t('The Premiere Pro panel, set to this server (it updates itself from it)')}>
        <Download size={14} /> {t('Premiere Pro panel')}
      </a>
      <a className="btn" href="/api/openapi.json" target="_blank" rel="noreferrer" title={t('Import it into Postman, Insomnia or a code generator')}>
        <FileJson size={14} /> OpenAPI 3.1
      </a>
    </span>
  );
  // The documentation's own contents, beside it.
  const toc = spec && (
    <nav className="api-toc">
      <NavItem on={view.kind === 'overview'} icon={<BookOpen size={15} />} label={t('Overview')} onClick={() => setView({ kind: 'overview' })} />
      {spec.tags.map((tag) => (
        <NavItem key={tag.name} on={view.kind === 'tag' && view.name === tag.name} icon={<Hash size={15} />} label={tc('api', tag.name)} count={byTag.get(tag.name)?.length ?? 0} onClick={() => setView({ kind: 'tag', name: tag.name })} />
      ))}
    </nav>
  );

  let body: React.ReactNode;
  if (view.kind === 'keys') {
    body = (
      <>
        <PageHead
          title={t('API keys')}
          sub={tn(keys.length, '{n} key', '{n} keys')}
        />
        <ApiKeys keys={keys} reload={loadKeys} />
      </>
    );
  } else if (view.kind === 'buttons') {
    body = <ApiButtons keys={keys} onCreateKey={() => navigate(systemPath('keys'))} head={head} />;
  } else if (!spec) body = <div className="loading">{t('Loading the API description…')}</div>;
  else {
    const ops = view.kind === 'tag' ? (byTag.get(view.name) ?? []) : [];
    body = (
      <>
        {head(tools)}
        <div className="api-doc">
          {toc}
          <div className="api-doc-body">
            {view.kind === 'overview' ? (
              <>
                <h2 className="api-doc-title">
                  {spec.info.title} <span className="badge">{spec.info.version}</span>
                </h2>
                <ApiOverview spec={spec} />
              </>
            ) : (
              <>
                <h2 className="api-doc-title">
                  {tc('api', view.name)} <span className="muted small">{tn(ops.length, '{n} operation', '{n} operations')}</span>
                </h2>
                <ApiTag spec={spec} ops={ops} />
              </>
            )}
          </div>
        </div>
      </>
    );
  }
  return <SidePage nav={null}>{body}</SidePage>;
}
