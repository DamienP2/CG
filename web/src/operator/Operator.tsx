import { ArrowDown, ArrowUp, ChevronsRight, Zap, CircleStop, Copy, MonitorPlay, Pause, Play, Plus, RotateCcw, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Scene } from '../engine/Scene';
import { defaultData, holdFrame, newId, parseHex, toHex } from '../engine/evaluate';
import type { Command, Field, Marker, PlayoutItem, Playlist, Project, RundownItem, Template, WidgetControl, Zone } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { LiveTime } from '../engine/LiveTime';
import { formatFor, inFormat } from '../engine/formats';
import { api, can, uploadAsset, useApp } from '../store';
import { Monitor } from '../ui/Monitor';
import { Program } from '../output/Program';
import { useWheelSteps } from '../ui/fields';
import { useBoundData, useSources } from '../data/dataStore';
import { navigate, projectPath } from '../router';
import { areaClip, zoneArea } from '../engine/zones';
import { confirmDialog, promptDialog } from '../ui/dialogs';

/** Number field: − / + buttons, arrow keys and the mouse wheel once clicked. */
function NumberStepper({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const live = useRef(value);
  live.current = value;
  const bump = (d: number) => {
    const v = +((parseFloat(live.current) || 0) + d).toFixed(3);
    live.current = String(v);
    onChange(String(v));
  };
  useWheelSteps(ref, (steps, e) => bump(steps * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)));
  return (
    <div className="stepper">
      <button className="btn small" onClick={() => bump(-1)}>
        −
      </button>
      <input
        ref={ref}
        value={value}
        title="Click, then use the mouse wheel or trackpad (Shift ×10, Alt ×0.1)"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            bump((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
          }
        }}
      />
      <button className="btn small" onClick={() => bump(1)}>
        +
      </button>
    </div>
  );
}

export function FieldInput({ field, value, onChange }: { field: Field; value: string; onChange: (v: string) => void }) {
  const toast = useApp((s) => s.toast);
  switch (field.kind) {
    case 'multiline':
      return <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />;
    case 'number':
      return <NumberStepper value={value} onChange={onChange} />;
    case 'color':
      return (
        <div className="row">
          <input type="color" value={toHex(parseHex(value) ?? [1, 1, 1, 1])} onChange={(e) => onChange(e.target.value)} />
          <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      );
    case 'image':
      return (
        <div className="row">
          <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="/assets/…" />
          <label className="btn small">
            Upload
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) uploadAsset(f, useApp.getState().projectId).then(onChange, (err) => toast(String(err), 'error'));
              }}
            />
          </label>
        </div>
      );
    default:
      return <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />;
  }
}

/** Rundown sections: tabs to switch, add, rename (double-click) and remove. */
function PlaylistTabs({ project, active, onSelect, editable }: { project: Project; active: string; onSelect: (id: string) => void; editable: boolean }) {
  const toast = useApp((s) => s.toast);
  const save = (lists: Playlist[]) => api('PUT', `/api/projects/${encodeURIComponent(project.id)}/playlists`, lists).catch((e) => toast((e as Error).message, 'error'));
  const count = (id: string) => project.rundown.filter((r) => r.playlist === id).length;
  return (
    <div className="playlist-tabs">
      {project.playlists.map((p) => (
        <button
          key={p.id}
          className={p.id === active ? 'on' : ''}
          onClick={() => onSelect(p.id)}
          onDoubleClick={async () => {
            if (!editable) return;
            const name = await promptDialog({ title: 'Rename the playlist', label: 'Name', value: p.name, confirm: 'Rename' });
            if (name) save(project.playlists.map((x) => (x.id === p.id ? { ...x, name } : x)));
          }}
          title={editable ? 'Double-click to rename' : undefined}
        >
          {p.name} <span className="count">{count(p.id)}</span>
          {editable && project.playlists.length > 1 && p.id === active && (
            <span
              className="tab-x"
              title="Remove the playlist (its items move to the first one)"
              onClick={async (e) => {
                e.stopPropagation();
                if (await confirmDialog({ title: `Remove the playlist “${p.name}”?`, message: `Its ${count(p.id)} item(s) move to “${project.playlists.find((x) => x.id !== p.id)!.name}”.`, confirm: 'Remove', danger: true })) {
                  save(project.playlists.filter((x) => x.id !== p.id));
                  onSelect(project.playlists.find((x) => x.id !== p.id)!.id);
                }
              }}
            >
              <X size={11} />
            </span>
          )}
        </button>
      ))}
      {editable && (
        <button
          className="add"
          title="New playlist"
          onClick={async () => {
            const name = await promptDialog({ title: 'New playlist', label: 'Name', value: `Playlist ${project.playlists.length + 1}`, confirm: 'Create' });
            if (!name) return;
            const id = newId();
            save([...project.playlists, { id, name }]).then(() => onSelect(id));
          }}
        >
          <Plus size={13} />
        </button>
      )}
    </div>
  );
}

function ZoneTag({ zone }: { zone?: Zone }) {
  if (!zone) return <span className="zone-tag">no zone</span>;
  return (
    <span className="zone-tag" style={{ ['--zone' as string]: zone.color }}>
      {zone.name}
    </span>
  );
}

/** Every zone of the project with what it has on air, front-most first. */
function ZoneStrip({ project, layers, cuedZone, command }: { project: Project; layers: Record<string, PlayoutItem>; cuedZone?: string; command: (c: Command) => void }) {
  const zones = [...project.zones].sort((a, b) => b.layer - a.layer);
  const known = new Set(zones.map((z) => String(z.layer)));
  // Graphics taken on raw layers through the API.
  const extra = Object.keys(layers).filter((l) => !known.has(l));
  const name = (id?: string | null) => project.templates.find((t) => t.id === id)?.name ?? id;
  const card = (key: string, label: React.ReactNode, color: string, p: PlayoutItem | undefined, target: { zone?: string; layer?: number }, cued: boolean) => {
    const t = p && project.templates.find((x) => x.id === p.templateId);
    return (
      <div key={key} className={`zone-card ${p ? p.phase : 'empty'} ${p && isPaused(p, project) ? 'paused' : ''} ${cued ? 'cued' : ''}`} style={{ ['--zone' as string]: color }}>
        <div className="zone-head">
          <span className="zone-name">{label}</span>
          {p && <span className="air-phase">{phaseLabel(p, project)}</span>}
        </div>
        <div className="zone-body">
          {p ? <strong>{rundownName(project, p.rundownId) ?? t?.name}</strong> : <span className="muted">Free</span>}
          {p?.next && <span className="zone-next">then {rundownName(project, p.next.rundownId) ?? name(p.next.templateId)}</span>}
          {p && <PauseResume p={p} project={project} onTrigger={(n) => command({ action: 'trigger', name: n })} />}
        </div>
        {p && <progress max={t?.duration ?? 1} value={p.frame} />}
        {p && t && <WidgetControls item={p} template={t} onControl={(id, control) => command({ action: 'widget', target: id, control, ...target })} />}
        <div className="zone-actions">
          <button className="icon-btn ghost" title="Continue" disabled={!p} onClick={() => command({ action: 'continue', ...target })}>
            <ChevronsRight size={13} />
          </button>
          <button className="icon-btn ghost" title="Take out" disabled={!p} onClick={() => command({ action: 'takeOut', ...target })}>
            <CircleStop size={13} />
          </button>
          <button className="icon-btn ghost" title="Clear now (no animation)" disabled={!p} onClick={() => command({ action: 'clear', ...target })}>
            <X size={13} />
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="zone-strip">
      {zones.map((z) => card(z.id, z.name, z.color, layers[String(z.layer)], { zone: z.id }, z.id === cuedZone))}
      {extra.map((l) => card(`l${l}`, `Layer ${l}`, '#6b7090', layers[l], { layer: Number(l) }, false))}
    </div>
  );
}

/** Start / pause / restart the timers, tickers, rolls… of the graphic on air. */
function WidgetControls({ item, template, onControl }: { item: PlayoutItem; template: Template; onControl: (layerId: string, c: WidgetControl) => void }) {
  const timed = template.layers.filter(isTimed);
  if (!timed.length) return null;
  return (
    <div className="widget-controls">
      {timed.map((l) => {
        const c = item.clocks?.[l.id];
        const running = c ? c.pausedAt == null : !l.manualStart;
        return (
          <div key={l.id} className={`wc-row ${running ? 'running' : 'paused'}`}>
            <span className="wc-name" title={l.name}>
              {l.name}
            </span>
            <button className="icon-btn ghost" title={running ? 'Pause' : 'Start'} onClick={() => onControl(l.id, 'toggle')}>
              {running ? <Pause size={12} /> : <Play size={12} />}
            </button>
            <button className="icon-btn ghost" title="Restart from zero" onClick={() => onControl(l.id, running ? 'restart' : 'reset')}>
              <RotateCcw size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const rundownName = (project: Project, id?: string | null) => (id ? project.rundown.find((r) => r.id === id)?.name : undefined);

/** The pause marker the graphic holds on, if it holds on a pause (not on the On air point). */
function pauseOf(p: PlayoutItem, project: Project): Marker | undefined {
  if (p.phase !== 'holding' && p.phase !== 'outHold') return undefined;
  const t = project.templates.find((x) => x.id === p.templateId);
  return t?.markers.find((m) => m.kind === 'pause' && Math.abs(m.frame - p.frame) < 0.5);
}

function isPaused(p: PlayoutItem, project: Project) {
  return !!pauseOf(p, project);
}

function phaseLabel(p: PlayoutItem, project: Project) {
  if (isPaused(p, project)) return p.phase === 'outHold' ? 'OUT · PAUSE' : 'PAUSE';
  return p.phase === 'holding' ? 'ON AIR' : p.phase === 'out' || p.phase === 'outHold' ? 'OUT' : 'PLAYING';
}

/** How the pause the graphic holds on resumes: a trigger to fire, or a delay. */
function PauseResume({ p, project, onTrigger }: { p: PlayoutItem; project: Project; onTrigger: (name: string) => void }) {
  const r = pauseOf(p, project)?.resume;
  if (r?.type === 'trigger')
    return (
      <button className="chip trigger" title="Fire this trigger: every graphic waiting for it plays on" onClick={() => onTrigger(r.name)}>
        <Zap size={11} /> {r.name}
      </button>
    );
  if (r?.type === 'after') return <span className="chip">auto · {r.seconds}s</span>;
  return null;
}

/**
 * The output (channel) the operator takes to. Another project's channel can
 * be taken over after a confirmation; without one, the page still prepares
 * the rundown and previews.
 */
function ChannelBar({ channelId }: { channelId: string | null }) {
  const { channels, projects, project, live, loadOnChannel } = useApp();
  const ch = channels.find((c) => c.id === channelId);
  const projectName = (id?: string | null) => projects.find((p) => p.id === id)?.name ?? 'another project';
  const pick = async (id: string) => {
    if (!project) return;
    if (!id) return navigate(projectPath(project.id, 'operator', 'none'));
    const c = channels.find((x) => x.id === id);
    if (!c) return;
    if (c.projectId !== project.id) {
      const onAir = Object.keys(live[c.id]?.state.layers ?? {}).length;
      if (c.projectId && !(await confirmDialog({ title: `${c.name} is used by “${projectName(c.projectId)}”`, message: `${onAir ? `${onAir} graphics are on air there and will be cleared. ` : ''}Load “${project.name}” on it instead?`, confirm: 'Load here', danger: onAir > 0 }))) return;
      await loadOnChannel(c.id, project.id);
    }
    navigate(projectPath(project.id, 'operator', c.id));
  };
  const own = channels.filter((c) => c.projectId === project?.id);
  const free = channels.filter((c) => !c.projectId);
  const other = channels.filter((c) => c.projectId && c.projectId !== project?.id);
  return (
    <div className="channel-bar">
      <MonitorPlay size={15} />
      <select value={channelId ?? ''} onChange={(e) => void pick(e.target.value)}>
        <option value="">— No output (preview only) —</option>
        {own.length > 0 && (
          <optgroup label="This project">
            {own.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
        {free.length > 0 && (
          <optgroup label="Free">
            {free.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
        {other.length > 0 && (
          <optgroup label="Used by another project">
            {other.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — used by “{projectName(c.projectId)}”
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {ch ? (
        <span className="muted">
          {ch.width}×{ch.height} · {+(ch.frameRate.num / ch.frameRate.den).toFixed(2)} fps
          {ch.outputs.length ? ` · ${ch.outputs.join(', ')}` : ''}
        </span>
      ) : (
        <span className="muted">Choose an output to take graphics on air.</span>
      )}
      <div className="spacer" />
      {ch && (
        <a className="btn small" href={`/output/${encodeURIComponent(ch.id)}`} target="_blank" rel="noreferrer">
          HTML5 output ↗
        </a>
      )}
    </div>
  );
}

export function Operator({ channelId }: { channelId: string | null }) {
  const { project, command: send, saveRundown, auth } = useApp();
  const liveState = useApp((s) => (channelId ? s.live[channelId] : undefined));
  const channel = liveState?.state ?? { layers: {} };
  // Editing the rundown needs the rights; going on air also needs an output.
  const canEdit = can.operate(auth?.user);
  const operate = canEdit && !!channelId;
  const command: typeof send = (cmd) => operate && send(cmd, channelId!);
  const [cued, setCued] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [pictureId, setPictureId] = useState('main');
  const channelInfo = useApp((s) => (channelId ? s.channels.find((c) => c.id === channelId) : undefined));

  const rundown = project?.rundown ?? [];
  const playlists = project?.playlists ?? [];
  const activeList = playlists.find((p) => p.id === playlistId)?.id ?? playlists[0]?.id ?? '';
  // The items of the playlist shown.
  const items = rundown.filter((r) => r.playlist === activeList || !playlists.some((p) => p.id === r.playlist));
  const item = rundown.find((r) => r.id === cued) ?? null;
  const template = item && project?.templates.find((t) => t.id === item.templateId);

  useEffect(() => {
    if ((!cued || !items.some((r) => r.id === cued)) && items.length) setCued(items[0].id);
  }, [cued, activeList, items.length]);

  // Fields bound to data sources show their live value.
  const boundDraft = useBoundData(template, draft);

  // Draft data follows the cued item.
  useEffect(() => {
    if (item && template) setDraft({ ...defaultData(template), ...item.data });
  }, [cued, template?.id]);

  const onAirByItem = useMemo(() => {
    const m = new Map<string, PlayoutItem>();
    for (const p of Object.values(channel.layers)) if (p.rundownId) m.set(p.rundownId, p);
    return m;
  }, [channel]);
  const queued = useMemo(() => new Set(Object.values(channel.layers).flatMap((p) => (p.next?.rundownId ? [p.next.rundownId] : []))), [channel]);

  const sources = useSources();
  const sourceName = (id: string) => sources.find((x) => x.id === id)?.name ?? id;
  const dirty = item ? JSON.stringify({ ...defaultData(template!), ...item.data }) !== JSON.stringify(draft) : false;

  const persistDraft = () => {
    if (!item || !dirty) return;
    saveRundown(rundown.map((r) => (r.id === item.id ? { ...r, data: draft } : r)));
  };

  const take = () => {
    if (!item) return;
    persistDraft();
    command({
      action: 'take',
      zone: zoneOf(item)?.id,
      templateId: item.templateId,
      data: draft,
      rundownId: item.id,
    });
    // Cue the next item of the playlist.
    const idx = items.findIndex((r) => r.id === item.id);
    if (idx >= 0 && idx < items.length - 1) setCued(items[idx + 1].id);
  };
  /** Take / out straight from a rundown row. */
  const takeItem = (r: RundownItem) => {
    if (r.id === item?.id) return take();
    const t = project?.templates.find((x) => x.id === r.templateId);
    command({
      action: 'take',
      zone: zoneOf(r)?.id,
      templateId: r.templateId,
      data: { ...(t ? defaultData(t) : {}), ...r.data },
      rundownId: r.id,
    });
  };
  const outItem = (r: RundownItem) => command({ action: 'takeOut', zone: zoneOf(r)?.id });
  const cont = () => item && command({ action: 'continue', zone: zoneOf(item)?.id });
  const out = () => item && command({ action: 'takeOut', zone: zoneOf(item)?.id });
  const updateLive = () => {
    if (!item) return;
    persistDraft();
    command({ action: 'update', zone: zoneOf(item)?.id, data: draft });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const idx = items.findIndex((r) => r.id === cued);
      if (e.key === 'F1' || e.key === 'Enter') (e.preventDefault(), take());
      else if (e.key === 'F2' || e.key === ' ') (e.preventDefault(), cont());
      else if (e.key === 'F3') (e.preventDefault(), out());
      else if (e.key === 'F12') (e.preventDefault(), command({ action: 'clear' }));
      else if (e.key === 'ArrowDown' && idx < items.length - 1) setCued(items[idx + 1].id);
      else if (e.key === 'ArrowUp' && idx > 0) setCued(items[idx - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!project)
    return (
      <div className="operator empty-op">
        <ChannelBar channelId={channelId} />
        <div className="loading">No project loaded on this channel. Pick one above.</div>
      </div>
    );
  const fps = project.frameRate.num / project.frameRate.den || 1;
  // Pictures of the channel (main + renditions such as 9:16): one take drives all.
  const pictures = [
    {
      id: 'main',
      name: channelInfo ? `${channelInfo.width}×${channelInfo.height}` : 'Main',
      width: channelInfo?.width ?? project.width,
      height: channelInfo?.height ?? project.height,
    },
    ...(channelInfo?.renditions ?? []),
  ];
  const picture = pictures.find((p) => p.id === pictureId) ?? pictures[0];
  const previewFormat = formatFor(project, picture.width, picture.height);

  const addItem = (templateId: string) => {
    const t = project.templates.find((x) => x.id === templateId)!;
    const z = project.zones.find((x) => x.id === t.zone);
    const it: RundownItem = {
      id: newId(),
      name: t.name,
      templateId,
      zone: t.zone,
      playlist: activeList,
      layer: z?.layer ?? 0,
      data: defaultData(t),
    };
    saveRundown([...rundown, it]);
    setCued(it.id);
    setAdding(false);
  };
  /** Moves an item up / down within its playlist. */
  const move = (id: string, d: -1 | 1) => {
    const k = items.findIndex((r) => r.id === id);
    const other = items[k + d];
    if (k < 0 || !other) return;
    const i = rundown.findIndex((r) => r.id === id);
    const j = rundown.findIndex((r) => r.id === other.id);
    const next = [...rundown];
    [next[i], next[j]] = [next[j], next[i]];
    saveRundown(next);
  };

  const zoneOf = (r: RundownItem) => project.zones.find((z) => z.id === r.zone) ?? project.zones.find((z) => z.id === project.templates.find((t) => t.id === r.templateId)?.zone);
  const itemZone = item ? zoneOf(item) : undefined;
  const live = itemZone ? channel.layers[String(itemZone.layer)] : undefined;
  const liveIsThis = live?.rundownId === item?.id;

  return (
    <div className="operator">
      <aside className="panel left rundown">
        <header className="panel-header">
          <span>Rundown</span>
          <button className="icon-btn ghost" title="Add an item" onClick={() => setAdding(!adding)}>
            <Plus size={15} />
          </button>
        </header>
        {adding && (
          <div className="add-menu">
            {project.templates.map((t) => (
              <button key={t.id} onClick={() => addItem(t.id)}>
                {t.name}
              </button>
            ))}
          </div>
        )}
        <PlaylistTabs project={project} active={activeList} onSelect={setPlaylistId} editable={canEdit} />
        <div className="rundown-list">
          {items.map((r, i) => {
            const t = project.templates.find((x) => x.id === r.templateId);
            const air = onAirByItem.get(r.id);
            return (
              <div key={r.id} className={`rundown-item ${cued === r.id ? 'cued' : ''} ${air ? 'on-air' : ''}`} onClick={() => setCued(r.id)}>
                <span className="idx">{i + 1}</span>
                <div className="ri-main">
                  <span className="ri-name">{r.name}</span>
                  <span className="ri-meta">
                    <ZoneTag zone={zoneOf(r)} /> {t?.name ?? 'missing template'}
                  </span>
                </div>
                {air && <span className={`tally ${isPaused(air, project) ? 'paused' : ''}`}>{phaseLabel(air, project)}</span>}
                {!air && queued.has(r.id) && <span className="tally next">NEXT</span>}
                {operate && (
                  <div className="ri-play" onClick={(e) => e.stopPropagation()}>
                    <button className="ri-take" title="Take" onClick={() => takeItem(r)}>
                      <Play size={13} />
                    </button>
                    <button className="ri-out" title="Out" disabled={!air} onClick={() => outItem(r)}>
                      <CircleStop size={13} />
                    </button>
                  </div>
                )}
                <div className="item-actions">
                  <button className="icon-btn ghost" onClick={(e) => (e.stopPropagation(), move(r.id, -1))}>
                    <ArrowUp size={12} />
                  </button>
                  <button className="icon-btn ghost" onClick={(e) => (e.stopPropagation(), move(r.id, 1))}>
                    <ArrowDown size={12} />
                  </button>
                  <button
                    className="icon-btn ghost"
                    title="Duplicate"
                    onClick={(e) => {
                      e.stopPropagation();
                      const copy = {
                        ...structuredClone(r),
                        id: newId(),
                        name: `${r.name} copy`,
                      };
                      const next = [...rundown];
                      next.splice(rundown.indexOf(r) + 1, 0, copy);
                      saveRundown(next);
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    className="icon-btn ghost"
                    title="Remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      saveRundown(rundown.filter((x) => x.id !== r.id));
                      if (cued === r.id) setCued(null);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="empty">Empty playlist. Add items from your templates with +.</div>}
        </div>
      </aside>

      <main className="op-center">
        <ChannelBar channelId={channelId} />
        <div className="monitors">
          <Monitor width={previewFormat.width} height={previewFormat.height} label="Preview" tally="pvw" extra={template && <span className="muted">{template.name}</span>}>
            {template && (
              <div style={{ position: 'absolute', inset: 0, ...areaClip(itemZone && zoneArea(itemZone, previewFormat.id, previewFormat.height > previewFormat.width)) }}>
                <LiveTime ageSecs={holdFrame(template) / fps} clientNow={Date.now()}>
                  <Scene template={inFormat(template, previewFormat.id)} frame={holdFrame(template)} data={boundDraft} />
                </LiveTime>
              </div>
            )}
          </Monitor>
          <Monitor
            width={picture.width}
            height={picture.height}
            label="Program"
            tally="pgm"
            extra={
              pictures.length > 1 && (
                <span className="monitor-tabs">
                  {pictures.map((p) => (
                    <button key={p.id} className={p.id === picture.id ? 'on' : ''} onClick={() => setPictureId(p.id)} title={`${p.width}×${p.height}`}>
                      {p.name}
                    </button>
                  ))}
                </span>
              )
            }
          >
            <Program project={project} live={liveState} width={picture.width} height={picture.height} />
          </Monitor>
        </div>

        <div className="transport-bar">
          <button className="big-btn take" disabled={!item || !operate} onClick={take} title="F1 / Enter">
            <Play size={20} /> TAKE
          </button>
          <button className="big-btn continue" disabled={!item || !live || !operate} onClick={cont} title="F2 / Space">
            <ChevronsRight size={20} /> CONTINUE
          </button>
          <button className="big-btn out" disabled={!item || !live || !operate} onClick={out} title="F3">
            <CircleStop size={20} /> OUT
          </button>
          <div className="spacer" />
          <button className="big-btn update" disabled={!item || !liveIsThis || !operate} onClick={updateLive} title="Push edited data to the graphic on air">
            <RefreshCw size={18} /> UPDATE
          </button>
          <button className="big-btn clear" disabled={!operate} onClick={() => command({ action: 'clear' })} title="F12 — clear everything">
            <X size={18} /> CLEAR ALL
          </button>
        </div>

        <ZoneStrip project={project} layers={channel.layers} cuedZone={itemZone?.id} command={command} />
      </main>

      <aside className="panel right data-panel">
        <header className="panel-header">
          <span>Data</span>
          {dirty && <span className="badge warn">edited</span>}
        </header>
        {item && template ? (
          <div className="data-form">
            <label className="form-row">
              <span>Item name</span>
              <input value={item.name} onChange={(e) => saveRundown(rundown.map((r) => (r.id === item.id ? { ...r, name: e.target.value } : r)))} onKeyDown={(e) => e.stopPropagation()} />
            </label>
            <label className="form-row">
              <span>Zone</span>
              <select
                value={itemZone?.id ?? ''}
                onChange={(e) => {
                  const z = project.zones.find((x) => x.id === e.target.value);
                  if (z) saveRundown(rundown.map((r) => (r.id === item.id ? { ...r, zone: z.id, layer: z.layer } : r)));
                }}
              >
                {project.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>
            {playlists.length > 1 && (
              <label className="form-row">
                <span>Playlist</span>
                <select value={item.playlist} onChange={(e) => saveRundown(rundown.map((r) => (r.id === item.id ? { ...r, playlist: e.target.value } : r)))}>
                  {playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <hr />
            {template.fields.length === 0 && <p className="hint">This template has no data fields.</p>}
            {template.fields.map((f) => (
              <label key={f.key} className="form-row">
                <span>{f.label}</span>
                {f.binding ? (
                  <span className="bound-field" title={`Live from ${sourceName(f.binding.source)} · ${f.binding.path}`}>
                    <span className="live-dot" />
                    <strong>{boundDraft[f.key] ?? '…'}</strong>
                  </span>
                ) : (
                  <FieldInput field={f} value={draft[f.key] ?? ''} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                )}
              </label>
            ))}
            <div className="row">
              <button className="btn" disabled={!dirty} onClick={persistDraft}>
                Save to rundown
              </button>
              <button className="btn" disabled={!dirty} onClick={() => setDraft({ ...defaultData(template), ...item.data })}>
                Revert
              </button>
            </div>
            <p className="hint">
              Shortcuts: <kbd>F1</kbd>/<kbd>Enter</kbd> take · <kbd>F2</kbd>/<kbd>Space</kbd> continue · <kbd>F3</kbd> out · <kbd>F12</kbd> clear · <kbd>↑</kbd>/<kbd>↓</kbd> cue
            </p>
          </div>
        ) : (
          <div className="empty">Select a rundown item.</div>
        )}
      </aside>
    </div>
  );
}
