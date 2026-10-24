import { CircleAlert, Copy, FlaskConical, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, changeEvents, useApp } from '../store';
import { confirmDialog } from '../ui/dialogs';
import { Segmented } from '../ui/fields';
import { locale, t, tn } from '../i18n';
import { PLATFORMS, PLATFORM_IDS, PlatformBadge, type Platform } from '../social/PlatformBadge';

/*
 * Social network connections, shared by every project (main menu › Data):
 * the "Social networks" part of the Data page's list, the editor of a
 * connection and its live messages. What a project does with the messages
 * is its own (project › Social).
 */

export interface SocialSource {
  id: string;
  name: string;
  platform: Platform;
  enabled: boolean;
  /** Platform settings; secrets come back as "••••". */
  settings: Record<string, string>;
}

export interface SocialInfo extends SocialSource {
  connected: boolean;
  perMin: number;
  error?: string | null;
  warning?: string | null;
  lastAt?: number | null;
  offAir?: boolean;
  expiresAt?: number | null;
  hookAt?: number | null;
  account?: string | null;
  /** Projects following it. */
  projects: number;
}

export interface SocialMessage {
  id: string;
  sourceId: string;
  platform: Platform;
  author: { id: string; name: string; handle?: string; avatar?: string; verified?: boolean; city?: string };
  text: string;
  photos?: string[];
  at: number;
  amount?: string;
  url?: string;
}

/** A connection picked in the list, or a new one of a platform. */
export type SocialPick = { id: string } | { platform: Platform };

interface SocialState {
  list: SocialInfo[];
  loaded: boolean;
  load: () => Promise<void>;
}

export const useSocial = create<SocialState>((set) => ({
  list: [],
  loaded: false,
  async load() {
    const list = await api<SocialInfo[]>('GET', '/api/social/sources');
    set({ list, loaded: true });
  },
}));

/** The connections, kept fresh while shown (status and messages per minute). */
export function useSocialSources() {
  const { list, load } = useSocial();
  useEffect(() => {
    const reload = () => void load().catch(() => {});
    reload();
    const timer = setInterval(reload, 2000);
    changeEvents.addEventListener('social', reload);
    return () => {
      clearInterval(timer);
      changeEvents.removeEventListener('social', reload);
    };
  }, [load]);
  return list;
}

const DAY = 86_400_000;

/** What the list says of a connection, and the colour of its dot. */
function state(s: SocialInfo): { text: string; dot: string } {
  if (!s.enabled) return { text: t('Not enabled'), dot: 'idle' };
  if (s.error) return { text: s.error, dot: 'err' };
  if (s.expiresAt && s.expiresAt - Date.now() < 7 * DAY) {
    const days = Math.floor((s.expiresAt - Date.now()) / DAY);
    return { text: days < 0 ? t('Token expired') : tn(days, 'Token expires in {n} day', 'Token expires in {n} days'), dot: 'soc-warn' };
  }
  if (s.warning) return { text: s.warning, dot: 'soc-warn' };
  if (s.offAir) return { text: t('No live'), dot: 'idle' };
  if (!s.connected) return { text: t('Connecting…'), dot: 'idle' };
  const rate = t('{n} msg/min', { n: s.perMin });
  return { text: s.projects ? `${rate} · ${tn(s.projects, '{n} project', '{n} projects')}` : rate, dot: 'ok' };
}

/** "Social networks" in the Data page's list. */
export function SocialSection({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const list = useSocialSources();
  return (
    <>
      <div className="soc-sep">{t('Social networks')}</div>
      {list.map((s) => {
        const st = state(s);
        return (
          <button key={s.id} className={`data-item ${selected === s.id ? 'selected' : ''}`} onClick={() => onSelect(s.id)}>
            <PlatformBadge platform={s.platform} />
            <span>
              <strong>{s.name}</strong>
              <em title={st.text}>{st.text}</em>
            </span>
            <i className={`status-dot ${st.dot}`} />
          </button>
        );
      })}
    </>
  );
}

/** The + of the Data page: a data source, or a social network connection. */
export function AddSourceMenu({ onData, onSocial }: { onData: () => void; onSocial: (p: Platform) => void }) {
  // Fixed: the list it opens from scrolls (and would clip it).
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setAt(null);
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [at]);
  const pick = (f: () => void) => () => (setAt(null), f());
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="icon-btn"
        title={t('New data source')}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { left: r.left, top: r.bottom + 6 });
        }}
      >
        <Plus size={15} />
      </button>
      {at && (
        <div className="menu soc-add-menu" style={{ left: at.left, top: at.top }}>
          <button onClick={pick(onData)}>
            <Plus size={14} /> {t('Data source')}
          </button>
          <div className="menu-sep" />
          <div className="menu-label">{t('Social networks')}</div>
          {PLATFORM_IDS.map((p) => (
            <button key={p} onClick={pick(() => onSocial(p))}>
              <PlatformBadge platform={p} size={18} /> {PLATFORMS[p].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Field = { key: string; label: string; secret?: boolean; placeholder?: string; when?: [string, string] };
type Mode = { key: string; default: string; options: { value: string; label: string }[] };

/** The settings of each platform. Labels are translated when shown. */
const FORMS: Record<Platform, { mode?: Mode; fields: Field[]; hook?: boolean }> = {
  youtube: {
    mode: {
      key: 'mode',
      default: 'channelLive',
      options: [
        { value: 'channelLive', label: 'Current live of the channel' },
        { value: 'video', label: 'Given video' },
      ],
    },
    fields: [
      { key: 'channel', label: 'YouTube channel', placeholder: '@lefigarotv · UC…', when: ['mode', 'channelLive'] },
      { key: 'video', label: 'Video', placeholder: 'youtube.com/watch?v=…', when: ['mode', 'video'] },
      { key: 'apiKey', label: 'API key', secret: true },
    ],
  },
  twitch: { fields: [{ key: 'channel', label: 'Twitch channel', placeholder: 'lefigaro_live' }] },
  facebook: {
    mode: {
      key: 'mode',
      default: 'live',
      options: [
        { value: 'live', label: 'Current live of the page' },
        { value: 'post', label: 'Given post' },
      ],
    },
    fields: [
      { key: 'page', label: 'Page ID', placeholder: '108824017345866', when: ['mode', 'live'] },
      { key: 'post', label: 'Post ID', placeholder: '108824017345866_1234…', when: ['mode', 'post'] },
      { key: 'accessToken', label: 'Page access token', secret: true },
    ],
  },
  instagram: {
    mode: {
      key: 'mode',
      default: 'recent',
      options: [
        { value: 'recent', label: 'Latest posts' },
        { value: 'media', label: 'Given post' },
      ],
    },
    fields: [
      { key: 'igUser', label: 'Instagram business account ID', placeholder: '17841400000000000', when: ['mode', 'recent'] },
      { key: 'media', label: 'Post ID', placeholder: '17900000000000000', when: ['mode', 'media'] },
      { key: 'accessToken', label: 'Page access token', secret: true },
    ],
  },
  x: {
    fields: [
      { key: 'query', label: 'Search query', placeholder: '#JT20H -is:retweet' },
      { key: 'bearer', label: 'Bearer token', secret: true },
    ],
  },
  tiktok: { hook: true, fields: [{ key: 'user', label: 'TikTok account', placeholder: '@lefigaro' }] },
  whatsapp: {
    hook: true,
    fields: [
      { key: 'verifyToken', label: 'Verify token', secret: true },
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'appSecret', label: 'App secret', secret: true },
      { key: 'phoneNumberId', label: 'Phone number ID', placeholder: '106540352242922' },
    ],
  },
  sms: {
    hook: true,
    fields: [
      { key: 'keyword', label: 'Keyword', placeholder: 'JT' },
      { key: 'accountSid', label: 'Account SID', placeholder: 'AC…' },
      { key: 'authToken', label: 'Auth token', secret: true },
    ],
  },
};

/** YouTube: what is read. */
const YT_READ = [
  { value: 'chat', label: 'Chat' },
  { value: 'superChats', label: 'Super Chats' },
  { value: 'members', label: 'Members' },
  { value: 'polls', label: 'Polls' },
];

const newId = (p: Platform) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

/** The editor of a connection (middle) and its live messages (right). */
export function SocialEditor({ pick, editable, onSaved, onClose }: { pick: SocialPick; editable: boolean; onSaved: (id: string) => void; onClose: () => void }) {
  const info = useSocial((st) => ('id' in pick ? st.list.find((s) => s.id === pick.id) : undefined));
  if ('platform' in pick) return <Editor key={`new-${pick.platform}`} platform={pick.platform} editable={editable} onSaved={onSaved} onClose={onClose} />;
  return info ? <Editor key={info.id} info={info} editable={editable} onSaved={onSaved} onClose={onClose} /> : null;
}

function Editor({ info, platform, editable, onSaved, onClose }: { info?: SocialInfo; platform?: Platform; editable: boolean; onSaved: (id: string) => void; onClose: () => void }) {
  const load = useSocial((st) => st.load);
  const toast = useApp((st) => st.toast);
  const isNew = !info;
  const [created] = useState(() => newId(platform ?? 'x'));
  const initial: SocialSource = info ? { id: info.id, name: info.name, platform: info.platform, enabled: info.enabled, settings: info.settings } : { id: created, name: PLATFORMS[platform!].label, platform: platform!, enabled: true, settings: {} };
  const [s, setS] = useState<SocialSource>(initial);
  const [busy, setBusy] = useState(false);
  // The saved one changed elsewhere (another user): shown unless edited here.
  const saved = JSON.stringify(initial);
  const [base, setBase] = useState(saved);
  useEffect(() => {
    if (!isNew && saved !== base && JSON.stringify(s) === base) {
      setS(initial);
      setBase(saved);
    }
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const form = FORMS[s.platform];
  const dirty = isNew || JSON.stringify(s) !== base;
  const set = (key: string, value: string) => setS({ ...s, settings: { ...s.settings, [key]: value } });
  const value = (key: string) => s.settings[key] ?? '';
  const mode = form.mode ? value(form.mode.key) || form.mode.default : '';

  const save = async () => {
    setBusy(true);
    try {
      const settings = { ...s.settings, ...(form.mode ? { [form.mode.key]: mode } : {}) };
      await api('PUT', `/api/social/sources/${encodeURIComponent(s.id)}`, { ...s, name: s.name.trim(), settings });
      await load();
      setBase(JSON.stringify(s));
      onSaved(s.id);
      toast(t('“{name}” saved', { name: s.name }), 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Delete the connection “{name}”?', { name: s.name }), confirm: t('Delete'), danger: true }))) return;
    try {
      await api('DELETE', `/api/social/sources/${encodeURIComponent(s.id)}`);
      await load();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const test = async () => {
    try {
      await api('POST', `/api/social/sources/${encodeURIComponent(s.id)}/test`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast(t('Copied'), 'info'))
      .catch(() => toast(text));
  const hookToken = info?.settings.hookToken;
  const hook = form.hook && hookToken ? `${location.origin}/api/social/hook/${s.id}?token=${hookToken}` : '';
  const read = (value('read') || 'chat,superChats').split(',').filter(Boolean);

  return (
    <div className="source-editor soc-editor">
      <div className="se-form">
        <div className="se-head">
          <PlatformBadge platform={s.platform} size={28} />
          <input className="se-name" placeholder={t('Name')} value={s.name} disabled={!editable} onChange={(e) => setS({ ...s, name: e.target.value })} />
        </div>
        {info?.account && (
          <label>
            {t('Account')}
            <input value={`${info.account} ✓`} disabled />
          </label>
        )}
        {form.mode && (
          <label>
            {s.platform === 'instagram' ? t('Posts') : s.platform === 'facebook' ? t('Comments') : t('Live')}
            <Segmented value={mode} options={form.mode.options.map((o) => ({ value: o.value, label: t(o.label) }))} onChange={(v) => editable && set(form.mode!.key, v)} />
          </label>
        )}
        {form.fields
          .filter((f) => !f.when || (f.when[0] === form.mode?.key ? mode : value(f.when[0])) === f.when[1])
          .map((f) => (
            <label key={f.key}>
              {t(f.label)}
              <input type={f.secret ? 'password' : 'text'} autoComplete={f.secret ? 'new-password' : 'off'} placeholder={f.placeholder} value={value(f.key)} disabled={!editable} onFocus={(e) => f.secret && e.target.value === '••••' && set(f.key, '')} onChange={(e) => set(f.key, e.target.value)} />
            </label>
          ))}
        {s.platform === 'youtube' && (
          <label>
            {t('Read')}
            <span className="soc-chips">
              {YT_READ.map((r) => (
                <button key={r.value} className={`soc-chip ${read.includes(r.value) ? 'on' : ''}`} disabled={!editable} onClick={() => set('read', (read.includes(r.value) ? read.filter((x) => x !== r.value) : [...read, r.value]).join(','))}>
                  {t(r.label)}
                </button>
              ))}
            </span>
          </label>
        )}
        {hook && (
          <label>
            {t('Webhook address')}
            <span className="soc-copy">
              <input value={hook} readOnly onFocus={(e) => e.target.select()} />
              <button className="btn small" title={t('Copy')} onClick={() => copy(hook)}>
                <Copy size={13} />
              </button>
            </span>
          </label>
        )}
        {hook && s.platform === 'tiktok' && (
          <div className="push-help">
            <pre>{`python bridge.py ${value('user') || '@…'} "${hook}"`}</pre>
            <div className="row">
              <button className="btn small" onClick={() => copy(`python bridge.py ${value('user') || '@…'} "${hook}"`)}>
                <Copy size={13} /> {t('Copy')}
              </button>
            </div>
          </div>
        )}
        <label className="switch check">
          <input type="checkbox" checked={s.enabled} disabled={!editable} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          {t('Enabled')}
        </label>
        {info?.error && (
          <p className="error-text">
            <CircleAlert size={13} /> {info.error}
          </p>
        )}
        <div className="se-actions soc-actions">
          {editable && !isNew && (
            <button className="btn small danger" onClick={remove}>
              <Trash2 size={13} /> {t('Delete')}
            </button>
          )}
          <div className="spacer" />
          {isNew && (
            <button className="btn small" onClick={onClose}>
              {t('Cancel')}
            </button>
          )}
          {editable && !isNew && (
            <button className="btn small" onClick={test}>
              <FlaskConical size={13} /> {t('Test')}
            </button>
          )}
          {editable && dirty && (
            <button className="btn small primary" disabled={busy || !s.name.trim()} onClick={save}>
              <Save size={13} /> {isNew ? t('Create') : t('Save')}
            </button>
          )}
        </div>
      </div>
      {info ? <Feed info={info} /> : <div className="se-preview" />}
    </div>
  );
}

/** Messages per 10 s over the last 80 s. */
function spark(list: SocialMessage[]) {
  const now = Date.now();
  const bars = new Array(8).fill(0);
  for (const m of list) {
    const i = 7 - Math.floor((now - m.at) / 10_000);
    if (i >= 0 && i < 8) bars[i]++;
  }
  const max = Math.max(1, ...bars);
  return bars.map((n) => Math.max(6, (n / max) * 100));
}

/** The last messages of a connection, newest first. */
function Feed({ info }: { info: SocialInfo }) {
  const [list, setList] = useState<SocialMessage[]>([]);
  useEffect(() => {
    let live = true;
    const get = () =>
      api<SocialMessage[]>('GET', `/api/social/sources/${encodeURIComponent(info.id)}/messages?limit=100`)
        .then((l) => live && setList(l))
        .catch(() => {});
    get();
    const timer = setInterval(get, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [info.id]);
  const time = (at: number) => new Date(at).toLocaleTimeString(locale(), { hour12: false });
  return (
    <div className="se-preview soc-feed">
      <div className="se-preview-head soc-feed-head">
        <strong>{t('Messages')}</strong>
        <span className="muted small">{t('{n} / min', { n: info.perMin })}</span>
        <div className="spacer" />
        <span className="soc-spark">
          {spark(list).map((h, i) => (
            <i key={i} style={{ height: `${h}%` }} />
          ))}
        </span>
      </div>
      {list.map((m) => (
        <div key={m.id} className="soc-msg">
          <PlatformBadge platform={m.platform} />
          <div className="soc-msg-body">
            <div className="soc-msg-who">
              <strong>{m.author.name || m.author.handle || '—'}</strong>
              {m.author.handle && m.author.handle !== m.author.name && <span className="muted">@{m.author.handle}</span>}
              {m.author.city && <span className="muted">· {m.author.city}</span>}
              <span className="spacer" />
              <time>{time(m.at)}</time>
            </div>
            <div className="soc-msg-text">
              {m.amount && <span className="soc-amount">{m.platform === 'youtube' ? `Super Chat ${m.amount}` : m.amount}</span>}
              {m.text}
            </div>
            {!!m.photos?.length && (
              <div className="soc-photos">
                {m.photos.map((p) => (
                  <img key={p} src={p} alt="" loading="lazy" />
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
