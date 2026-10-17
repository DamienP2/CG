import { Check, Copy, ExternalLink, Image as ImageIcon, MapPin, Network, Pencil, Play, Plus, Radio, Save, Trash2, Tv, Globe } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, can, useApp } from '../store';
import { joinAddr, splitAddr, VIDEO_FORMATS, type ChannelConfig, type Html5Output, type NdiOutput, type OutputState, type OutputsConfig, type SdiOutput, type ServerConfig, type St2110Output, type SystemInfo } from './types';

/*
 * Video outputs as a node canvas: each channel (an independent playout) feeds
 * its pictures (the main format and extra renditions such as 9:16), which
 * feed the destinations: web pages, SDI, ST 2110 and NDI. Channels are
 * sorted by location (a studio, a truck, the web desk…).
 */

type Kind = 'program' | 'picture' | 'html5' | 'sdi' | 'st2110' | 'ndi';
type DestKind = Exclude<Kind, 'program' | 'picture'>;

const KIND: Record<Kind, { label: string; color: string; icon: typeof Play }> = {
  program: { label: 'Program', color: '#9d85ff', icon: Play },
  picture: { label: 'Picture', color: '#38bdf8', icon: ImageIcon },
  html5: { label: 'HTML5', color: '#22c55e', icon: Globe },
  sdi: { label: 'SDI', color: '#f5a524', icon: Tv },
  st2110: { label: 'ST 2110', color: '#e879f9', icon: Network },
  ndi: { label: 'NDI', color: '#14b8a6', icon: Radio },
};

const NODE_W = 232;
const COL = { program: 40, picture: 330, dest: 640 };

const ENCODINGS: { value: NonNullable<St2110Output['encoding']>; label: string }[] = [
  { value: 'fillKey', label: 'Fill + Key · 2 streams (YCbCr 4:2:2 10-bit + KEY)' },
  { value: 'rgba', label: 'RGBA · 1 stream (4:4:4:4 8-bit)' },
  { value: 'ycbcra', label: 'YCbCrA · 1 stream (4:2:2:4 10-bit)' },
];

const PICTURE_PRESETS = [
  { id: 'vertical', name: 'Vertical 9:16', width: 1080, height: 1920 },
  { id: 'square', name: 'Square 1:1', width: 1080, height: 1080 },
  { id: 'portrait', name: 'Portrait 4:5', width: 1080, height: 1350 },
  { id: 'hd', name: '720p', width: 1280, height: 720 },
  { id: 'uhd', name: 'UHD', width: 3840, height: 2160 },
];

const BACKGROUNDS = [
  { value: '', label: 'Transparent' },
  { value: 'black', label: 'Black' },
  { value: '#00b140', label: 'Green (chroma key)' },
];

interface Picture {
  id: string;
  name: string;
  width: number;
  height: number;
  outputs: OutputsConfig;
}

const pictures = (ch: ChannelConfig): Picture[] => [{ id: 'main', name: 'Main', width: ch.width, height: ch.height, outputs: ch.outputs }, ...(ch.renditions ?? [])];

type Dest = { kind: DestKind; picture: string; value: St2110Output | SdiOutput | NdiOutput | Html5Output };

function dests(p: Picture): Dest[] {
  const o = p.outputs;
  return [
    ...(o.html5 ?? []).map((value) => ({ kind: 'html5' as const, picture: p.id, value })),
    ...o.sdi.map((value) => ({ kind: 'sdi' as const, picture: p.id, value })),
    ...o.st2110.map((value) => ({ kind: 'st2110' as const, picture: p.id, value })),
    ...(o.ndi ?? []).map((value) => ({ kind: 'ndi' as const, picture: p.id, value })),
  ];
}

const listOf = (o: OutputsConfig, kind: DestKind) => {
  if (kind === 'ndi') return (o.ndi ??= []);
  if (kind === 'html5') return (o.html5 ??= []);
  return o[kind] as (St2110Output | SdiOutput)[];
};

const formatLabel = (ch: ChannelConfig) => {
  const f = VIDEO_FORMATS.find((x) => x.width === ch.width && x.height === ch.height && x.rate.num * ch.frameRate.den === ch.frameRate.num * x.rate.den);
  return f?.label ?? `${ch.width}×${ch.height} ${+(ch.frameRate.num / ch.frameRate.den).toFixed(2)}p`;
};

const outputUrl = (channel: string, picture: string, bg: string) => `${location.origin}/output/${encodeURIComponent(channel)}${picture === 'main' ? '' : `/${encodeURIComponent(picture)}`}${bg ? `?bg=${encodeURIComponent(bg)}` : ''}`;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item';

const unique = (base: string, taken: Set<string>) => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
};

/** Node positions, per browser (moving a node does not restart the outputs). */
const LAYOUT_KEY = 'pulse.outputsLayout';
type Layout = Record<string, Record<string, { x: number; y: number }>>;
const readLayout = (): Layout => {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
  } catch {
    return {};
  }
};

export function Outputs() {
  const { toast, projects, channels: live, live: liveState, loadOnChannel, auth } = useApp();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [status, setStatus] = useState<Record<string, Record<string, OutputState>>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [sel, setSel] = useState<string>('program');
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [wire, setWire] = useState<{ from: string; moving?: string; x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ picture: string; x: number; y: number } | null>(null);
  const planeRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const i = await api<SystemInfo>('GET', '/api/system');
    setInfo(i);
    setCfg(structuredClone(i.config));
  };
  useEffect(() => {
    load().catch((e) => toast(String(e), 'error'));
    const poll = () =>
      api<Record<string, Record<string, OutputState>>>('GET', '/api/outputs/status')
        .then(setStatus)
        .catch(() => {});
    poll();
    const h = setInterval(poll, 3000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* private mode */
    }
  }, [layout]);

  const dirty = useMemo(() => !!info && !!cfg && JSON.stringify(info.config) !== JSON.stringify(cfg), [info, cfg]);
  if (!can.admin(auth?.user)) return <div className="loading">Only administrators set up the outputs.</div>;
  if (!info || !cfg) return <div className="loading">Loading outputs…</div>;

  const locations = cfg.locations?.length ? cfg.locations : [{ id: 'main', name: 'Main' }];
  const chIndex = Math.max(0, cfg.channels.findIndex((c) => c.id === current));
  const ch = cfg.channels[chIndex];
  const saved = info.config.channels.find((c) => c.id === ch?.id);

  const edit = (fn: (c: ServerConfig) => void) => {
    const next = structuredClone(cfg);
    fn(next);
    setCfg(next);
  };
  const editCh = (fn: (c: ChannelConfig, all: ServerConfig) => void) => edit((c) => fn(c.channels[chIndex], c));

  // ---- graph ----
  const pics = ch ? pictures(ch) : [];
  const allDests = pics.flatMap(dests);
  const pos: Record<string, { x: number; y: number }> = {};
  allDests.forEach((d, i) => (pos[d.value.id] = { x: COL.dest, y: 50 + i * 128 }));
  pics.forEach((p, i) => {
    const ys = allDests.filter((d) => d.picture === p.id).map((d) => pos[d.value.id].y);
    pos[`pic:${p.id}`] = { x: COL.picture, y: ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 50 + i * 170 };
  });
  const picYs = pics.map((p) => pos[`pic:${p.id}`].y);
  pos.program = { x: COL.program, y: picYs.length ? (Math.min(...picYs) + Math.max(...picYs)) / 2 : 50 };
  const own = (ch && layout[ch.id]) ?? {};
  for (const k of Object.keys(pos)) if (own[k]) pos[k] = own[k];

  const savedDest = (id: string) => !!saved && pictures(saved).some((p) => dests(p).some((d) => d.value.id === id));
  const destStatus = (d: Dest): { tone: 'ok' | 'warn' | 'idle'; text: string } => {
    if (d.kind === 'html5') return { tone: 'ok', text: 'Web link' };
    if (!savedDest(d.value.id)) return { tone: 'idle', text: 'Not applied yet' };
    const s = status[ch.id]?.[d.value.id];
    if (!s) return { tone: 'idle', text: 'Starting…' };
    return s.ok ? { tone: 'ok', text: s.message || 'Running' } : { tone: 'warn', text: s.message };
  };
  const projectName = (id?: string | null) => projects.find((p) => p.id === id)?.name;
  const liveCh = live.find((c) => c.id === ch?.id);

  type GNode = { id: string; kind: Kind; title: string; sub: string; tone: 'ok' | 'warn' | 'idle'; status: string };
  const nodes: GNode[] = ch
    ? [
        {
          id: 'program',
          kind: 'program',
          title: ch.name,
          sub: `${formatLabel(ch)}\n${projectName(liveCh?.projectId) ? `plays “${projectName(liveCh?.projectId)}”` : 'no project loaded'}`,
          tone: liveCh ? 'ok' : 'idle',
          status: liveCh ? 'Running' : 'Not applied yet',
        },
        ...pics.map((p) => ({ id: `pic:${p.id}`, kind: 'picture' as const, title: p.name, sub: `${p.width}×${p.height}`, tone: 'ok' as const, status: `${dests(p).length} destination${dests(p).length === 1 ? '' : 's'}` })),
        ...allDests.map((d) => {
          const st = destStatus(d);
          return { id: d.value.id, kind: d.kind, title: destTitle(d), sub: destSub(d, ch), tone: st.tone, status: st.text };
        }),
      ]
    : [];
  const edges = ch
    ? [
        ...pics.map((p) => ({ from: 'program', to: `pic:${p.id}`, color: KIND.picture.color })),
        ...allDests.map((d) => ({ from: `pic:${d.picture}`, to: d.value.id, color: KIND[d.kind].color })),
      ]
    : [];
  const width = Math.max(980, ...Object.values(pos).map((p) => p.x + NODE_W + 60));
  const height = Math.max(560, ...Object.values(pos).map((p) => p.y + 160));

  // ---- actions ----
  const selDest = allDests.find((d) => d.value.id === sel);
  const selPic = sel.startsWith('pic:') ? pics.find((p) => `pic:${p.id}` === sel) : undefined;
  const targetPicture = selPic?.id ?? selDest?.picture ?? 'main';
  const takenIds = () => new Set(pics.flatMap((p) => dests(p).map((d) => d.value.id)));

  const addDest = (kind: DestKind, picture = targetPicture, at?: { x: number; y: number }) => {
    const taken = takenIds();
    let k = 1;
    while (taken.has(`${kind}-${k}`)) k++;
    const id = `${kind}-${k}`;
    const n = allDests.filter((d) => d.kind === kind).length + 1;
    editCh((c, all) => {
      const p = pictures(c).find((x) => x.id === picture) ?? pictures(c)[0];
      const picOutputs = p.id === 'main' ? c.outputs : c.renditions!.find((r) => r.id === p.id)!.outputs;
      const group = 100 + chIndex;
      if (kind === 'st2110') {
        const used = new Set(all.channels.flatMap((x) => pictures(x).flatMap((pp) => pp.outputs.st2110.flatMap((o) => [o.fill, o.key ?? '']))));
        let k = n;
        while (used.has(`239.${group}.${k}.1:5004`)) k++;
        picOutputs.st2110.push({ id, name: `ST 2110 ${n}`, encoding: 'fillKey', fill: `239.${group}.${k}.1:5004`, key: `239.${group}.${k}.2:5004`, interface: null, ttl: 32, payloadType: 96 });
      } else if (kind === 'sdi') {
        picOutputs.sdi.push({ id, name: `SDI ${n}`, device: allDests.filter((d) => d.kind === 'sdi').length, externalKey: true, fillOnly: false, genlock: false });
      } else if (kind === 'ndi') {
        const names = new Set(all.channels.flatMap((x) => pictures(x).flatMap((pp) => (pp.outputs.ndi ?? []).map((o) => o.name.toLowerCase()))));
        let name = `${c.name}${p.id === 'main' ? '' : ` ${p.name}`}`;
        for (let k = 2; names.has(name.toLowerCase()); k++) name = `${c.name}${p.id === 'main' ? '' : ` ${p.name}`} ${k}`;
        (picOutputs.ndi ??= []).push({ id, name, groups: '', alpha: true });
      } else {
        (picOutputs.html5 ??= []).push({ id, name: 'Web page', background: '' });
      }
    });
    if (at) setLayout((l) => ({ ...l, [ch.id]: { ...(l[ch.id] ?? {}), [id]: at } }));
    setSel(id);
  };

  const addPicture = () => {
    const taken = new Set(pics.map((p) => p.id));
    const preset = PICTURE_PRESETS.find((p) => !taken.has(p.id)) ?? PICTURE_PRESETS[0];
    const id = unique(preset.id, taken);
    editCh((c) => void (c.renditions ??= []).push({ id, name: preset.name, width: preset.width, height: preset.height, outputs: { st2110: [], sdi: [], ndi: [], html5: [] } }));
    setSel(`pic:${id}`);
  };

  const removeSelected = () => {
    if (selDest) {
      editCh((c) => {
        const p = pictures(c).find((x) => x.id === selDest.picture)!;
        const list = listOf(p.outputs, selDest.kind) as { id: string }[];
        list.splice(
          list.findIndex((x) => x.id === selDest.value.id),
          1,
        );
      });
    } else if (selPic && selPic.id !== 'main') {
      if (dests(selPic).length && !confirm(`Remove the picture “${selPic.name}” and its ${dests(selPic).length} destinations?`)) return;
      editCh((c) => void (c.renditions = (c.renditions ?? []).filter((r) => r.id !== selPic.id)));
    }
    setSel('program');
  };

  /** Feeds a destination from another picture. */
  const moveDest = (destId: string, to: string) =>
    editCh((c) => {
      const d = pictures(c).flatMap(dests).find((x) => x.value.id === destId);
      if (!d || d.picture === to) return;
      const from = pictures(c).find((x) => x.id === d.picture)!;
      const target = pictures(c).find((x) => x.id === to);
      if (!target) return;
      const list = listOf(from.outputs, d.kind) as { id: string }[];
      const [item] = list.splice(
        list.findIndex((x) => x.id === destId),
        1,
      );
      (listOf(target.outputs, d.kind) as { id: string }[]).push(item);
    });

  const editDest = <T,>(fn: (d: T) => void) =>
    editCh((c) => {
      if (!selDest) return;
      const p = pictures(c).find((x) => x.id === selDest.picture)!;
      const item = (listOf(p.outputs, selDest.kind) as { id: string }[]).find((x) => x.id === selDest.value.id);
      if (item) fn(item as T);
    });

  const addLocation = () => {
    const name = prompt('Location name (a studio, a truck, the web desk…)')?.trim();
    if (!name) return;
    edit((c) => {
      c.locations = c.locations?.length ? c.locations : [...locations];
      c.locations.push({ id: unique(slug(name), new Set(c.locations.map((l) => l.id))), name });
    });
  };
  const renameLocation = (id: string, old: string) => {
    const name = prompt('Rename the location', old)?.trim();
    if (!name || name === old) return;
    edit((c) => {
      c.locations = c.locations?.length ? c.locations : [...locations];
      c.locations.find((l) => l.id === id)!.name = name;
    });
  };
  const removeLocation = (id: string, name: string) => {
    if (locations.length < 2) return toast('Keep at least one location', 'error');
    const n = cfg.channels.filter((c) => c.location === id).length;
    if (!confirm(`Remove the location “${name}”?${n ? ` Its ${n} channel${n > 1 ? 's move' : ' moves'} to “${locations.find((l) => l.id !== id)!.name}”.` : ''}`)) return;
    edit((c) => {
      c.locations = (c.locations?.length ? c.locations : [...locations]).filter((l) => l.id !== id);
      for (const x of c.channels) if (x.location === id) x.location = c.locations[0].id;
    });
  };
  const addChannel = (loc: string) => {
    const ids = new Set(cfg.channels.map((c) => c.id));
    let n = cfg.channels.length + 1;
    while (ids.has(`channel-${n}`)) n++;
    const first = cfg.channels[0];
    const id = `channel-${n}`;
    edit((c) => {
      c.locations = c.locations?.length ? c.locations : [...locations];
      c.channels.push({ id, name: `Channel ${n}`, width: first?.width ?? 1920, height: first?.height ?? 1080, frameRate: first?.frameRate ?? { num: 50, den: 1 }, projectId: null, location: loc, outputs: { st2110: [], sdi: [], ndi: [], html5: [{ id: 'html5-1', name: 'Web page', background: '' }] }, renditions: [] });
    });
    setCurrent(id);
    setSel('program');
  };
  const removeChannel = () => {
    if (cfg.channels.length < 2) return;
    if (!confirm(`Remove the channel “${ch.name}” and all its outputs?`)) return;
    edit((c) => void c.channels.splice(chIndex, 1));
    setCurrent(null);
    setSel('program');
  };

  const apply = async () => {
    setSaving(true);
    try {
      await api('PUT', '/api/system/config', cfg);
      toast('Outputs applied — the engine is restarting', 'info');
      setTimeout(() => load().catch(() => {}), 1500);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    } catch {
      toast(text);
    }
  };

  // ---- drag ----
  const grab = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setSel(id);
    const start = { mx: e.clientX, my: e.clientY, ...pos[id] };
    const chId = ch.id;
    const move = (ev: PointerEvent) =>
      setLayout((l) => ({ ...l, [chId]: { ...(l[chId] ?? {}), [id]: { x: Math.max(0, Math.round(start.x + ev.clientX - start.mx)), y: Math.max(30, Math.round(start.y + ev.clientY - start.my)) } } }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- wiring with the mouse ----
  // From a picture's output: drop on a destination to feed it, or in the
  // void to create one there. From a destination's input: drop on another
  // picture to feed it from there.
  const planePoint = (ev: { clientX: number; clientY: number }) => {
    const r = planeRef.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const startWire = (e: React.PointerEvent, from: string, moving?: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setAddMenu(null);
    setWire({ from, moving, ...planePoint(e) });
    const move = (ev: PointerEvent) => setWire((w) => w && { ...w, ...planePoint(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWire(null);
      const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node]')?.dataset.node;
      const targetPic = target?.startsWith('pic:') ? target.slice(4) : undefined;
      if (moving) {
        if (targetPic) moveDest(moving, targetPic);
        return;
      }
      if (target && !target.startsWith('pic:') && target !== 'program') moveDest(target, from);
      else if (!target) {
        const at = planePoint(ev);
        setAddMenu({ picture: from, x: at.x, y: at.y });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const selNode = nodes.find((n) => n.id === sel) ?? nodes[0];
  const destCount = (c: ChannelConfig) => pictures(c).reduce((n, p) => n + dests(p).length, 0);
  const warns = (c: ChannelConfig) => Object.values(status[c.id] ?? {}).some((s) => !s.ok);

  return (
    <div className="outputs-page">
      <aside className="lib-nav">
        <div className="lib-nav-section">
          <span className="grow">Locations</span>
          <button className="icon-btn ghost" title="Add a location" onClick={addLocation}>
            <Plus size={14} />
          </button>
        </div>
        {locations.map((l) => {
          const list = cfg.channels.filter((c) => (c.location || locations[0].id) === l.id);
          return (
            <div key={l.id} className="oc-location">
              <div className="oc-loc-head">
                <MapPin size={14} />
                <span className="grow" onDoubleClick={() => renameLocation(l.id, l.name)} title="Double-click to rename">
                  {l.name}
                </span>
                <span className="lib-nav-actions">
                  <button className="icon-btn ghost" title="Rename" onClick={() => renameLocation(l.id, l.name)}>
                    <Pencil size={12} />
                  </button>
                  <button className="icon-btn ghost" title="Remove the location" onClick={() => removeLocation(l.id, l.name)}>
                    <Trash2 size={12} />
                  </button>
                </span>
                <span className="count">{list.length}</span>
              </div>
              {list.map((c) => (
                <button
                  key={c.id}
                  className={`oc-channel ${c.id === ch?.id ? 'on' : ''}`}
                  onClick={() => {
                    setCurrent(c.id);
                    setSel('program');
                  }}
                >
                  <span className={`oc-dot ${warns(c) ? 'warn' : 'ok'}`} />
                  <span className="grow">
                    <span>{c.name}</span>
                    <small>
                      {formatLabel(c)} · {destCount(c)} destination{destCount(c) === 1 ? '' : 's'}
                    </small>
                  </span>
                </button>
              ))}
              <button className="oc-channel add" onClick={() => addChannel(l.id)}>
                <Plus size={13} /> Add a channel
              </button>
            </div>
          );
        })}
        <p className="lib-nav-hint">A location groups the channels of one place: a studio, a truck, the web desk… Each channel is an independent playout.</p>
      </aside>

      {ch && (
        <main className="oc-main">
          <header className="oc-head">
            <div>
              <div className="row">
                <h1>{ch.name}</h1>
                <span className="chip">{locations.find((l) => l.id === (ch.location || locations[0].id))?.name}</span>
              </div>
              <span className="muted small">
                {formatLabel(ch)} · {projectName(liveCh?.projectId) ? `plays “${projectName(liveCh?.projectId)}”` : 'no project loaded'} · {allDests.length} destinations
              </span>
            </div>
            <div className="spacer" />
            <div className="oc-tools">
              <button className="oc-tool" onClick={addPicture} title="Add a picture (another size or ratio of the same program)">
                <ImageIcon size={15} color={KIND.picture.color} /> Picture
              </button>
              {(['html5', 'sdi', 'st2110', 'ndi'] as DestKind[]).map((k) => {
                const Icon = KIND[k].icon;
                return (
                  <button key={k} className="oc-tool" onClick={() => addDest(k)} title={`Add a ${KIND[k].label} destination to “${pics.find((p) => p.id === targetPicture)?.name}”`}>
                    <Icon size={15} color={KIND[k].color} /> {KIND[k].label}
                  </button>
                );
              })}
            </div>
          </header>

          <div className="oc-body">
            <div className="oc-canvas">
              <div ref={planeRef} className={`oc-plane ${wire ? (wire.moving ? 'wiring-in' : 'wiring-out') : ''}`} style={{ width, height }} onPointerDown={() => setAddMenu(null)}>
                <span className="oc-col" style={{ left: COL.program }}>
                  Source
                </span>
                <span className="oc-col" style={{ left: COL.picture }}>
                  Pictures
                </span>
                <span className="oc-col" style={{ left: COL.dest }}>
                  Destinations
                </span>
                <svg className="oc-wires" width={width} height={height} aria-hidden="true">
                  {edges.map((e) => {
                    const a = pos[e.from];
                    const b = pos[e.to];
                    if (!a || !b || e.to === wire?.moving) return null;
                    const x1 = a.x + NODE_W;
                    const y1 = a.y + 27;
                    const x2 = b.x;
                    const y2 = b.y + 27;
                    const c = Math.max(40, (x2 - x1) / 2);
                    return <path key={`${e.from}-${e.to}`} d={`M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`} stroke={e.color} />;
                  })}
                  {wire &&
                    pos[`pic:${wire.from}`] &&
                    (() => {
                      const a = pos[`pic:${wire.from}`];
                      const x1 = a.x + NODE_W;
                      const y1 = a.y + 27;
                      const c = Math.max(40, Math.abs(wire.x - x1) / 2);
                      return <path className="oc-wire-live" d={`M${x1},${y1} C${x1 + c},${y1} ${wire.x - c},${wire.y} ${wire.x},${wire.y}`} stroke={KIND.picture.color} />;
                    })()}
                </svg>
                {nodes.map((n) => {
                  const k = KIND[n.kind];
                  const Icon = k.icon;
                  return (
                    <div key={n.id} data-node={n.id} className={`oc-node ${n.kind} ${n.id === selNode?.id ? 'sel' : ''}`} style={{ left: pos[n.id].x, top: pos[n.id].y, ['--k' as string]: k.color }} onPointerDown={(e) => grab(e, n.id)}>
                      <div className="oc-node-head">
                        <span className="oc-icon">
                          <Icon size={15} />
                        </span>
                        <span className="grow">
                          <small>{k.label}</small>
                          <strong>{n.title}</strong>
                        </span>
                      </div>
                      <div className="oc-node-sub">{n.sub}</div>
                      <div className="oc-node-status" title={n.status}>
                        <span className={`oc-dot ${n.tone}`} />
                        <span>{n.status}</span>
                      </div>
                      {n.kind === 'picture' && <span className="oc-port in" />}
                      {n.kind !== 'program' && n.kind !== 'picture' && (
                        <span className="oc-port in grab" title="Drag to another picture to feed this output from it" onPointerDown={(e) => startWire(e, allDests.find((d) => d.value.id === n.id)!.picture, n.id)} />
                      )}
                      {n.kind === 'program' && <span className="oc-port out" />}
                      {n.kind === 'picture' && <span className="oc-port out grab" title="Drag to an output to feed it, or into the empty canvas to add one" onPointerDown={(e) => startWire(e, n.id.slice(4))} />}
                    </div>
                  );
                })}
                {addMenu && (
                  <div className="menu oc-add-menu" style={{ left: addMenu.x, top: addMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
                    <div className="menu-label">Add an output</div>
                    {(['html5', 'sdi', 'st2110', 'ndi'] as DestKind[]).map((k) => {
                      const Icon = KIND[k].icon;
                      return (
                        <button
                          key={k}
                          onClick={() => {
                            addDest(k, addMenu.picture, { x: Math.max(0, Math.round(addMenu.x)), y: Math.max(30, Math.round(addMenu.y - 27)) });
                            setAddMenu(null);
                          }}
                        >
                          <Icon size={14} color={KIND[k].color} /> {KIND[k].label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <aside className="oc-inspector">
              {selNode && (
                <div className="oc-ins-head" style={{ ['--k' as string]: KIND[selNode.kind].color }}>
                  <span className="oc-swatch" />
                  <div className="grow">
                    <small>{KIND[selNode.kind].label}</small>
                    <strong>{selNode.title}</strong>
                  </div>
                  {(selDest || (selPic && selPic.id !== 'main')) && (
                    <button className="icon-btn ghost" title="Remove" onClick={removeSelected}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              )}

              {selNode?.kind === 'program' && (
                <>
                  <Field label="Name">
                    <input value={ch.name} onChange={(e) => editCh((c) => void (c.name = e.target.value))} />
                  </Field>
                  <Field label="Location">
                    <select value={ch.location || locations[0].id} onChange={(e) => edit((c) => void ((c.locations = c.locations?.length ? c.locations : [...locations]), (c.channels[chIndex].location = e.target.value)))}>
                      {locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Video format" hint="Every picture and destination of the channel runs at this rate.">
                    <select
                      value={VIDEO_FORMATS.findIndex((f) => f.width === ch.width && f.height === ch.height && f.rate.num * ch.frameRate.den === ch.frameRate.num * f.rate.den)}
                      onChange={(e) =>
                        editCh((c) => {
                          const f = VIDEO_FORMATS[+e.target.value];
                          if (!f) return;
                          c.width = f.width;
                          c.height = f.height;
                          c.frameRate = f.rate;
                        })
                      }
                    >
                      <option value={-1} disabled>
                        {formatLabel(ch)}
                      </option>
                      {VIDEO_FORMATS.map((f, i) => (
                        <option key={f.label} value={i}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {liveCh && (
                    <Field label="Project on air" hint="Takes effect at once (not with Apply).">
                      <select
                        value={liveCh.projectId ?? ''}
                        onChange={async (e) => {
                          const onAir = Object.keys(liveState[ch.id]?.state.layers ?? {}).length;
                          if (onAir && !confirm('Loading another project clears the graphics on air. Continue?')) return;
                          await loadOnChannel(ch.id, e.target.value || null);
                        }}
                      >
                        <option value="">— no project —</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <Hint>The playout of this channel: what the operator takes goes to every picture and destination wired to it.</Hint>
                  {cfg.channels.length > 1 && (
                    <button className="btn small danger" onClick={removeChannel}>
                      <Trash2 size={13} /> Remove the channel
                    </button>
                  )}
                </>
              )}

              {selPic && (
                <>
                  {selPic.id === 'main' ? (
                    <Hint>
                      The channel's main picture, {selPic.width}×{selPic.height} (its video format).
                    </Hint>
                  ) : (
                    <>
                      <Field label="Name">
                        <input value={selPic.name} onChange={(e) => editCh((c) => void (c.renditions!.find((r) => r.id === selPic.id)!.name = e.target.value))} />
                      </Field>
                      <Field label="Size">
                        <select
                          value={PICTURE_PRESETS.findIndex((p) => p.width === selPic.width && p.height === selPic.height)}
                          onChange={(e) =>
                            editCh((c) => {
                              const p = PICTURE_PRESETS[+e.target.value];
                              const r = c.renditions!.find((x) => x.id === selPic.id)!;
                              if (p) Object.assign(r, { width: p.width, height: p.height });
                            })
                          }
                        >
                          <option value={-1}>Custom</option>
                          {PICTURE_PRESETS.map((p, i) => (
                            <option key={p.id} value={i}>
                              {p.name} · {p.width}×{p.height}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="oc-pair">
                        <Field label="Width">
                          <input type="number" min={16} max={7680} value={selPic.width} onChange={(e) => editCh((c) => void (c.renditions!.find((x) => x.id === selPic.id)!.width = +e.target.value))} />
                        </Field>
                        <Field label="Height">
                          <input type="number" min={16} max={7680} value={selPic.height} onChange={(e) => editCh((c) => void (c.renditions!.find((x) => x.id === selPic.id)!.height = +e.target.value))} />
                        </Field>
                      </div>
                    </>
                  )}
                  <Hint>One take drives every picture. Each one uses the project format closest in aspect ratio (a template's 9:16 layout, if it has one), letterboxed to fit.</Hint>
                </>
              )}

              {selDest?.kind === 'html5' &&
                (() => {
                  const o = selDest.value as Html5Output;
                  const url = outputUrl(ch.id, selDest.picture, o.background);
                  return (
                    <>
                      <Field label="Name">
                        <input value={o.name} onChange={(e) => editDest<Html5Output>((d) => void (d.name = e.target.value))} />
                      </Field>
                      <Field label="Background">
                        <select value={o.background} onChange={(e) => editDest<Html5Output>((d) => void (d.background = e.target.value))}>
                          {BACKGROUNDS.map((b) => (
                            <option key={b.value} value={b.value}>
                              {b.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="set-field">
                        <span className="set-label">Web link</span>
                        <div className="oc-link">
                          <code>{url}</code>
                          <button className="icon-btn" title="Copy" onClick={() => void copy(url)}>
                            {copied === url ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                          <a className="icon-btn" title="Open" href={url} target="_blank" rel="noreferrer">
                            <ExternalLink size={14} />
                          </a>
                        </div>
                      </div>
                      <Hint>{cfg.publicOutputs ? 'A web page playing the graphics live: browser source in OBS, vMix, CasparCG, a web player or a screen. No login needed.' : 'A web page playing the graphics live. Output pages need a login (Settings › Public output pages).'}</Hint>
                    </>
                  );
                })()}

              {selDest?.kind === 'sdi' &&
                (() => {
                  const o = selDest.value as SdiOutput;
                  const signal = o.fillOnly ? 'fill' : o.externalKey ? 'external' : 'internal';
                  return (
                    <>
                      <Field label="Name">
                        <input value={o.name} onChange={(e) => editDest<SdiOutput>((d) => void (d.name = e.target.value))} />
                      </Field>
                      <Field label="DeckLink device" hint="Index as listed by Blackmagic Desktop Video (0 = first).">
                        <input type="number" min={0} value={o.device} onChange={(e) => editDest<SdiOutput>((d) => void (d.device = Math.max(0, +e.target.value)))} />
                      </Field>
                      <Field label="Signal">
                        <select value={signal} onChange={(e) => editDest<SdiOutput>((d) => void ((d.fillOnly = e.target.value === 'fill'), (d.externalKey = e.target.value !== 'internal')))}>
                          <option value="external">Fill + Key (external keyer, 2 SDI)</option>
                          <option value="internal">Internal keyer (over the card's SDI input)</option>
                          <option value="fill">Fill only</option>
                        </select>
                      </Field>
                      <label className="check">
                        <input type="checkbox" checked={!!o.genlock} onChange={(e) => editDest<SdiOutput>((d) => void (d.genlock = e.target.checked))} />
                        Genlock to the card's reference input
                      </label>
                      <Hint>Needs Blackmagic Desktop Video on this server. The status shows whether the card answered.</Hint>
                    </>
                  );
                })()}

              {selDest?.kind === 'st2110' &&
                (() => {
                  const o = selDest.value as St2110Output;
                  const enc = o.encoding ?? 'fillKey';
                  const two = enc === 'fillKey';
                  const [fip, fport] = splitAddr(o.fill);
                  const [kip, kport] = splitAddr(o.key);
                  const sdp = (k: 'fill' | 'key') => `/api/channels/${encodeURIComponent(ch.id)}/outputs/${encodeURIComponent(o.id)}/${k}.sdp`;
                  return (
                    <>
                      <Field label="Name">
                        <input value={o.name} onChange={(e) => editDest<St2110Output>((d) => void (d.name = e.target.value))} />
                      </Field>
                      <Field label="Encoding">
                        <select value={enc} onChange={(e) => editDest<St2110Output>((d) => void ((d.encoding = e.target.value as St2110Output['encoding']), e.target.value === 'fillKey' && !d.key && (d.key = joinAddr(fip.replace(/\d+$/, (x) => String(+x + 1)), fport))))}>
                          {ENCODINGS.map((x) => (
                            <option key={x.value} value={x.value}>
                              {x.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Network interface">
                        <select value={o.interface ?? ''} onChange={(e) => editDest<St2110Output>((d) => void (d.interface = e.target.value || null))}>
                          <option value="">System default</option>
                          {info.interfaces.map((n) => (
                            <option key={n.ip} value={n.ip}>
                              {n.name} — {n.ip}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="oc-pair">
                        <Field label={two ? 'Fill — IP' : 'Stream — IP'}>
                          <input value={fip} placeholder="239.100.1.1" onChange={(e) => editDest<St2110Output>((d) => void (d.fill = joinAddr(e.target.value, fport)))} />
                        </Field>
                        <Field label="Port">
                          <input type="number" value={fport} onChange={(e) => editDest<St2110Output>((d) => void (d.fill = joinAddr(fip, e.target.value)))} />
                        </Field>
                      </div>
                      {two && (
                        <>
                          <label className="check">
                            <input type="checkbox" checked={!!o.key} onChange={(e) => editDest<St2110Output>((d) => void (d.key = e.target.checked ? joinAddr(fip.replace(/\d+$/, (x) => String(+x + 1)), fport) : null))} />
                            Send the key stream
                          </label>
                          {o.key && (
                            <div className="oc-pair">
                              <Field label="Key — IP">
                                <input value={kip} onChange={(e) => editDest<St2110Output>((d) => void (d.key = joinAddr(e.target.value, kport)))} />
                              </Field>
                              <Field label="Port">
                                <input type="number" value={kport} onChange={(e) => editDest<St2110Output>((d) => void (d.key = joinAddr(kip, e.target.value)))} />
                              </Field>
                            </div>
                          )}
                        </>
                      )}
                      <div className="oc-pair">
                        <Field label="TTL">
                          <input type="number" min={1} max={255} value={o.ttl} onChange={(e) => editDest<St2110Output>((d) => void (d.ttl = +e.target.value))} />
                        </Field>
                        <Field label="Payload type">
                          <input type="number" min={96} max={127} value={o.payloadType} onChange={(e) => editDest<St2110Output>((d) => void (d.payloadType = +e.target.value))} />
                        </Field>
                      </div>
                      <div className="set-field">
                        <span className="set-label">SDP</span>
                        {savedDest(o.id) ? (
                          <span className="oc-sdp">
                            <a href={sdp('fill')}>{two ? 'fill.sdp' : `${enc}.sdp`}</a>
                            {two && o.key && <a href={sdp('key')}>key.sdp</a>}
                          </span>
                        ) : (
                          <span className="muted small">Apply to generate the SDP files.</span>
                        )}
                      </div>
                      <Hint>{two ? 'Two ST 2110-20 streams, what most vision mixers and keyers expect. RTP timing follows the system clock: keep this server PTP-disciplined.' : 'One stream carrying the alpha, for receivers that read this sampling (check your mixer accepts it). RTP timing follows the system clock: keep this server PTP-disciplined.'}</Hint>
                    </>
                  );
                })()}

              {selDest?.kind === 'ndi' &&
                (() => {
                  const o = selDest.value as NdiOutput;
                  return (
                    <>
                      <Field label="Source name" hint="Receivers see it as “SERVER (name)”.">
                        <input value={o.name} onChange={(e) => editDest<NdiOutput>((d) => void (d.name = e.target.value))} />
                      </Field>
                      <Field label="Groups" hint="Comma-separated; empty = public.">
                        <input value={o.groups} placeholder="public" onChange={(e) => editDest<NdiOutput>((d) => void (d.groups = e.target.value))} />
                      </Field>
                      <label className="check">
                        <input type="checkbox" checked={o.alpha} onChange={(e) => editDest<NdiOutput>((d) => void (d.alpha = e.target.checked))} />
                        Send the alpha channel
                      </label>
                      <Field label="NDI runtime (all NDI outputs)" hint="Leave empty to use the NDI runtime installed with Pulse CG. Only to force another libndi.">
                        <input value={cfg.ndiLibrary ?? ''} placeholder={info.os === 'macos' ? '/usr/local/lib/libndi.dylib' : info.os === 'windows' ? 'C:\\Program Files\\NDI\\…\\Processing.NDI.Lib.x64.dll' : '/usr/lib/libndi.so.6'} onChange={(e) => edit((c) => void (c.ndiLibrary = e.target.value))} />
                      </Field>
                      <Hint>Seen by every NDI receiver on the network (TriCaster, vMix, OBS, Studio Monitor…). The NDI runtime comes with the Pulse CG installers (macOS, Windows).</Hint>
                    </>
                  );
                })()}

              {selDest && selDest.kind !== 'html5' && (
                <div className={`oc-state ${destStatus(selDest).tone}`}>
                  <span className={`oc-dot ${destStatus(selDest).tone}`} />
                  {destStatus(selDest).text}
                </div>
              )}
              {selDest && status[ch.id]?.[selDest.value.id]?.detail && status[ch.id][selDest.value.id].detail !== destStatus(selDest).text && (
                <details className="oc-detail">
                  <summary>Details</summary>
                  <code>{status[ch.id][selDest.value.id].detail}</code>
                </details>
              )}
            </aside>
          </div>
        </main>
      )}

      <div className={`save-bar ${dirty ? 'show' : ''}`}>
        <span>Unapplied output changes. Applying restarts the outputs of every channel.</span>
        <div className="spacer" />
        <button className="btn" onClick={() => setCfg(structuredClone(info.config))}>
          Discard
        </button>
        <button className="btn primary" disabled={saving} onClick={apply}>
          <Save size={14} /> {saving ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  );
}

function destTitle(d: Dest): string {
  switch (d.kind) {
    case 'html5':
      return (d.value as Html5Output).name || 'Web page';
    case 'st2110':
      return d.value.name;
    default:
      return d.value.name;
  }
}

function destSub(d: Dest, ch: ChannelConfig): string {
  switch (d.kind) {
    case 'html5': {
      const o = d.value as Html5Output;
      return `/output/${ch.id}${d.picture === 'main' ? '' : `/${d.picture}`}\n${BACKGROUNDS.find((b) => b.value === o.background)?.label ?? o.background}`;
    }
    case 'sdi': {
      const o = d.value as SdiOutput;
      return `DeckLink #${o.device}\n${o.fillOnly ? 'Fill only' : o.externalKey ? 'Fill + Key' : 'Internal keyer'}${o.genlock ? ' · genlock' : ''}`;
    }
    case 'st2110': {
      const o = d.value as St2110Output;
      const enc = o.encoding ?? 'fillKey';
      return enc === 'fillKey' ? `${o.fill}${o.key ? `\nkey ${o.key}` : '\nno key'}` : `${enc === 'rgba' ? 'RGBA' : 'YCbCrA'}\n${o.fill}`;
    }
    case 'ndi': {
      const o = d.value as NdiOutput;
      return `${o.groups || 'public'}\n${o.alpha ? 'with alpha' : 'no alpha'}`;
    }
  }
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

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="oc-hint">{children}</p>;
}
