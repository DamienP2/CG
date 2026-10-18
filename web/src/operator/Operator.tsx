import { ChevronsRight, CircleStop, Copy, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Square, Trash2, Zap, GripVertical } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Scene, textWarnings, Viewport, type TextWarning } from '../engine/Scene';
import { defaultData, holdFrame, newId, parseHex, toHex } from '../engine/evaluate';
import { rowKey, type Command, type Field, type Layer, type Marker, type PlayoutItem, type Project, type ReadMode, type RundownItem, type Template, type Zone } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { widgetOf } from '../widgets';
import { Warnings } from '../widgets/kit';
import { LiveTime } from '../engine/LiveTime';
import { formatFor, inFormat, projectFormats } from '../engine/formats';
import { api, can, uploadAsset, useApp } from '../store';
import { Program } from '../output/Program';
import { useWheelSteps } from '../ui/fields';
import { AirRows, DataSetHand, DataSetPanel } from './DataSets';
import { bindingLabel, readBinding, useBoundData, useSources } from '../data/dataStore';
import { navigate, projectPath } from '../router';
import { areaClip, zoneArea } from '../engine/zones';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { Splitter, useLayout } from '../ui/Splitter';

/*
 * Operator page, four areas (each resizable):
 *   left    playlists, and the graphics of the playlist with take / out
 *   center  the preview of the selected graphic, and its variables and data
 *   right   what is on air (the output's pictures), and the internal
 *           controls of the graphics on air (widgets, values, triggers)
 */

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
      if (field.min !== undefined && field.max !== undefined && field.max > field.min)
        return (
          <div className="row slider-row">
            <input type="range" min={field.min} max={field.max} step={(field.max - field.min) / 200} value={parseFloat(value) || 0} onChange={(e) => onChange(e.target.value)} />
            <NumberStepper value={value} onChange={onChange} />
          </div>
        );
      return <NumberStepper value={value} onChange={onChange} />;
    case 'boolean':
      return (
        <label className="switch">
          <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} />
          <span>{value === 'true' ? 'On' : 'Off'}</span>
        </label>
      );
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

const rundownName = (project: Project, id?: string | null) => (id ? project.rundown.find((r) => r.id === id)?.name : undefined);

/** The pause marker the graphic holds on, if it holds on a pause (not on the On air point). */
function pauseOf(p: PlayoutItem, project: Project): Marker | undefined {
  if (p.phase !== 'holding' && p.phase !== 'outHold') return undefined;
  const t = project.templates.find((x) => x.id === p.templateId);
  return t?.markers.find((m) => m.kind === 'pause' && Math.abs(m.frame - p.frame) < 0.5);
}

const isPaused = (p: PlayoutItem, project: Project) => !!pauseOf(p, project);

/** Content scaled to fit its box (both ways), on a checkerboard. */
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
    <div className="opx-screen" ref={ref}>
      <Viewport width={width} height={height} scale={scale} className="op-viewport">
        {children}
      </Viewport>
    </div>
  );
}

const READ_MODES: { id: ReadMode; label: string; hint: string }[] = [
  { id: 'manual', label: 'Manually', hint: 'Only when you press Read now: the values are saved in the item' },
  { id: 'take', label: 'On take', hint: 'Once, when the graphic is taken' },
  { id: 'live', label: 'Live', hint: 'On take, then every time the source changes, also on air' },
];
const INTERVALS = [2, 5, 10, 30, 60, 300];

export function Operator({ channelId }: { channelId: string | null }) {
  const { project, command: send, saveRundown, auth, channels, toast } = useApp();
  const allSources = useSources();
  const sourceName = (id: string) => allSources.find((s) => s.id === id)?.name ?? id;
  const liveState = useApp((s) => (channelId ? s.live[channelId] : undefined));
  const channel = liveState?.state ?? { layers: {} };
  // Editing the rundown needs the rights; going on air also needs an output.
  const canEdit = can.operate(auth?.user);
  const operate = canEdit && !!channelId;
  const command: typeof send = (cmd) => operate && send(cmd, channelId!);
  const [layout, setLayout] = useLayout('pulse.operatorLayout', { left: 340, right: 480, preview: 400, air: 330, lists: 200 });
  const [cued, setCued] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [shown, setShown] = useState<string[]>(['main']);
  const [airSel, setAirSel] = useState<string | null>(null);
  // Reordering the graphics by dragging their grip.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; where: 'before' | 'after' } | null>(null);
  const original = useRef<{ id: string; data: Record<string, string> } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const channelInfo = channels.find((c) => c.id === channelId);

  const rundown = project?.rundown ?? [];
  const playlists = project?.playlists ?? [];
  const activeList = playlists.find((p) => p.id === playlistId)?.id ?? playlists[0]?.id ?? '';
  const items = rundown.filter((r) => r.playlist === activeList || !playlists.some((p) => p.id === r.playlist));
  const item = rundown.find((r) => r.id === cued) ?? null;
  const template = item ? project?.templates.find((t) => t.id === item.templateId) : undefined;
  const readMode: ReadMode = item?.read ?? 'live';

  useEffect(() => {
    if ((!cued || !items.some((r) => r.id === cued)) && items.length) setCued(items[0].id);
  }, [cued, activeList, items.length]);

  // The draft follows the selected item; its data on selection is what Revert restores.
  useEffect(() => {
    if (!item || !template) return;
    setDraft({ ...defaultData(template), ...item.data });
    original.current = { id: item.id, data: structuredClone(item.data) };
  }, [cued, template?.id]);

  // Bound fields read live show the source's value (manual ones show what was read).
  const boundDraft = useBoundData(readMode === 'manual' ? undefined : template, draft);
  const previewData = { ...draft, ...boundDraft };
  // Texts too long for their box with these values.
  const fitWarnings = template ? textWarnings(template, previewData) : [];

  /** Saves the item's data a moment after the last edit. */
  const saveData = (id: string, data: Record<string, string>) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const cur = useApp.getState().project?.rundown ?? [];
      await saveRundown(cur.map((r) => (r.id === id ? { ...r, data } : r)));
    }, 500);
  };
  const editDraft = (patch: Record<string, string>) => {
    if (!item) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    saveData(item.id, next);
  };
  const setItem = (id: string, patch: Partial<RundownItem>) => saveRundown(rundown.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const onAirByItem = useMemo(() => {
    const m = new Map<string, PlayoutItem>();
    for (const p of Object.values(channel.layers)) if (p.rundownId) m.set(p.rundownId, p);
    return m;
  }, [channel]);

  const zoneOf = (r: RundownItem) => project?.zones.find((z) => z.id === r.zone) ?? project?.zones.find((z) => z.id === project.templates.find((t) => t.id === r.templateId)?.zone);
  const dataOf = (r: RundownItem) => {
    const t = project?.templates.find((x) => x.id === r.templateId);
    return { ...(t ? defaultData(t) : {}), ...(r.id === item?.id ? draft : r.data) };
  };
  const takeItem = (r: RundownItem, extra?: Record<string, string>) => {
    command({ action: 'take', zone: zoneOf(r)?.id, templateId: r.templateId, data: { ...dataOf(r), ...extra }, rundownId: r.id });
    const z = zoneOf(r);
    if (z) setAirSel(z.id);
  };
  /** The NEXT row the operator chose for a data set of the graphic on air (in the cued item), if it is that one. */
  const nextRowOf = (onAir: PlayoutItem, key: string) => (item && onAirByItem.get(item.id) === onAir ? parseInt(draft[rowKey(key)] ?? '', 10) || undefined : undefined);
  const take = () => {
    if (!item) return;
    takeItem(item);
    // Select the next item of the playlist (a graphic with rows stays: its next row).
    if (template?.datasets?.length) return;
    const idx = items.findIndex((r) => r.id === item.id);
    if (idx >= 0 && idx < items.length - 1) setCued(items[idx + 1].id);
  };
  const outZone = (z: Zone | undefined) => z && command({ action: 'takeOut', zone: z.id });

  // On air, front-most zone first; the internal controls show one of them.
  const zones = useMemo(() => [...(project?.zones ?? [])].sort((a, b) => b.layer - a.layer), [project?.zones]);
  const busy = zones.filter((z) => channel.layers[String(z.layer)]);
  const selZone = busy.find((z) => z.id === airSel) ?? busy[0];
  const selItem = selZone ? channel.layers[String(selZone.layer)] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const idx = items.findIndex((r) => r.id === cued);
      if (e.key === 'F1' || e.key === 'Enter') (e.preventDefault(), take());
      else if (e.key === 'F2' || e.key === ' ') (e.preventDefault(), item && command({ action: 'continue', zone: zoneOf(item)?.id }));
      else if (e.key === 'F3') (e.preventDefault(), item && outZone(zoneOf(item)));
      else if (e.key === 'F12') (e.preventDefault(), command({ action: 'clear' }));
      else if (e.key === 'ArrowDown' && idx < items.length - 1) setCued(items[idx + 1].id);
      else if (e.key === 'ArrowUp' && idx > 0) setCued(items[idx - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!project) return <div className="opx-empty">No project loaded.</div>;

  // Pictures of the output (main + renditions); the ones without a format in the project are off.
  const formats = projectFormats(project);
  const designed = (w: number, h: number) => formats.some((f) => Math.abs(Math.log(f.width / f.height) - Math.log(w / h)) < 0.01);
  const pictures = channelInfo ? [{ id: 'main', name: `${channelInfo.width}×${channelInfo.height}`, width: channelInfo.width, height: channelInfo.height }, ...channelInfo.renditions] : formats.map((f) => ({ id: f.id, name: f.id === 'main' ? 'Main' : f.name, width: f.width, height: f.height }));
  const visible = pictures.filter((p) => shown.includes(p.id) && designed(p.width, p.height));
  const programs = visible.length ? visible : pictures.slice(0, 1);
  const main = pictures[0];
  const previewFormat = formatFor(project, main.width, main.height);
  const itemZone = item ? zoneOf(item) : undefined;
  const fps = project.frameRate.num / project.frameRate.den || 1;

  return (
    <div className="opx" style={{ gridTemplateColumns: `${layout.left}px 1px minmax(0, 1fr) 1px ${layout.right}px` }}>
      {/* Left: playlists and graphics. */}
      <div className="opx-col">
        <section className="opx-pane" style={{ height: layout.lists, flex: 'none' }}>
          <header className="opx-head">
            <span className="opx-title">Playlists</span>
            {canEdit && (
              <button
                className="opx-add"
                title="New playlist"
                onClick={async () => {
                  const name = await promptDialog({ title: 'New playlist', label: 'Name', value: `Playlist ${playlists.length + 1}`, confirm: 'Create' });
                  if (!name) return;
                  const id = newId();
                  await api('PUT', `/api/projects/${encodeURIComponent(project.id)}/playlists`, [...playlists, { id, name }]).catch((e) => toast((e as Error).message, 'error'));
                  setPlaylistId(id);
                }}
              >
                <Plus size={15} />
              </button>
            )}
          </header>
          <div className="opx-scroll">
            {playlists.map((p) => (
              <PlaylistRow key={p.id} project={project} id={p.id} active={p.id === activeList} editable={canEdit} onSelect={() => setPlaylistId(p.id)} />
            ))}
          </div>
        </section>
        <Splitter axis="y" className="opx-gap" value={layout.lists} min={90} max={500} reset={200} onChange={(v) => setLayout('lists', v)} />
        <section className="opx-pane grow">
          <header className="opx-head">
            <span className="opx-title">Graphics · {playlists.find((p) => p.id === activeList)?.name ?? ''}</span>
            {canEdit && (
              <button className="opx-add" title="Add a graphic from a template" onClick={() => setAdding(!adding)}>
                <Plus size={15} />
              </button>
            )}
          </header>
          {adding && (
            <div className="opx-addmenu">
              {project.templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    const z = project.zones.find((x) => x.id === t.zone);
                    const it: RundownItem = { id: newId(), name: t.name, templateId: t.id, zone: t.zone, playlist: activeList, layer: z?.layer ?? 0, data: defaultData(t) };
                    saveRundown([...rundown, it]);
                    setCued(it.id);
                    setAdding(false);
                  }}
                >
                  {t.name}
                  <span className="muted small">{project.zones.find((z) => z.id === t.zone)?.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="opx-scroll">
            {items.map((r) => (
              <GraphicRow
                key={r.id}
                project={project}
                item={r}
                zone={zoneOf(r)}
                air={onAirByItem.get(r.id)}
                selected={r.id === cued}
                operate={operate}
                editable={canEdit}
                onSelect={() => setCued(r.id)}
                onTake={() => takeItem(r)}
                onOut={() => outZone(zoneOf(r))}
                onRename={(name) => setItem(r.id, { name })}
                onDuplicate={() => {
                  const next = [...rundown];
                  next.splice(rundown.indexOf(r) + 1, 0, { ...structuredClone(r), id: newId(), name: `${r.name} copy` });
                  saveRundown(next);
                }}
                onDelete={async () => {
                  if (!(await confirmDialog({ title: `Remove “${r.name}”?`, message: 'It leaves the playlist (the template stays).', confirm: 'Remove', danger: true }))) return;
                  saveRundown(rundown.filter((x) => x.id !== r.id));
                  if (cued === r.id) setCued(null);
                }}
                drag={{
                  over: dropAt?.id === r.id ? dropAt.where : null,
                  onStart: (e) => {
                    setDragging(r.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', r.id);
                    const row = (e.currentTarget as HTMLElement).closest('.opx-gr');
                    if (row) e.dataTransfer.setDragImage(row, 20, 20);
                  },
                  onOver: (e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    const b = e.currentTarget.getBoundingClientRect();
                    const where = e.clientY < b.top + b.height / 2 ? 'before' : 'after';
                    if (dragging !== r.id && (dropAt?.id !== r.id || dropAt.where !== where)) setDropAt({ id: r.id, where });
                  },
                  onDrop: (e) => {
                    e.preventDefault();
                    if (dragging && dropAt && dragging !== r.id) {
                      const moved = rundown.find((x) => x.id === dragging)!;
                      const rest = rundown.filter((x) => x.id !== dragging);
                      const at = rest.findIndex((x) => x.id === r.id) + (dropAt.where === 'after' ? 1 : 0);
                      rest.splice(at, 0, moved);
                      saveRundown(rest);
                    }
                    setDragging(null);
                    setDropAt(null);
                  },
                  onEnd: () => (setDragging(null), setDropAt(null)),
                }}
              />
            ))}
            {!items.length && <p className="opx-hint">Empty playlist: add graphics from your templates with +.</p>}
          </div>
          <footer className="opx-foot">
            <button className="opx-btn big red" disabled={!item || !operate} onClick={take} title="F1 / Enter">
              <Play size={15} fill="currentColor" /> Take
            </button>
            <button className="opx-btn big" disabled={!operate} onClick={() => command({ action: 'clear' })} title="F12: everything out at once">
              Clear all
            </button>
          </footer>
        </section>
      </div>

      <Splitter axis="x" className="opx-gap" value={layout.left} min={260} max={560} reset={340} onChange={(v) => setLayout('left', v)} />

      {/* Center: preview, then variables and data. */}
      <div className="opx-col">
        <section className="opx-pane" style={{ height: layout.preview, flex: 'none' }}>
          <div className="opx-monitor">
            <Screen width={previewFormat.width} height={previewFormat.height}>
              {template && (
                <div style={{ position: 'absolute', inset: 0, ...areaClip(itemZone && zoneArea(itemZone, previewFormat.id, previewFormat.height > previewFormat.width)) }}>
                  <LiveTime ageSecs={holdFrame(template) / fps} clientNow={Date.now()}>
                    <Scene template={inFormat(template, previewFormat.id)} frame={holdFrame(template)} data={previewData} />
                  </LiveTime>
                </div>
              )}
            </Screen>
          </div>
          <div className="opx-strip">Preview{itemZone ? ` · ${itemZone.name}` : ''}</div>
        </section>
        <Splitter axis="y" className="opx-gap" value={layout.preview} min={160} max={900} reset={400} onChange={(v) => setLayout('preview', v)} />
        <section className="opx-pane grow">
          {item && template ? (
            <>
              <header className="opx-head tall">
                <Pencil size={13} className="muted" />
                <input className="opx-name" value={item.name} disabled={!canEdit} onChange={(e) => setItem(item.id, { name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} title="Name in the playlist" />
                <span className="muted small">
                  {template.name} · zone {itemZone?.name ?? '—'}
                </span>
              </header>
              <div className={`opx-edit ${template.datasets?.length ? 'wide-data' : ''}`}>
                <div className="opx-fields">
                  {template.fields.length === 0 && <p className="opx-hint">This graphic has no variables: take it as it is.</p>}
                  {template.fields.map((f) => {
                    const live = f.binding && readMode !== 'manual';
                    return (
                      <label key={f.key} className="opx-field">
                        <span className="opx-label">
                          {f.label}
                          {f.binding && <span className="opx-from">● from {sourceName(f.binding.source)}</span>}
                        </span>
                        {live ? (
                          <span className="opx-bound" title={`${bindingLabel(f.binding!)} — read ${readMode === 'live' ? 'live' : 'on take'}`}>
                            {boundDraft[f.key] ?? draft[f.key] ?? '…'}
                          </span>
                        ) : (
                          <FieldInput field={f} value={draft[f.key] ?? ''} onChange={(v) => editDraft({ [f.key]: v })} />
                        )}
                        {fitWarnings
                          .filter((w) => w.keys.includes(f.key))
                          .map((w) => (
                            <FitWarning key={w.layer.id} w={w} />
                          ))}
                      </label>
                    );
                  })}
                  {fitWarnings
                    .filter((w) => !w.keys.some((k) => template.fields.some((f) => f.key === k)))
                    .map((w) => (
                      <FitWarning key={w.layer.id} w={w} named />
                    ))}
                  {template.datasets?.map((ds) => (
                    <DataSetHand key={ds.key} ds={ds} template={template} draft={draft} onAir={onAirByItem.get(item.id)} operate={operate} zone={itemZone?.id} onDraft={editDraft} command={command} />
                  ))}
                </div>
                <DataBlock project={project} template={template} item={item} draft={draft} canEdit={canEdit} onRead={(patch) => editDraft(patch)} onMode={(m) => setItem(item.id, { read: m === 'live' ? undefined : m })}>
                  {template.datasets?.map((ds, i) => (
                    <DataSetPanel key={ds.key} ds={ds} template={template} draft={draft} onAir={onAirByItem.get(item.id)} operate={operate} zone={itemZone?.id} fps={fps} onDraft={editDraft} command={command} keys={i === 0} />
                  ))}
                </DataBlock>
              </div>
            </>
          ) : (
            <p className="opx-hint pad">Select a graphic in the playlist.</p>
          )}
        </section>
      </div>

      <Splitter axis="x" className="opx-gap" sign={-1} value={layout.right} min={320} max={760} reset={480} onChange={(v) => setLayout('right', v)} />

      {/* Right: on air, then the internal controls of the graphics on air. */}
      <div className="opx-col">
        <section className="opx-pane" style={{ height: layout.air, flex: 'none' }}>
          <header className="opx-head">
            <span className={`opx-title ${busy.length ? 'live' : ''}`}>● On air</span>
            <OutputSelect channelId={channelId} />
          </header>
          <div className="opx-pics">
            {pictures.map((p) => {
              const ok = designed(p.width, p.height);
              const on = ok && (shown.includes(p.id) || (!visible.length && p === pictures[0]));
              return (
                <button key={p.id} className={on ? 'on' : ''} disabled={!ok} title={ok ? `${p.width}×${p.height}` : `${p.width}×${p.height}: not designed in this project (add the format in the Designer)`} onClick={() => setShown(on ? shown.filter((x) => x !== p.id) : [...shown, p.id])}>
                  {p.name}
                </button>
              );
            })}
            <div className="spacer" />
            {channelInfo && (
              <a className="opx-link" href={`/output/${encodeURIComponent(channelInfo.id)}`} target="_blank" rel="noreferrer">
                HTML5 ↗
              </a>
            )}
          </div>
          <div className="opx-programs">
            {channelId ? (
              programs.map((p) => (
                <div key={p.id} className="opx-monitor" style={{ flex: `${p.width / p.height} 1 0` }}>
                  <Screen width={p.width} height={p.height}>
                    <Program project={project} live={liveState} width={p.width} height={p.height} />
                  </Screen>
                </div>
              ))
            ) : (
              <p className="opx-hint pad">No output: choose one above to take graphics on air. You can still prepare the playlists.</p>
            )}
          </div>
          <div className={`opx-strip ${busy.length ? 'live' : ''}`}>{!channelId ? 'No output' : busy.length ? `Live · ${busy.length} on screen` : 'Off air'}</div>
        </section>
        <Splitter axis="y" className="opx-gap" value={layout.air} min={160} max={800} reset={330} onChange={(v) => setLayout('air', v)} />
        <section className="opx-pane grow">
          <header className="opx-head opx-tabs">
            {busy.length ? (
              busy.map((z) => {
                const p = channel.layers[String(z.layer)];
                return (
                  <button key={z.id} className={z.id === selZone?.id ? 'on' : ''} onClick={() => setAirSel(z.id)}>
                    {rundownName(project, p.rundownId) ?? project.templates.find((t) => t.id === p.templateId)?.name}
                  </button>
                );
              })
            ) : (
              <span className="opx-title">Controls</span>
            )}
          </header>
          {selItem && selZone ? (
            <AirControls project={project} zone={selZone} item={selItem} command={command} onSaveData={(data) => selItem.rundownId && setItem(selItem.rundownId, { data })} nextRowOf={(key) => nextRowOf(selItem, key)} />
          ) : (
            <p className="opx-hint pad">Nothing on air. The controls of the graphics on air show here: their widgets, values and triggers.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function PlaylistRow({ project, id, active, editable, onSelect }: { project: Project; id: string; active: boolean; editable: boolean; onSelect: () => void }) {
  const toast = useApp((s) => s.toast);
  const [menu, setMenu] = useState(false);
  const p = project.playlists.find((x) => x.id === id)!;
  const count = project.rundown.filter((r) => r.playlist === id).length;
  const save = (lists: Project['playlists']) => api('PUT', `/api/projects/${encodeURIComponent(project.id)}/playlists`, lists).catch((e) => toast((e as Error).message, 'error'));
  return (
    <div className={`opx-pl ${active ? 'on' : ''}`} onClick={onSelect}>
      <span className="opx-name-cell">{p.name}</span>
      <span className="muted small">
        {count} item{count === 1 ? '' : 's'}
      </span>
      {editable && (
        <span className="opx-more" onClick={(e) => e.stopPropagation()}>
          <button className="opx-x" onClick={() => setMenu(!menu)} title="More">
            <MoreHorizontal size={14} />
          </button>
          {menu && (
            <div className="popover" onMouseLeave={() => setMenu(false)}>
              <button
                onClick={async () => {
                  setMenu(false);
                  const name = await promptDialog({ title: 'Rename the playlist', label: 'Name', value: p.name, confirm: 'Rename' });
                  if (name) save(project.playlists.map((x) => (x.id === id ? { ...x, name } : x)));
                }}
              >
                Rename…
              </button>
              {project.playlists.length > 1 && (
                <button
                  onClick={async () => {
                    setMenu(false);
                    const other = project.playlists.find((x) => x.id !== id)!;
                    if (await confirmDialog({ title: `Remove the playlist “${p.name}”?`, message: `Its ${count} graphic(s) move to “${other.name}”.`, confirm: 'Remove', danger: true })) save(project.playlists.filter((x) => x.id !== id));
                  }}
                >
                  Remove…
                </button>
              )}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

/** A text too long for its box: reduced, or not all shown. */
function FitWarning({ w, named }: { w: TextWarning; named?: boolean }) {
  const pct = `${Math.round(w.ratio * 100)} %`;
  const mode = w.layer.overflow ?? 'fit';
  return (
    <span className={`opx-fit ${w.overflows ? 'bad' : ''}`} title="The text does not fit its box as designed">
      {named && <strong>{w.layer.name}:</strong>}
      {!w.overflows ? `text reduced to ${pct}` : mode === 'fit' ? 'too long: cut even when reduced — shorten it' : mode === 'ellipsis' ? 'too long: shown with “…”' : 'too long: cut on air'}
    </span>
  );
}

/** In, hold and out of a template, and where the graphic on air is in it. */
function MiniTimeline({ template, air }: { template?: Template; air?: PlayoutItem }) {
  if (!template) return null;
  const d = Math.max(1, template.duration);
  const hold = Math.min(d, holdFrame(template));
  const pauses = template.markers.filter((m) => m.kind === 'pause');
  return (
    <span className={`opx-mtl ${air ? 'air' : ''}`} title={air ? `On air · ${air.phase}` : 'In · on air · out'}>
      <span className="in" style={{ width: `${(hold / d) * 100}%` }} />
      <span className="out" style={{ left: `${(hold / d) * 100}%` }} />
      {pauses.map((m) => (
        <span key={m.id} className="pause" style={{ left: `${(m.frame / d) * 100}%` }} />
      ))}
      {air && <span className="ph" style={{ left: `${(Math.min(air.frame, d) / d) * 100}%` }} />}
    </span>
  );
}

function GraphicRow(props: {
  project: Project;
  item: RundownItem;
  zone?: Zone;
  air?: PlayoutItem;
  selected: boolean;
  operate: boolean;
  editable: boolean;
  onSelect: () => void;
  onTake: () => void;
  onOut: () => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  drag: { over: 'before' | 'after' | null; onStart: (e: React.DragEvent) => void; onOver: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void; onEnd: () => void };
}) {
  const { project, item, zone, air } = props;
  const t = project.templates.find((x) => x.id === item.templateId);
  const paused = air && isPaused(air, project);
  const [renaming, setRenaming] = useState(false);
  return (
    <div className={`opx-gr ${props.selected ? 'on' : ''} ${air ? 'air' : ''} ${props.drag.over ? `drop-${props.drag.over}` : ''}`} onClick={props.onSelect} onDragOver={props.drag.onOver} onDrop={props.drag.onDrop}>
      {props.editable && (
        <span className="opx-grip" draggable onDragStart={props.drag.onStart} onDragEnd={props.drag.onEnd} title="Drag to reorder" onClick={(e) => e.stopPropagation()}>
          <GripVertical size={14} />
        </span>
      )}
      <button
        className={`opx-sq big ${air ? (paused ? 'amber' : 'red') : ''}`}
        disabled={!props.operate}
        title={air ? 'Out' : 'Take'}
        onClick={(e) => {
          e.stopPropagation();
          if (air) props.onOut();
          else props.onTake();
        }}
      >
        {air ? <Square size={12} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
      <span className="opx-gr-main">
        {renaming ? (
          <input
            className="opx-rename"
            autoFocus
            defaultValue={item.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== item.name) props.onRename(v);
              setRenaming(false);
            }}
          />
        ) : (
          <strong title={props.editable ? 'Double-click to rename' : undefined} onDoubleClick={(e) => (e.stopPropagation(), props.editable && setRenaming(true))}>
            {item.name}
          </strong>
        )}
        <span className="muted small">
          <span className="opx-dot" style={{ background: zone?.color ?? '#6b7090' }} /> {zone?.name ?? 'no zone'} · {t?.name ?? 'missing template'}
        </span>
        <MiniTimeline template={t} air={air} />
      </span>
      {props.editable && (
        <span className="opx-acts" onClick={(e) => e.stopPropagation()}>
          <button title="Duplicate" onClick={props.onDuplicate}>
            <Copy size={13} />
          </button>
          <button className="red" title="Remove" onClick={props.onDelete}>
            <Trash2 size={13} />
          </button>
        </span>
      )}
    </div>
  );
}

/** Sources the graphic reads, when it reads them, and Read now. */
function DataBlock({ template, item, draft, canEdit, onRead, onMode, children }: { children?: React.ReactNode; project: Project; template: Template; item: RundownItem; draft: Record<string, string>; canEdit: boolean; onRead: (patch: Record<string, string>) => void; onMode: (m: ReadMode) => void }) {
  const all = useSources();
  const auth = useApp((s) => s.auth);
  const toast = useApp((s) => s.toast);
  const bound = template.fields.filter((f) => f.binding?.source);
  const used = [...new Set(bound.map((f) => f.binding!.source))].map((id) => all.find((s) => s.id === id) ?? { id, name: id, interval: 0, updatedAt: null, error: 'not found' });
  const mode: ReadMode = item.read ?? 'live';
  const [reading, setReading] = useState(false);
  const readNow = async () => {
    setReading(true);
    const patch: Record<string, string> = {};
    await Promise.all(
      bound.map(async (f) => {
        const v = await readBinding(f.binding!, draft);
        if (v !== null) patch[f.key] = v;
      }),
    );
    setReading(false);
    onRead(patch);
    toast(`${Object.keys(patch).length} value(s) read`, 'info');
  };
  const ago = (t?: number | null) => {
    if (!t) return 'never read';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `read ${s} s ago` : `read ${Math.round(s / 60)} min ago`;
  };
  return (
    <div className="opx-data">
      <div className="opx-data-title">Data</div>
      {children}
      {!used.length ? (
        !template.datasets?.length && <p className="opx-hint">No data source: the operator types the values. Link a variable to a source in the Designer (Data canvas).</p>
      ) : (
        <>
          {used.map((s) => (
            <div key={s.id} className="opx-source">
              <span className={`live-dot ${s.error ? 'err' : ''}`} />
              <strong>{s.name}</strong>
              <span className="muted small">{s.error ? s.error : ago(s.updatedAt)}</span>
            </div>
          ))}
          <div>
            <span className="opx-label">Read the data</span>
            <div className="opx-seg">
              {READ_MODES.map((m) => (
                <button key={m.id} className={mode === m.id ? 'on' : ''} disabled={!canEdit} title={m.hint} onClick={() => onMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {mode === 'live' && (
            <div className="opx-every">
              {used.map((s) => (
                <label key={s.id}>
                  <span className="muted small">{s.name} checked every</span>
                  <select
                    value={s.interval}
                    disabled={!can.design(auth?.user) || !('type' in s)}
                    title={can.design(auth?.user) ? 'How often the server reads the source (for every graphic using it)' : 'Set by a designer in Data'}
                    onChange={async (e) => {
                      const { updatedAt, checkedAt, error, bytes, ...src } = s as typeof s & { checkedAt?: number; bytes?: number };
                      (void updatedAt, checkedAt, error, bytes);
                      await api('PUT', `/api/data/sources/${encodeURIComponent(s.id)}`, { ...src, interval: +e.target.value }).catch((err) => toast((err as Error).message, 'error'));
                    }}
                  >
                    {[...new Set([...INTERVALS, s.interval])]
                      .filter((v) => v > 0)
                      .sort((a, b) => a - b)
                      .map((v) => (
                        <option key={v} value={v}>
                          {v < 60 ? `${v} s` : `${v / 60} min`}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <div>
            <span className="opx-label">Fields fed by the sources</span>
            {bound.map((f) => (
              <div key={f.key} className="opx-map">
                <span>{f.label}</span>
                <code>{bindingLabel(f.binding!)}</code>
              </div>
            ))}
          </div>
          {mode !== 'live' && (
            <button className="opx-btn" disabled={reading || !canEdit} onClick={readNow} title={mode === 'manual' ? 'Read the sources now and keep the values in this item' : 'Read now to check; the take reads again'}>
              <RefreshCw size={13} /> {reading ? 'Reading…' : 'Read now'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Internal controls of one graphic on air: widgets, number values, triggers, continue / update / out. */
/** Operator controls of a spec widget of the graphic on air (web/src/widgets). */
function SpecControls({ layer, item, act }: { layer: Layer; item: PlayoutItem; act: (op: string, args?: unknown) => void }) {
  const def = widgetOf(layer.type)!;
  const Op = def.Operator!;
  const offset = useApp((s) => s.serverOffset);
  const tz = useApp((s) => s.timezone);
  const state = item.widgets?.[layer.id];
  const warnings = (def.warnings?.(layer as never, { data: item.data, state }) ?? []).filter((w) => w.op);
  const Icon = def.icon;
  return (
    <div className="opx-spec">
      <div className="opx-spec-head">
        <Icon size={13} />
        <strong>{layer.name}</strong>
        <span className="muted small">{def.label}</span>
      </div>
      <Warnings list={warnings} />
      <Op layer={layer as never} state={state} data={item.data} act={act} item={item} time={{ nowMs: Date.now() + offset, ageSecs: (item.age ?? 0) / 50, defaultTz: tz }} />
    </div>
  );
}

function AirControls({ project, zone, item, command, onSaveData, nextRowOf }: { project: Project; zone: Zone; item: PlayoutItem; command: (c: Command) => void; onSaveData: (d: Record<string, string>) => void; nextRowOf?: (dataset: string) => number | undefined }) {
  const t = project.templates.find((x) => x.id === item.templateId);
  if (!t) return null;
  const target = { zone: zone.id };
  const timed = t.layers.filter(isTimed);
  const numbers = t.fields.filter((f) => f.kind === 'number' && !f.binding);
  // Pauses waiting for a trigger, and values set by hand until one.
  const triggers = [...new Set([...t.markers.flatMap((m) => (m.kind === 'pause' && m.resume?.type === 'trigger' ? [m.resume.name] : [])), ...Object.entries(item.data).flatMap(([k, v]) => (k.endsWith('__manual') && v.startsWith('trigger:') ? [v.slice(8)] : []))])];
  const waiting = pauseOf(item, project);
  const setValue = (key: string, v: string) => {
    const data = { ...item.data, [key]: v };
    command({ action: 'update', ...target, data });
    onSaveData(data);
  };
  const r = item.rundownId ? project.rundown.find((x) => x.id === item.rundownId) : undefined;
  return (
    <div className="opx-controls">
      <div className="opx-actions sticky">
        <button className={`opx-btn ${waiting ? 'amber' : ''}`} onClick={() => command({ action: 'continue', ...target })} title="F2 / Space">
          <ChevronsRight size={14} /> Continue
        </button>
        <button className="opx-btn violet" disabled={!r} title="Send the item's saved data to the graphic on air" onClick={() => r && command({ action: 'update', ...target, data: { ...defaultData(t), ...r.data } })}>
          <RefreshCw size={13} /> Update
        </button>
        <button className="opx-btn" onClick={() => command({ action: 'takeOut', ...target })} title="F3">
          <CircleStop size={14} /> Out
        </button>
      </div>
      {!!t.datasets?.length && <AirRows sets={t.datasets} item={item} command={command} zone={zone.id} nextRowOf={nextRowOf} />}
      {t.layers
        .filter((l) => l.visible && widgetOf(l.type)?.Operator)
        .map((l) => (
          <SpecControls key={l.id} layer={l} item={item} act={(op, args) => command({ action: 'act', target: l.id, op, args, ...target })} />
        ))}
      {timed
        .filter((l) => !widgetOf(l.type)?.Operator)
        .map((l) => {
          const c = item.clocks?.[l.id];
          const running = c ? c.pausedAt == null : !l.manualStart;
          return (
            <div key={l.id} className="opx-widget">
              <button className={`opx-sq ${running ? '' : 'green'}`} title={running ? 'Pause' : 'Start'} onClick={() => command({ action: 'widget', target: l.id, control: 'toggle', ...target })}>
                {running ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
              </button>
              <span className="opx-widget-name">
                <strong>{l.name}</strong>
                <span className="muted small">{running ? 'running' : 'stopped'}</span>
              </span>
              <button className="opx-sq" title="Back to the start" onClick={() => command({ action: 'widget', target: l.id, control: running ? 'restart' : 'reset', ...target })}>
                <RotateCcw size={13} />
              </button>
            </div>
          );
        })}
      {numbers.length > 0 && (
        <div className="opx-numbers">
          {numbers.map((f) => {
            const v = item.data[f.key] ?? f.default;
            const bump = (d: number) => setValue(f.key, String(+((parseFloat(v) || 0) + d).toFixed(3)));
            return (
              <div key={f.key} className="opx-number">
                <span>{f.label}</span>
                <button className="opx-mini" onClick={() => bump(-1)}>
                  −
                </button>
                <strong>{v}</strong>
                <button className="opx-mini" onClick={() => bump(1)}>
                  +
                </button>
              </div>
            );
          })}
        </div>
      )}
      {triggers.length > 0 && (
        <div className="opx-triggers">
          <span className="opx-label">Triggers</span>
          {triggers.map((n) => (
            <button key={n} className={`opx-btn small ${waiting?.resume?.type === 'trigger' && waiting.resume.name === n ? 'amber' : ''}`} onClick={() => command({ action: 'trigger', name: n })} title="Every graphic waiting for this trigger plays on">
              <Zap size={12} /> {n}
            </button>
          ))}
        </div>
      )}
      {!timed.length && !numbers.length && !triggers.length && !t.datasets?.length && !t.layers.some((l) => widgetOf(l.type)?.Operator) && <p className="opx-hint">This graphic has no internal controls.</p>}
    </div>
  );
}

/** The output the operator takes to; another project's output is taken over after a confirmation. */
function OutputSelect({ channelId }: { channelId: string | null }) {
  const { channels, projects, project, live, loadOnChannel } = useApp();
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
    <select className="opx-output" value={channelId ?? ''} onChange={(e) => void pick(e.target.value)} title="Output">
      <option value="">No output (preview only)</option>
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
  );
}
