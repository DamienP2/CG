import { Plus, Search, Trash2, Video, VideoOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../store';
import { t, tc, tn } from '../i18n';
import { inputMessage as messageText } from '../engine/liveInputs';
import type { InputConfig, InputInfo, InputKind, ServerConfig } from './types';
import { useMetrics, type InputMetrics } from '../engine/metrics';
import { coresLabel, fps as fpsText, fpsTone, inputTone, num } from '../perf/format';
import '../perf/perf.css';

/*
 * The INPUTS mode of the Video streams page: live video coming into the
 * server (SRT, UDP, RTMP, HLS, RTSP, any address ffmpeg reads, NDI, SDI),
 * shown by the Video widget. Saved with the rest of the settings (the save
 * bar of the page); the server restarts only the inputs that changed.
 */

const COLOR = '#a78bfa';

/** Labels translated where shown. */
const KINDS: { value: InputKind; label: string; badge: string }[] = [
  { value: 'srt', label: 'SRT', badge: 'SRT' },
  { value: 'udp', label: 'UDP', badge: 'UDP' },
  { value: 'rtmp', label: 'RTMP', badge: 'RTMP' },
  { value: 'hls', label: 'HLS', badge: 'HLS' },
  { value: 'rtsp', label: 'RTSP', badge: 'RTSP' },
  { value: 'url', label: 'Address / file', badge: 'URL' },
  { value: 'ndi', label: 'NDI', badge: 'NDI' },
  { value: 'sdi', label: 'SDI', badge: 'SDI' },
];
const badgeOf = (k: InputKind) => KINDS.find((x) => x.value === k)?.badge ?? k.toUpperCase();
const SCHEMES: Partial<Record<InputKind, RegExp>> = { srt: /^srt:/i, udp: /^udp:/i, rtmp: /^rtmps?:/i, hls: /^https?:/i, rtsp: /^rtsps?:/i };
const isStream = (k: InputKind) => k !== 'ndi' && k !== 'sdi';
const canListen = (k: InputKind) => k === 'srt' || k === 'rtmp';

/** SRT: Strata calls the sender, or waits for it; RTMP: Strata pulls, or the encoder pushes. Labels translated where shown. */
const MODES: Partial<Record<InputKind, { listen: boolean; label: string; hint: string }[]>> = {
  srt: [
    { listen: false, label: 'Caller', hint: 'Strata connects to the sender, which must be listening.' },
    { listen: true, label: 'Listener', hint: 'Strata waits for the sender to connect.' },
  ],
  rtmp: [
    { listen: false, label: 'Pull', hint: 'Strata pulls the stream from a server.' },
    { listen: true, label: 'Listen', hint: 'The encoder pushes the stream to Strata.' },
  ],
};
const modeOf = (c: Pick<InputConfig, 'kind' | 'listen'>) => MODES[c.kind]?.find((m) => m.listen === !!c.listen);
/** "SRT · Listener". */
const badgeText = (c: Pick<InputConfig, 'kind' | 'listen'>) => {
  const m = modeOf(c);
  return m ? `${badgeOf(c.kind)} · ${tc('short', m.label)}` : badgeOf(c.kind);
};

const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 3840, height: 2160 },
];
const RATES = [25, 30, 50, 60];
/** Smoothing buffer, in frames. */
const BUFFERS = [0, 1, 2, 3, 5];

/** Previews streaming at once: a browser opens ~6 connections per server over HTTP/1.1. */
const MAX_PREVIEWS = 4;
const previewUrl = (id: string) => `/api/inputs/${encodeURIComponent(id)}/live.mjpeg?w=480`;

function placeholder(c: Pick<InputConfig, 'kind' | 'listen'>): string {
  switch (c.kind) {
    case 'srt':
      return c.listen ? 'srt://0.0.0.0:9000' : 'srt://host:9000';
    case 'udp':
      return 'udp://@239.1.1.1:5000';
    case 'rtmp':
      return c.listen ? 'rtmp://0.0.0.0:1935/live/cam1' : 'rtmp://server/app/key';
    case 'hls':
      return 'https://…/index.m3u8';
    case 'rtsp':
      return 'rtsp://camera/stream';
    default:
      return 'https://… · /path/to/clip.mp4';
  }
}

/** The address a mode starts with (SRT keeps the port). */
function modeDefault(c: Pick<InputConfig, 'kind' | 'listen' | 'url'>): string {
  const port = /:(\d+)(?:[/?]|$)/.exec(c.url)?.[1] ?? '9000';
  if (c.kind === 'srt') return c.listen ? `srt://0.0.0.0:${port}` : `srt://host:${port}`;
  return placeholder(c);
}

function addressHint(c: InputConfig): string {
  const host = location.hostname;
  const port = /:(\d+)(?:[/?]|$)/.exec(c.url)?.[1] ?? '9000';
  switch (c.kind) {
    case 'srt':
      return c.listen ? t('Listener, e.g. srt://0.0.0.0:9000: the senders push to this server, srt://{host}:{port}.', { host, port }) : t("The sender's address, e.g. srt://host:9000 (it must be listening).");
    case 'udp':
      return t('udp://@239.1.1.1:5000 to join a multicast group, or udp://0.0.0.0:5000 for packets sent to this server.');
    case 'rtmp':
      return c.listen ? t('Senders push to rtmp://{host}:1935/live/cam1: set the address to rtmp://0.0.0.0:1935/live/cam1.', { host }) : t('The stream to pull, e.g. rtmp://server/app/key.');
    case 'hls':
      return t('The playlist, e.g. https://…/index.m3u8.');
    case 'rtsp':
      return t("The camera's stream, e.g. rtsp://camera/stream.");
    default:
      return t('Anything ffmpeg reads: an address (http, rtp, srt…) or a file on the server.');
  }
}


/** Waiting is not failing. */
const WAITING = /^(Starting…|Waiting for the sender…|Connecting…|Connecting to .*…|Not started.*)$/;

type Tone = 'ok' | 'warn' | 'idle';

export function InputsMode({ cfg, saved, edit }: { cfg: ServerConfig; saved: ServerConfig; edit: (fn: (c: ServerConfig) => void) => void }) {
  const inputs = cfg.inputs ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const [status, setStatus] = useState<InputInfo[]>([]);
  const [ndi, setNdi] = useState<{ busy: boolean; sources: string[]; error?: string }>({ busy: false, sources: [] });
  const metrics = useMetrics();
  const rates = (id: string) => metrics?.inputs.find((x) => x.id === id);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      api<InputInfo[]>('GET', '/api/inputs')
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    poll();
    const h = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, []);

  const current = inputs.find((i) => i.id === sel) ?? inputs[0];
  const savedOf = (id: string) => (saved.inputs ?? []).find((i) => i.id === id);
  const stateOf = (c: InputConfig): { tone: Tone; text: string; live: boolean; info?: InputInfo } => {
    const s = savedOf(c.id);
    const info = status.find((x) => x.id === c.id);
    if (!s || !info) return { tone: 'idle', text: s ? t('Starting…') : t('Not applied yet'), live: false };
    if (info.live) return { tone: 'ok', text: messageText(info.message) || t('Receiving'), live: true, info };
    return { tone: WAITING.test(info.message) ? 'idle' : 'warn', text: messageText(info.message), live: false, info };
  };
  // The selected input streams first, then the others while there is room.
  const streaming = new Set(
    [current, ...inputs.filter((i) => i !== current)]
      .filter((i): i is InputConfig => !!i && stateOf(i).live)
      .slice(0, MAX_PREVIEWS)
      .map((i) => i.id),
  );

  const editInput = (fn: (i: InputConfig) => void) =>
    edit((c) => {
      const i = (c.inputs ?? []).find((x) => x.id === current?.id);
      if (i) fn(i);
    });

  const add = () => {
    const ids = new Set(inputs.map((i) => i.id));
    let n = 1;
    while (ids.has(`input-${n}`)) n++;
    const id = `input-${n}`;
    // An SRT listener on a port nothing else uses.
    const urls = [...inputs.map((i) => i.url), ...cfg.channels.flatMap((ch) => [ch.outputs, ...(ch.renditions ?? []).map((r) => r.outputs)].flatMap((o) => (o.streams ?? []).map((s) => s.url)))];
    let port = 10000;
    while (urls.some((u) => new RegExp(`:${port}(?:[/?]|$)`).test(u))) port++;
    edit((c) => void (c.inputs ??= []).push({ id, name: t('Input {n}', { n }), kind: 'srt', url: `srt://0.0.0.0:${port}`, listen: true, ndiSource: '', device: 0, width: 1920, height: 1080, fps: 25, buffer: 2, hwDecode: false }));
    setSel(id);
  };

  const remove = () => {
    if (!current) return;
    const at = inputs.indexOf(current);
    edit((c) => void (c.inputs = (c.inputs ?? []).filter((i) => i.id !== current.id)));
    setSel(inputs[at + 1]?.id ?? inputs[at - 1]?.id ?? null);
  };

  const setKind = (k: InputKind) =>
    editInput((i) => {
      if (i.kind === k) return;
      i.kind = k;
      if (!canListen(k)) i.listen = false;
      // An address of another protocol goes.
      const scheme = SCHEMES[k];
      if (scheme && !scheme.test(i.url.trim())) i.url = i.listen ? placeholder(i) : '';
    });

  const findNdi = async () => {
    setNdi((s) => ({ ...s, busy: true, error: undefined }));
    try {
      const sources = await api<string[]>('GET', '/api/inputs/ndi-sources');
      setNdi({ busy: false, sources, error: sources.length ? undefined : t('No NDI source found on the network.') });
    } catch (e) {
      setNdi({ busy: false, sources: [], error: (e as Error).message });
    }
  };

  const liveCount = inputs.filter((i) => stateOf(i).live).length;

  return (
    <div className="outputs-page">
      <aside className="lib-nav">
        <div className="lib-nav-section">
          <span className="grow">{t('Inputs')}</span>
          <button className="icon-btn ghost" title={t('Add an input')} onClick={add}>
            <Plus size={14} />
          </button>
        </div>
        {inputs.map((i) => {
          const st = stateOf(i);
          return (
            <button key={i.id} className={`oc-channel vs-item ${i.id === current?.id ? 'on' : ''}`} onClick={() => setSel(i.id)}>
              <span className={`oc-dot ${st.tone}`} />
              <span className="grow">
                <span>{i.name || i.id}</span>
                <small title={st.text}>{st.text}</small>
              </span>
              <Rate m={rates(i.id)} />
              <span className="vs-badge" style={{ ['--k' as string]: COLOR }}>
                {badgeText(i)}
              </span>
            </button>
          );
        })}
        <button className="oc-channel vs-item add" onClick={add}>
          <Plus size={13} /> {t('Add an input')}
        </button>
        <p className="lib-nav-hint">{t('Cameras, encoders, NDI or SDI sources coming into the server. The Video widget shows them in the graphics.')}</p>
      </aside>

      <main className="oc-main">
        <header className="oc-head">
          <div>
            <h1>{t('Inputs')}</h1>
            <span className="muted small">
              {tn(inputs.length, '{n} input', '{n} inputs')} · {t('{n} receiving', { n: liveCount })}
            </span>
          </div>
          <div className="spacer" />
          <div className="oc-tools">
            <button className="oc-tool" onClick={add}>
              <Video size={15} color={COLOR} /> {t('Add an input')}
            </button>
          </div>
        </header>

        <div className="oc-body">
          <div className="vs-grid-wrap">
            {inputs.length === 0 ? (
              <div className="vs-empty">
                <VideoOff size={28} />
                <p>{t('No input yet. Add an SRT, RTMP or NDI source, a camera… and show it with the Video widget.')}</p>
                <button className="btn primary" onClick={add}>
                  <Plus size={14} /> {t('Add an input')}
                </button>
              </div>
            ) : (
              <div className="vs-grid">
                {inputs.map((i) => {
                  const st = stateOf(i);
                  return (
                    <button key={i.id} className={`vs-tile ${i.id === current?.id ? 'sel' : ''}`} onClick={() => setSel(i.id)}>
                      <Preview id={i.id} live={st.live} streaming={streaming.has(i.id)} />
                      <span className="vs-tile-head">
                        <strong>{i.name || i.id}</strong>
                        <span className="vs-badge" style={{ ['--k' as string]: COLOR }}>
                          {badgeText(i)}
                        </span>
                      </span>
                      <span className="vs-tile-status" title={st.text}>
                        <span className={`oc-dot ${st.tone}`} />
                        <span className="grow">{st.text}</span>
                        <Rate m={rates(i.id)} full />
                        <span className="vs-res">{st.info?.width ? `${st.info.width}×${st.info.height}` : '—'}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="oc-inspector">
            {current ? (
              <Inspector
                input={current}
                state={stateOf(current)}
                rates={rates(current.id)}
                streaming={streaming.has(current.id)}
                editInput={editInput}
                setKind={setKind}
                remove={remove}
                ndi={ndi}
                findNdi={findNdi}
              />
            ) : (
              <p className="oc-hint">{t('Add an input to set it up here.')}</p>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

function Inspector({
  input: i,
  state,
  rates,
  streaming,
  editInput,
  setKind,
  remove,
  ndi,
  findNdi,
}: {
  input: InputConfig;
  state: { tone: Tone; text: string; live: boolean; info?: InputInfo };
  rates?: InputMetrics;
  streaming: boolean;
  editInput: (fn: (i: InputConfig) => void) => void;
  setKind: (k: InputKind) => void;
  remove: () => void;
  ndi: { busy: boolean; sources: string[]; error?: string };
  findNdi: () => void;
}) {
  const size = SIZES.findIndex((s) => s.width === i.width && s.height === i.height);
  const listId = `vs-ndi-${i.id}`;
  return (
    <>
      <div className="oc-ins-head" style={{ ['--k' as string]: COLOR }}>
        <span className="oc-swatch" />
        <div className="grow">
          <small>{t('Input')}</small>
          <strong>{i.name || i.id}</strong>
        </div>
        <button className="icon-btn ghost" title={t('Remove')} onClick={remove}>
          <Trash2 size={15} />
        </button>
      </div>

      <div className="vs-big">
        <Preview id={i.id} live={state.live} streaming={streaming} />
      </div>
      <div className={`oc-state ${state.tone}`}>
        <span className={`oc-dot ${state.tone}`} />
        <span className="grow">{state.text}</span>
        {!!state.info?.frames && <span className="vs-res">{tn(state.info.frames, '{n} frame', '{n} frames')}</span>}
      </div>
      {rates && (
        <div className="vs-perf">
          <div>
            <small>{t('Received')}</small>
            <strong className={`tone-${rates.live ? fpsTone(rates.fps, rates.nominal) : 'idle'}`}>
              {fpsText(rates.fps)} / {fpsText(rates.nominal)} fps
            </strong>
          </div>
          <div>
            <small>{t('Dropped (10 s)')}</small>
            <strong className={rates.dropped ? 'tone-warn' : ''}>{num(rates.dropped)}</strong>
          </div>
          <div>
            <small>CPU</small>
            <strong>{coresLabel(rates.cpu)}</strong>
          </div>
        </div>
      )}

      <Field label={t('Name')} hint={t('How the Video widget lists it.')}>
        <input value={i.name} onChange={(e) => editInput((x) => void (x.name = e.target.value))} />
      </Field>
      <Field label={t('Type')}>
        <select value={i.kind} onChange={(e) => setKind(e.target.value as InputKind)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {t(k.label)}
            </option>
          ))}
        </select>
      </Field>

      {isStream(i.kind) && (
        <>
          {canListen(i.kind) && (
            <Group label={t('Mode')} hint={t(modeOf(i)?.hint ?? '')}>
              <div className="seg vs-seg">
                {MODES[i.kind]!.map((m) => (
                  <button
                    key={m.label}
                    type="button"
                    className={!!i.listen === m.listen ? 'on' : ''}
                    onClick={() =>
                      editInput((x) => {
                        if (!!x.listen === m.listen) return;
                        // An address still the default of the other mode follows.
                        const was = !x.url.trim() || x.url === placeholder(x) || x.url === modeDefault(x);
                        x.listen = m.listen;
                        if (was) x.url = modeDefault(x);
                      })
                    }
                  >
                    {t(m.label)}
                  </button>
                ))}
              </div>
            </Group>
          )}
          <Field label={t('Address')} hint={addressHint(i)}>
            <input value={i.url} placeholder={placeholder(i)} spellCheck={false} onChange={(e) => editInput((x) => void (x.url = e.target.value))} />
          </Field>
        </>
      )}

      {i.kind === 'ndi' && (
        <div className="set-field">
          <label className="set-label" htmlFor={`${listId}-in`}>
            {t('NDI source')}
          </label>
          <div className="vs-row">
            <input id={`${listId}-in`} list={listId} value={i.ndiSource} placeholder={t('HOST (name)')} spellCheck={false} onChange={(e) => editInput((x) => void (x.ndiSource = e.target.value))} />
            <button className="btn small" disabled={ndi.busy} onClick={findNdi}>
              <Search size={13} /> {ndi.busy ? t('Searching…') : t('Find sources')}
            </button>
          </div>
          <datalist id={listId}>
            {ndi.sources.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          {ndi.sources.length > 0 && (
            <div className="vs-sources">
              {ndi.sources.map((s) => (
                <button key={s} type="button" className={s === i.ndiSource ? 'on' : ''} onClick={() => editInput((x) => void (x.ndiSource = s))}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {ndi.error && <span className="set-hint vs-error">{ndi.error}</span>}
          <span className="set-hint">{t('As receivers list it: “HOST (name)”. Pick a source found on the network, or type its name.')}</span>
        </div>
      )}

      {i.kind === 'sdi' && (
        <>
          <Field label={t('DeckLink device')} hint={t('Index as listed by Blackmagic Desktop Video (0 = first).')}>
            <input type="number" min={0} value={i.device} onChange={(e) => editInput((x) => void (x.device = Math.max(0, Math.round(+e.target.value) || 0)))} />
          </Field>
          <Hint>{t('SDI inputs need a server built with DeckLink support.')}</Hint>
        </>
      )}

      {isStream(i.kind) && (
        <>
          <div className="oc-pair vs-pair">
            <Field label={t('Decoded size')}>
              <select
                value={size}
                onChange={(e) =>
                  editInput((x) => {
                    const s = SIZES[+e.target.value];
                    if (s) Object.assign(x, s);
                  })
                }
              >
                {size < 0 && (
                  <option value={-1} disabled>
                    {i.width}×{i.height}
                  </option>
                )}
                {SIZES.map((s, n) => (
                  <option key={n} value={n}>
                    {s.width}×{s.height}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Frames per second')}>
              <select value={i.fps} onChange={(e) => editInput((x) => void (x.fps = +e.target.value))}>
                {!RATES.includes(i.fps) && <option value={i.fps}>{i.fps}</option>}
                {RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Hint>{t('The picture is fitted inside the decoded size. Stream inputs are decoded by ffmpeg, which must be installed on the server.')}</Hint>
        </>
      )}

      <Field label={t('Smoothing buffer')} hint={t('Absorbs network jitter: each frame adds one frame of delay.')}>
        <select value={i.buffer ?? 2} onChange={(e) => editInput((x) => void (x.buffer = +e.target.value))}>
          {!BUFFERS.includes(i.buffer ?? 2) && <option value={i.buffer}>{tn(i.buffer, '{n} frame', '{n} frames')}</option>}
          {BUFFERS.map((b) => (
            <option key={b} value={b}>
              {b === 0 ? t('0 (lowest latency)') : tn(b, '{n} frame', '{n} frames')}
              {b > 0 && isStream(i.kind) && i.fps > 0 ? ` · ${Math.round((b * 1000) / i.fps)} ms` : ''}
            </option>
          ))}
        </select>
      </Field>

      {isStream(i.kind) && (
        <div className="set-field">
          <label className="check">
            <input type="checkbox" checked={!!i.hwDecode} onChange={(e) => editInput((x) => void (x.hwDecode = e.target.checked))} />
            {t('Hardware decoding (GPU)')}
          </label>
          <span className="set-hint">{t('Frees the processor. When the machine has no GPU decoder for this stream, ffmpeg falls back to the processor.')}</span>
        </div>
      )}

      <button className="btn small danger" onClick={remove}>
        <Trash2 size={13} /> {t('Remove the input')}
      </button>
    </>
  );
}

/** The live picture (Motion JPEG), or "No signal". */
function Preview({ id, live, streaming }: { id: string; live: boolean; streaming: boolean }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [id, live]);
  const show = live && streaming && !broken;
  return (
    <span className="vs-preview">
      {show ? (
        <img src={previewUrl(id)} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className="vs-nosignal">
          <VideoOff size={20} />
          {live ? t('Select to watch') : t('No signal')}
        </span>
      )}
    </span>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="set-field">
      <span className="set-label">{label}</span>
      {children}
      {hint && <span className="set-hint">{hint}</span>}
    </label>
  );
}

/** A field holding buttons (a `<label>` would click the first one). */
function Group({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-field">
      <span className="set-label">{label}</span>
      {children}
      {hint && <span className="set-hint">{hint}</span>}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="oc-hint">{children}</p>;
}

/** Pictures received per second against the decoded rate, and those thrown away. */
function Rate({ m, full }: { m?: InputMetrics; full?: boolean }) {
  if (!m || !m.live) return null;
  const tone = inputTone(m);
  const title = m.dropped ? `${t('{fps} of {nominal} fps received', { fps: fpsText(m.fps), nominal: fpsText(m.nominal) })} · ${tn(m.dropped, '{n} picture thrown away (10 s)', '{n} pictures thrown away (10 s)')}` : t('{fps} of {nominal} fps received', { fps: fpsText(m.fps), nominal: fpsText(m.nominal) });
  return (
    <span className={`vs-fps tone-${tone}`} title={title}>
      {fpsText(m.fps)}/{fpsText(m.nominal)}
      {full && ' fps'}
      {full && m.dropped > 0 && ` · −${num(m.dropped)}`}
    </span>
  );
}
