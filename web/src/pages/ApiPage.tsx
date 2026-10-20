import { BookOpen, Download, FileJson, Hash, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t, tn } from '../i18n';
import { api } from '../store';
import { ApiOverview, ApiTag, useApiSpec } from './ApiDocs';
import { ApiKeys, type ApiKey } from './ApiKeys';
import { NavItem, NavSection, PageHead, SidePage } from './SidePage';

type View = { kind: 'keys' } | { kind: 'overview' } | { kind: 'tag'; name: string };

/** Automation: API keys and the documentation of the API. */
export function ApiPage() {
  const { spec, byTag } = useApiSpec();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [view, setView] = useState<View>({ kind: 'keys' });
  const loadKeys = () => api<ApiKey[]>('GET', '/api/keys').then(setKeys).catch(() => {});
  useEffect(() => void loadKeys(), []);

  const nav = (
    <>
      <NavSection>{t('Access')}</NavSection>
      <NavItem on={view.kind === 'keys'} icon={<KeyRound size={15} />} label={t('API keys')} count={keys.length} onClick={() => setView({ kind: 'keys' })} />
      <NavSection>{t('Documentation')}</NavSection>
      <NavItem on={view.kind === 'overview'} icon={<BookOpen size={15} />} label={t('Overview')} onClick={() => setView({ kind: 'overview' })} />
      {spec?.tags.map((tag) => (
        <NavItem key={tag.name} on={view.kind === 'tag' && view.name === tag.name} icon={<Hash size={15} />} label={tag.name} count={byTag.get(tag.name)?.length ?? 0} onClick={() => setView({ kind: 'tag', name: tag.name })} />
      ))}
      <NavSection>{t('Tools')}</NavSection>
      <a className="lib-nav-item" href="/premiere/strata-premiere.zip" title={t('The Premiere Pro panel, set to this server (it updates itself from it)')}>
        <Download size={15} />
        <span className="grow">{t('Premiere Pro panel')}</span>
      </a>
      <a className="lib-nav-item" href="/api/openapi.json" target="_blank" rel="noreferrer" title={t('Import it into Postman, Insomnia or a code generator')}>
        <FileJson size={15} />
        <span className="grow">OpenAPI 3.1</span>
      </a>
    </>
  );

  let body: React.ReactNode;
  if (view.kind === 'keys') {
    body = (
      <>
        <PageHead title={t('API keys')} sub={t('Permanent keys for Companion, newsroom systems and scripts.')} />
        <ApiKeys keys={keys} reload={loadKeys} />
      </>
    );
  } else if (!spec) body = <div className="loading">{t('Loading the API description…')}</div>;
  else if (view.kind === 'overview') {
    body = (
      <>
        <PageHead
          title={
            <>
              {spec.info.title} <span className="badge">{spec.info.version}</span>
            </>
          }
          sub={
            <>
              OpenAPI 3.1: <a href="/api/openapi.json">/api/openapi.json</a> — {t('import it into Postman, Insomnia or a code generator.')}
            </>
          }
        />
        <ApiOverview spec={spec} />
      </>
    );
  } else {
    const ops = byTag.get(view.name) ?? [];
    body = (
      <>
        <PageHead title={view.name} sub={tn(ops.length, '{n} operation · click it to see its parameters and answers', '{n} operations · click one to see its parameters and answers')} />
        <ApiTag spec={spec} ops={ops} />
      </>
    );
  }
  return <SidePage nav={nav}>{body}</SidePage>;
}
