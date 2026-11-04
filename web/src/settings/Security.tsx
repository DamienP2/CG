// Settings › Security: HTTPS (a self-signed certificate, or the company's) and sign-in through the
// company's directory (OpenID Connect), its groups giving the roles.
import { Copy, KeyRound, Lock, Plus, RefreshCw, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Role } from '../engine/types';
import type { CertInfo, HttpsConfig, ServerConfig, SsoConfig, TlsStatus } from '../outputs/types';
import { api, useApp } from '../store';
import { t } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { NumberField, Segmented } from '../ui/fields';
import { Card, Field } from './ui';

const HTTPS_DEFAULT: HttpsConfig = { mode: 'off', port: 8443, http: 'redirect' };
const SSO_DEFAULT: SsoConfig = { enabled: false, provider: 'entra', issuer: '', clientId: '', clientSecret: '', groupsClaim: 'groups', groups: [], defaultRole: null, localAccounts: 'adminOnly' };

const PROVIDERS: { value: string; label: string; issuer: string }[] = [
  { value: 'entra', label: 'Microsoft Entra', issuer: 'https://login.microsoftonline.com/<tenant>/v2.0' },
  { value: 'okta', label: 'Okta', issuer: 'https://<domain>.okta.com' },
  { value: 'keycloak', label: 'Keycloak', issuer: 'https://<server>/realms/<realm>' },
  { value: 'google', label: 'Google', issuer: 'https://accounts.google.com' },
  { value: 'other', label: 'Other', issuer: 'https://…' },
];

/** Labels translated where shown. */
const ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Administrator' },
  { value: 'designer', label: 'Designer' },
  { value: 'operator', label: 'Operator' },
  { value: 'viewer', label: 'Viewer' },
];

const day = (ms: number) => new Date(ms).toLocaleDateString();

/** A certificate: its names, until when, its fingerprint. */
function Cert({ c }: { c: CertInfo }) {
  return (
    <dl className="oc-hw-sum sec-cert">
      <dt>{t('Name')}</dt>
      <dd>{c.subject}</dd>
      {c.names.length > 0 && (
        <>
          <dt>{t('Addresses')}</dt>
          <dd>{c.names.join(' · ')}</dd>
        </>
      )}
      <dt>{t('Expires')}</dt>
      <dd className={c.notAfter < Date.now() + 30 * 86_400_000 ? 'warn' : ''}>{day(c.notAfter)}</dd>
      <dt>SHA-256</dt>
      <dd>
        <code className="sec-fp">{c.fingerprint}</code>
      </dd>
    </dl>
  );
}

/** A PEM file picked, read as text. */
function PemPick({ label, value, onPick }: { label: string; value: string; onPick: (name: string, text: string) => void }) {
  return (
    <label className="btn small sec-pick">
      <Upload size={13} /> {value || label}
      <input
        type="file"
        accept=".pem,.crt,.cer,.key"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void f.text().then((text) => onPick(f.name, text));
          e.target.value = '';
        }}
      />
    </label>
  );
}

export function SecurityPage({ cfg, edit }: { cfg: ServerConfig; edit: (fn: (c: ServerConfig) => void) => void }) {
  const toast = useApp((s) => s.toast);
  const https = cfg.security?.https ?? HTTPS_DEFAULT;
  const sso = cfg.security?.sso ?? SSO_DEFAULT;
  const setHttps = (fn: (h: HttpsConfig) => void) =>
    edit((c) => {
      c.security ??= { https: { ...HTTPS_DEFAULT }, sso: { ...SSO_DEFAULT } };
      c.security.https ??= { ...HTTPS_DEFAULT };
      fn(c.security.https);
    });
  const setSso = (fn: (s: SsoConfig) => void) =>
    edit((c) => {
      c.security ??= { https: { ...HTTPS_DEFAULT }, sso: { ...SSO_DEFAULT } };
      c.security.sso ??= { ...SSO_DEFAULT };
      fn(c.security.sso);
    });

  const [tls, setTls] = useState<TlsStatus | null>(null);
  const loadTls = () =>
    api<TlsStatus>('GET', '/api/security/tls')
      .then(setTls)
      .catch(() => {});
  useEffect(() => {
    void loadTls();
    const h = setInterval(() => document.hidden || void loadTls(), 4000);
    return () => clearInterval(h);
  }, []);

  const [pem, setPem] = useState<{ cert?: [string, string]; key?: [string, string] }>({});
  const upload = async () => {
    if (!pem.cert || !pem.key) return;
    try {
      await api('POST', '/api/security/tls/certificate', { cert: pem.cert[1], key: pem.key[1] });
      setPem({});
      await loadTls();
      toast(t('Certificate saved.'), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const renew = async () => {
    try {
      await api('POST', '/api/security/tls/self-signed');
      await loadTls();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const callback = `${location.origin}/api/auth/sso/callback`;
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const runTest = async () => {
    setTest(null);
    try {
      const r = await api<{ issuer: string; keys: number }>('POST', '/api/security/sso/test', { issuer: sso.issuer });
      setTest({ ok: true, text: t('{issuer} answers · {n} keys', { issuer: r.issuer, n: r.keys }) });
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message });
    }
  };
  const provider = PROVIDERS.find((p) => p.value === sso.provider) ?? PROVIDERS[4];
  const running = tls?.running;
  const httpsUrl = `https://${location.hostname}${https.port === 443 ? '' : `:${https.port}`}`;

  return (
    <>
      <Card
        icon={<Lock size={16} />}
        title="HTTPS"
        actions={
          https.mode !== 'off' &&
          running && (
            <span className={`sec-state ${running.on ? 'ok' : running.error ? 'warn' : ''}`}>
              <span className={`oc-dot ${running.on ? 'ok' : running.error ? 'warn' : 'idle'}`} />
              {running.on ? (
                <a href={httpsUrl} target="_blank" rel="noreferrer">
                  {t('On · port {port}', { port: running.port })}
                </a>
              ) : (
                running.error || t('Not applied yet')
              )}
            </span>
          )
        }
      >
        <div className="set-grid">
          <Field label={t('Certificate')}>
            <Segmented
              value={https.mode}
              onChange={(mode) => setHttps((h) => void (h.mode = mode))}
              options={[
                { value: 'off', label: t('Off') },
                { value: 'selfSigned', label: t('Self-signed') },
                { value: 'custom', label: t('My certificate') },
              ]}
            />
          </Field>
          {https.mode !== 'off' && (
            <>
              <Field label={t('HTTPS port')}>
                <NumberField value={https.port} min={1} max={65535} onChange={(v) => setHttps((h) => void (h.port = Math.max(1, Math.min(65535, Math.round(v) || 0))))} />
              </Field>
              <Field label="HTTP">
                <Segmented
                  value={https.http}
                  onChange={(http) => setHttps((h) => void (h.http = http))}
                  options={[
                    { value: 'redirect', label: t('To HTTPS, but this PC and HTML5 outputs') },
                    { value: 'httpsOnly', label: t('Everything in HTTPS') },
                    { value: 'open', label: t('HTTP stays open') },
                  ]}
                />
              </Field>
            </>
          )}
        </div>
        <div className="sec-certs">
          {https.mode === 'selfSigned' && (
            <Field label={t('Self-signed certificate')}>
              <div className="sec-row">
                {tls?.selfSigned ? <Cert c={tls.selfSigned} /> : <span className="muted">{t('Made when applied')}</span>}
                <button type="button" className="btn small" onClick={() => void renew()}>
                  <RefreshCw size={13} /> {t('Make a new one')}
                </button>
              </div>
            </Field>
          )}
          {https.mode === 'custom' && (
            <Field label={t('My certificate')}>
              <div className="sec-row">
                {tls?.custom && <Cert c={tls.custom} />}
                <div className="sec-picks">
                  <PemPick label={t('Certificate')} value={pem.cert?.[0] ?? ''} onPick={(n, x) => setPem((p) => ({ ...p, cert: [n, x] }))} />
                  <PemPick label={t('Private key')} value={pem.key?.[0] ?? ''} onPick={(n, x) => setPem((p) => ({ ...p, key: [n, x] }))} />
                  <button type="button" className="btn small primary" disabled={!pem.cert || !pem.key} onClick={() => void upload()}>
                    <KeyRound size={13} /> {t('Install')}
                  </button>
                </div>
              </div>
            </Field>
          )}
        </div>
      </Card>

      <Card
        icon={<KeyRound size={16} />}
        title={t('Sign-in through the company directory (SSO)')}
        actions={
          <label className="check">
            <input type="checkbox" checked={sso.enabled} onChange={(e) => setSso((s) => void (s.enabled = e.target.checked))} />
            {sso.enabled ? t('On') : t('Off')}
          </label>
        }
      >
        {sso.enabled && (
          <div className="set-grid">
            <Field label={t('Provider')}>
              <Segmented value={sso.provider} onChange={(p) => setSso((s) => void (s.provider = p))} options={PROVIDERS.map((p) => ({ value: p.value, label: p.value === 'other' ? t('Other') : p.label }))} />
            </Field>
            <Field label={t('Issuer')}>
              <input value={sso.issuer} placeholder={provider.issuer} spellCheck={false} onChange={(e) => setSso((s) => void (s.issuer = e.target.value.trim()))} />
            </Field>
            <Field label={t('Client ID')}>
              <input value={sso.clientId} spellCheck={false} onChange={(e) => setSso((s) => void (s.clientId = e.target.value.trim()))} />
            </Field>
            <Field label={t('Secret')}>
              <input type="password" value={sso.clientSecret} autoComplete="new-password" onChange={(e) => setSso((s) => void (s.clientSecret = e.target.value))} />
            </Field>
            <Field label={t('Return URL')}>
              <div className="sec-row">
                <code className="sec-url">{callback}</code>
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(callback)
                      .then(() => toast(t('Copied'), 'info'))
                      .catch(() => {})
                  }
                >
                  <Copy size={13} /> {t('Copy')}
                </button>
              </div>
            </Field>
            <Field label={t('Groups claim')}>
              <input value={sso.groupsClaim} placeholder="groups" spellCheck={false} onChange={(e) => setSso((s) => void (s.groupsClaim = e.target.value.trim()))} />
            </Field>
            <Field label={t('Roles by group')}>
              <div className="sec-groups">
                {sso.groups.map((g, i) => (
                  <div key={i} className="sec-group">
                    <input value={g.group} placeholder={t('Group')} spellCheck={false} onChange={(e) => setSso((s) => void (s.groups[i].group = e.target.value))} />
                    <Dropdown value={g.role} options={ROLES.map((r) => ({ value: r.value, label: t(r.label) }))} onChange={(role) => setSso((s) => void (s.groups[i].role = role))} />
                    <button type="button" className="icon-btn ghost" title={t('Remove')} onClick={() => setSso((s) => void s.groups.splice(i, 1))}>
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn small" onClick={() => setSso((s) => void s.groups.push({ group: '', role: 'operator' }))}>
                  <Plus size={13} /> {t('group')}
                </button>
              </div>
            </Field>
            <Field label={t('In no group above')}>
              <Segmented
                value={sso.defaultRole ?? 'none'}
                onChange={(r) => setSso((s) => void (s.defaultRole = r === 'none' ? null : (r as Role)))}
                options={[
                  { value: 'none', label: t('Refused') },
                  { value: 'viewer', label: t('Viewer') },
                  { value: 'operator', label: t('Operator') },
                ]}
              />
            </Field>
            <Field label={t('Local accounts')}>
              <Segmented
                value={sso.localAccounts}
                onChange={(v) => setSso((s) => void (s.localAccounts = v))}
                options={[
                  { value: 'none', label: t('Off') },
                  { value: 'adminOnly', label: t('Admins only (fallback)') },
                  { value: 'all', label: t('All') },
                ]}
              />
            </Field>
            <Field label="">
              <div className="sec-row">
                <button type="button" className="btn small" disabled={!sso.issuer} onClick={() => void runTest()}>
                  {t('Test the connection')}
                </button>
                {test && <span className={test.ok ? 'sec-ok' : 'set-error'}>{test.text}</span>}
              </div>
            </Field>
          </div>
        )}
      </Card>
    </>
  );
}
