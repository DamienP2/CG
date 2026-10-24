import { Camera, Check, ChevronsRight, CircleCheck, GripVertical, Inbox, Pause, Pencil, Play, Search, Star, Undo2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultData, holdFrame } from '../engine/evaluate';
import { inFormat, projectFormats } from '../engine/formats';
import { LiveTime } from '../engine/LiveTime';
import { Scene, Viewport } from '../engine/Scene';
import type { Project, Template } from '../engine/types';
import { useBoundData } from '../data/dataStore';
import { lang, locale, t, tc } from '../i18n';
import { Dropdown } from '../ui/Dropdown';
import { Segmented } from '../ui/fields';
import { useApp } from '../store';
import { PlatformBadge } from './PlatformBadge';
import { act, airName, airText, save, useSocial, type Card, type Desk, type NameMode, type Tag } from './socialStore';

/*
 * Moderation: the messages coming in, those approved (in the order they
 * go on air), and what is on air. Keys: A approve, R reject, E edit,
 * S star, ↑↓ move through the messages.
 */

/** The label of a tag, as shown on a message. */
export function tagLabel(tag: Tag): string {
  switch (tag.kind) {
    case 'question':
      return t('QUESTION');
    case 'photo':
      return t('PHOTO');
    case 'link':
      return t('LINK');
    case 'tox':
      return t('TOX {n}', { n: Number(tag.value ?? 0).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
    case 'banned':
      return t('BANNED WORD');
    case 'personal':
      return t('PERSONAL DATA');
    case 'caps':
      return t('CAPITALS');
    case 'length':
      return t('LENGTH');
    case 'emojis':
      return t('EMOJIS');
    case 'duplicate':
      return t('DUPLICATE');
    case 'fixed':
      return t('FIXED');
    case 'check':
      return t('TO CHECK');
    case 'autoReject':
      return t('AUTO REJECT');
    case 'blocked':
      return t('BLOCKED ACCOUNT');
    case 'trusted':
      return t('TRUSTED ACCOUNT');
    case 'msgs':
      return t('{n} MSG', { n: tag.value ?? '' });
  }
}

/** Banned words, masked by the server, drawn as marks. */
function Shown({ text }: { text: string }) {
  const parts = text.split(/(•{4,})/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="mod-mask">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

const time = (at: number, seconds = true) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined });

/** Time left until `at` (server clock, ms), in whole seconds. */
function useLeft(at: number | null) {
  const offset = useApp((s) => s.serverOffset);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    const h = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(h);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now - offset) / 1000));
}

export function Moderation({ projectId, desk }: { projectId: string; desk: Desk }) {
  const project = useApp((s) => (s.project?.id === projectId ? s.project : null));
  const [sel, setSel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [photos, setPhotos] = useState(false);
  // Frozen: the list stays as it is while new messages wait.
  const [frozen, setFrozen] = useState<Set<string> | null>(null);
  const [editing, setEditing] = useState(0);

  const incoming = useMemo(() => {
    const q = query.trim().toLowerCase();
    return desk.incoming
      .filter((c) => !frozen || frozen.has(c.message.id))
      .filter((c) => !photos || c.message.photos?.length)
      .filter((c) => !q || `${c.author} ${c.shown} ${c.message.author.city ?? ''}`.toLowerCase().includes(q))
      .slice()
      .reverse();
  }, [desk.incoming, query, photos, frozen]);
  const waiting = frozen ? desk.incoming.filter((c) => !frozen.has(c.message.id)).length : 0;
  const all = useMemo(() => [...incoming, ...(desk.onAir ? [desk.onAir] : []), ...desk.approved], [incoming, desk.onAir, desk.approved]);
  const selected = all.find((c) => c.message.id === sel) ?? null;
  const isIncoming = (id: string) => incoming.some((c) => c.message.id === id);

  // Keys: on the selected message.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const list = sel && !isIncoming(sel) ? [...(desk.onAir ? [desk.onAir] : []), ...desk.approved] : incoming;
    const i = list.findIndex((c) => c.message.id === sel);
    const move = (d: number) => {
      const next = list[Math.min(list.length - 1, Math.max(0, i + d))];
      if (next) setSel(next.message.id);
    };
    // After an action on an incoming message: the next one.
    const after = () => {
      const next = list[i + 1] ?? list[i - 1];
      setSel(next ? next.message.id : null);
    };
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (!sel) return;
    else if (k === 'a' && isIncoming(sel)) {
      void act(projectId, 'approve', { id: sel });
      after();
    } else if (k === 'r') {
      void act(projectId, 'reject', { id: sel });
      after();
    } else if (k === 'e') setEditing((n) => n + 1);
    else if (k === 's') void act(projectId, 'star', { id: sel });
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, []);

  return (
    <div className="mod-cols">
      <section className="mod-col">
        <header className="mod-head">
          <b>{t('Incoming')}</b>
          <span className="mod-count live">{desk.incoming.length}</span>
          <span className="spacer" />
          <label className="mod-search">
            <Search size={13} />
            <input value={query} placeholder={t('Search')} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className={`mod-chip ${photos ? 'on' : ''}`} onClick={() => setPhotos(!photos)}>
            <Camera size={12} /> {t('Photos')}
          </button>
          <button className={`mod-chip ${frozen ? 'on' : ''}`} onClick={() => setFrozen(frozen ? null : new Set(desk.incoming.map((c) => c.message.id)))}>
            <Pause size={12} /> {t('Freeze')}
            {waiting > 0 && <span className="mod-waiting">+{waiting}</span>}
          </button>
        </header>
        <div className="mod-list">
          {!incoming.length && <NoMessage icon={<Inbox size={22} />} />}
          {incoming.map((c) => (
            <IncomingCard key={c.message.id} card={c} selected={sel === c.message.id} onSelect={() => setSel(c.message.id)} projectId={projectId} onEdit={() => {
              setSel(c.message.id);
              setEditing((n) => n + 1);
            }} />
          ))}
        </div>
      </section>
      <Approved projectId={projectId} desk={desk} sel={sel} onSelect={setSel} />
      <section className="mod-col mod-air">
        <AirHead projectId={projectId} desk={desk} project={project} />
        {project && <AirPreview project={project} templateId={desk.display.templateId} />}
        <AirCard projectId={projectId} desk={desk} />
        {selected && <EditPanel key={`${selected.message.id}-${editing}`} projectId={projectId} card={selected} mode={desk.display.nameMode} focus={editing > 0} onClose={() => setSel(null)} />}
      </section>
    </div>
  );
}

function Tags({ tags, words }: { tags: Tag[]; words?: string[] }) {
  return (
    <div className="mod-tags">
      {tags.map((g, i) => (
        <span key={i} className={`mod-tag ${g.level}`} title={g.kind === 'link' ? g.value : g.kind === 'banned' ? words?.join(', ') : undefined}>
          {tagLabel(g)}
        </span>
      ))}
    </div>
  );
}

function IncomingCard({ card: c, selected, onSelect, onEdit, projectId }: { card: Card; selected: boolean; onSelect: () => void; onEdit: () => void; projectId: string }) {
  const m = c.message;
  const n = m.photos?.length ?? 0;
  return (
    <div className={`mod-msg ${selected ? 'sel' : ''} ${c.status}`} onClick={onSelect}>
      <PlatformBadge platform={m.platform} size={20} />
      <div className="mod-msg-body">
        <div className="mod-who">
          <b>{c.author}</b>
          <span className="muted">
            {m.author.city ? ` · ${m.author.city}` : ''} · {time(m.at)}
          </span>
          {m.amount && <span className="mod-amount">{m.amount}</span>}
        </div>
        <div className="mod-text" title={c.words?.length ? c.words.join(', ') : undefined}>
          <Shown text={c.shown} />
          {n > 0 && (
            <span className="mod-chip small">
              <Camera size={11} /> {n}
            </span>
          )}
        </div>
        <Tags tags={c.tags} words={c.words} />
      </div>
      <div className="mod-qa" onClick={(e) => e.stopPropagation()}>
        <button className="yes" title={t('Approve (A)')} onClick={() => act(projectId, 'approve', { id: m.id })}>
          <Check size={13} />
        </button>
        <button className="no" title={t('Reject (R)')} onClick={() => act(projectId, 'reject', { id: m.id })}>
          <X size={13} />
        </button>
        <button title={t('Edit (E)')} onClick={onEdit}>
          <Pencil size={12} />
        </button>
        <button className={c.starred ? 'star' : ''} title={t('Star (S)')} onClick={() => act(projectId, 'star', { id: m.id })}>
          <Star size={12} fill={c.starred ? 'currentColor' : 'none'} />
        </button>
      </div>
    </div>
  );
}

/** The approved messages, in the order they go on air (dragged to reorder). */
function Approved({ projectId, desk, sel, onSelect }: { projectId: string; desk: Desk; sel: string | null; onSelect: (id: string) => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [secs, setSecs] = useState(String(desk.display.rotationSecs));
  useEffect(() => setSecs(String(desk.display.rotationSecs)), [desk.display.rotationSecs]);
  const drop = (at: number) => {
    if (!drag) return;
    const ids = desk.approved.map((c) => c.message.id).filter((id) => id !== drag);
    const from = desk.approved.findIndex((c) => c.message.id === drag);
    ids.splice(from < at ? at - 1 : at, 0, drag);
    // Shown at once; the server sends the order to everyone.
    const byId = new Map(desk.approved.map((c) => [c.message.id, c]));
    useSocial.setState((s) => (s.desk ? { desk: { ...s.desk, approved: ids.map((id) => byId.get(id)!) } } : s));
    void act(projectId, 'reorder', { ids });
    setDrag(null);
    setOver(null);
  };
  const rotation = (on: boolean, n = Number(secs)) => act(projectId, 'rotation', { on, secs: Math.max(2, Math.round(n) || desk.display.rotationSecs) });
  return (
    <section className="mod-col">
      <header className="mod-head">
        <b>{t('Approved')}</b>
        <span className="mod-count">{desk.approved.length}</span>
        <span className="spacer" />
        <label className="mod-chip mod-secs" title={t('Rotation')}>
          {t('Rotation')}
          <input type="number" min={2} max={3600} value={secs} onChange={(e) => setSecs(e.target.value)} onBlur={() => Number(secs) !== desk.display.rotationSecs && rotation(desk.display.rotation)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          {t('s')}
        </label>
        <label className="switch">
          <input type="checkbox" checked={desk.display.rotation} onChange={(e) => rotation(e.target.checked)} />
        </label>
      </header>
      <div className="mod-list mod-queue" onDragOver={(e) => e.preventDefault()} onDrop={() => drop(desk.approved.length)}>
        {desk.onAir && <QueueCard card={desk.onAir} badge="air" selected={sel === desk.onAir.message.id} onSelect={() => onSelect(desk.onAir!.message.id)} projectId={projectId} mode={desk.display.nameMode} />}
        {desk.approved.map((c, i) => (
          <div
            key={c.message.id}
            draggable
            className={`mod-drag ${drag === c.message.id ? 'dragging' : ''} ${over === i && drag ? 'over' : ''}`}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              setDrag(c.message.id);
            }}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(i);
            }}
            onDrop={(e) => {
              e.stopPropagation();
              drop(i);
            }}
          >
            <QueueCard card={c} badge={i === 0 ? 'next' : undefined} selected={sel === c.message.id} onSelect={() => onSelect(c.message.id)} projectId={projectId} mode={desk.display.nameMode} />
          </div>
        ))}
        {!desk.onAir && !desk.approved.length && <NoMessage icon={<CircleCheck size={22} />} />}
      </div>
    </section>
  );
}

/** An empty column. */
function NoMessage({ icon }: { icon: React.ReactNode }) {
  return (
    <div className="empty big ux3-no-msg">
      {icon}
      <p>{t('No message')}</p>
    </div>
  );
}

function QueueCard({ card: c, badge, selected, onSelect, projectId, mode }: { card: Card; badge?: 'air' | 'next'; selected: boolean; onSelect: () => void; projectId: string; mode: NameMode }) {
  const m = c.message;
  const name = airName(c, c.nameMode ?? mode);
  return (
    <div className={`mod-qcard ${badge === 'air' ? 'air' : ''} ${selected ? 'sel' : ''}`} onClick={onSelect}>
      <GripVertical size={14} className="mod-grip" />
      <PlatformBadge platform={m.platform} size={20} />
      <div className="mod-msg-body">
        <div className="mod-who">
          {name ? <b>{name}</b> : <b className="mod-anon">{c.author}</b>}
          {m.author.city && <span className="muted"> {m.author.city}</span>}
        </div>
        <div className="mod-text">{airText(c)}</div>
        {c.edit !== undefined && (
          <div className="mod-edited">
            <Pencil size={11} /> {t('edited')}
          </div>
        )}
        {m.photos?.[0] && <img className="mod-photo" src={m.photos[0]} alt="" loading="lazy" />}
      </div>
      <div className="mod-qside" onClick={(e) => e.stopPropagation()}>
        {badge === 'air' && <span className="mod-badge air">{tc('queue', 'ON AIR')}</span>}
        {badge === 'next' && <span className="mod-badge next">{t('NEXT')}</span>}
        <div className="mod-qa">
          {badge !== 'air' && (
            <button className="take" title={t('Take')} onClick={() => act(projectId, 'take', { id: m.id })}>
              <Play size={12} />
            </button>
          )}
          {badge !== 'air' && (
            <button title={t('Back to incoming')} onClick={() => act(projectId, 'remove', { id: m.id })}>
              <Undo2 size={12} />
            </button>
          )}
          <button className={c.starred ? 'star' : ''} title={t('Star (S)')} onClick={() => act(projectId, 'star', { id: m.id })}>
            <Star size={12} fill={c.starred ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** "À l'antenne": the template showing the messages, and its channel. */
function AirHead({ projectId, desk, project }: { projectId: string; desk: Desk; project: Project | null }) {
  const channels = useApp((s) => s.channels).filter((c) => c.projectId === projectId);
  const d = desk.display;
  // The channel the project is loaded on, when there is one only.
  useEffect(() => {
    if (!channels.some((c) => c.id === d.channelId) && channels.length === 1) void save(projectId, 'display', { ...d, channelId: channels[0].id });
  }, [channels.map((c) => c.id).join(), d.channelId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <header className="mod-head">
      <b>{t('On air')}</b>
      <span className="spacer" />
      {channels.length > 1 && <Dropdown value={d.channelId} options={channels.map((c) => ({ value: c.id, label: c.name }))} placeholder={t('Channel')} onChange={(v) => save(projectId, 'display', { ...d, channelId: v })} />}
      <Dropdown className="mod-template" value={d.templateId} options={(project?.templates ?? []).map((tp) => ({ value: tp.id, label: tp.name }))} placeholder={t('Template')} onChange={(v) => save(projectId, 'display', { ...d, templateId: v })} />
    </header>
  );
}

/** The template with the data it reads now (the message on air). */
function AirPreview({ project, templateId }: { project: Project; templateId: string }) {
  const template = project.templates.find((x) => x.id === templateId);
  const format = projectFormats(project)[0];
  return <div className="mod-monitor">{template ? <Screen width={format.width} height={format.height}>{<PreviewOf project={project} template={template} />}</Screen> : <div className="mod-monitor-empty">{t('No template')}</div>}</div>;
}

function PreviewOf({ project, template }: { project: Project; template: Template }) {
  const base = useMemo(() => defaultData(inFormat(template, null)), [template]);
  const bound = useBoundData(template, base);
  const data = useMemo(() => ({ ...base, ...bound }), [base, bound]);
  const fps = project.frameRate.num / project.frameRate.den || 25;
  const hold = holdFrame(template);
  return (
    <LiveTime ageSecs={hold / fps} fps={fps} lang={lang()}>
      <Scene template={template} frame={hold} data={data} />
    </LiveTime>
  );
}

/** Content scaled to fit its box. */
function Screen({ width, height, children }: { width: number; height: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.max(0.01, Math.min(el.clientWidth / width, el.clientHeight / height))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);
  return (
    <div className="mod-screen" ref={ref} style={{ aspectRatio: `${width} / ${height}` }}>
      <Viewport width={width} height={height} scale={scale}>
        {children}
      </Viewport>
    </div>
  );
}

/** The message on air: next, out, and the time to the next rotation. */
function AirCard({ projectId, desk }: { projectId: string; desk: Desk }) {
  const left = useLeft(desk.display.rotation ? desk.rotationAt : null);
  const c = desk.onAir;
  return (
    <div className={`mod-aircard ${c ? 'live' : ''}`}>
      {c ? (
        <>
          <PlatformBadge platform={c.message.platform} size={20} />
          <b className="mod-air-name">{airName(c, c.nameMode ?? desk.display.nameMode) || c.author}</b>
        </>
      ) : (
        <span className="muted">{t('Nothing on air')}</span>
      )}
      <span className="spacer" />
      {left !== null && <span className="mod-count">{t('{n} s', { n: left })}</span>}
      {c ? (
        <button className="btn" disabled={!desk.approved.length} onClick={() => act(projectId, 'next', { from: c.message.id })}>
          <ChevronsRight size={14} /> {t('NEXT')}
        </button>
      ) : (
        <button className="btn mod-take" disabled={!desk.approved.length} onClick={() => act(projectId, 'next', {})}>
          <Play size={13} /> {t('TAKE')}
        </button>
      )}
      <button className="btn mod-out" disabled={!c} onClick={() => act(projectId, 'out')}>
        {t('OUT')}
      </button>
    </div>
  );
}

/** "Edit before air": the text, and how the author is named. */
function EditPanel({ projectId, card, mode, focus, onClose }: { projectId: string; card: Card; mode: NameMode; focus: boolean; onClose: () => void }) {
  const [text, setText] = useState(airText(card));
  const [name, setName] = useState<NameMode>(card.nameMode ?? mode);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  const original = card.message.text.trim();
  const changed = text.trim() !== airText(card) || name !== (card.nameMode ?? mode);
  const valid = async () => {
    await act(projectId, 'edit', { id: card.message.id, text, nameMode: name });
    ref.current?.blur();
  };
  return (
    <div className="mod-edit">
      <div className="mod-edit-head">
        <b>{t('Edit before air')}</b>
        <span className="spacer" />
        <span className="muted">{airName(card, name) || card.author}</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void valid();
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
        }}
      />
      {text.trim() !== original && <div className="mod-original">{original}</div>}
      <Segmented
        value={name}
        onChange={setName}
        options={[
          { value: 'initial', label: t('First name + initial') },
          { value: 'full', label: t('Full name') },
          { value: 'anonymous', label: t('Anonymous') },
        ]}
      />
      <div className="mod-edit-actions">
        <button className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button className="btn primary" disabled={!changed} onClick={valid}>
          {tc('edit', 'Confirm')}
        </button>
      </div>
    </div>
  );
}
