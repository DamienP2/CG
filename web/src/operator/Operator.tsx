import { RichInput } from '../ui/RichText';
import { richField } from '../engine/rich';
import { AssetPicker } from '../designer/AssetPicker';
import { ChevronsRight, CircleStop, Copy, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Repeat, RotateCcw, SkipForward, Square, Timer, Trash2, X, Zap, GripVertical } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Scene, textWarnings, Viewport, type TextWarning } from '../engine/Scene';
import { defaultData, holdFrame, newId, parseHex, toHex } from '../engine/evaluate';
import { linesKey, oneKey, rowKey, usedDatasets, type Command, type Field, type Layer, type Marker, type Phase, type PlayoutItem, type Playlist, type Project, type ReadMode, type RundownItem, type Template, type Zone } from '../engine/types';
import { isTimed } from '../engine/widgets';
import { widgetOf } from '../widgets';
import { Warnings } from '../widgets/kit';
import { LiveTime } from '../engine/LiveTime';
import { formatFor, inFormat, projectFormats } from '../engine/formats';
import { api, can, thumbnailUrl, useApp } from '../store';
import { Program } from '../output/Program';
import { ColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { Row } from '../widgets/kit';
import { AirRows, DataSetHand, DataSetPanel, DataSetSource, datasetUse, sourcePatch, steppedDatasets } from './DataSets';
import { exposedFields, FedText, LayerProperties, OpSection, type FieldIO } from './Exposed';
import { shownText } from '../widgets/text';
import { bindingLabel, readBinding, useBoundData, useSources } from '../data/dataStore';
import { navigate, projectPath } from '../router';
import { areaClip, zoneArea } from '../engine/zones';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { TableRowsInput } from '../widgets/table-rows';
import { Splitter, useLayout } from '../ui/Splitter';
import { t, tc, tn } from '../i18n';

/*
 * Operator page, four areas (each resizable):
 *   left    playlists, and the graphics of the playlist with take / out
 *   center  the preview of the selected graphic, and its variables and data
 *   right   what is on air (the output's pictures), and the internal
 *           controls of the graphics on air (widgets, values, triggers)
 */

/** The control of an exposed value, as in the Designer (text, choices, number, colour, picture, on / off). */
export function FieldInput({ field, value, onChange, rich }: { field: Field; value: string; onChange: (v: string) => void; rich?: boolean }) {
  // A text the operator can style (bold, colour…: it is only shown in Texts).
  if (rich) return <RichInput multiline={field.kind === 'multiline'} value={value} onChange={onChange} />;
  if (field.options?.length) {
    const short = field.options.length <= 4 && field.options.every(([, l]) => l.length <= 12);
    return short ? (
      <Segmented value={value} onChange={onChange} options={field.options.map(([v, l]) => ({ value: v, label: l }))} />
    ) : (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!field.options.some(([v]) => v === value) && <option value={value}>{value}</option>}
        {field.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    );
  }
  switch (field.kind) {
    case 'multiline':
      return <TextInput multiline value={value} onChange={onChange} />;
    case 'number':
      return (
        <span className="pp-field">
          <NumberField value={parseFloat(value) || 0} min={field.min} max={field.max} step={1} precision={value.includes('.') ? Math.min(3, value.split('.')[1].length) : 0} onChange={(v) => onChange(String(v))} />
        </span>
      );
    case 'boolean':
      return (
        <button className={`wk-tog ${value === 'true' ? 'on' : ''}`} onClick={() => onChange(value === 'true' ? 'false' : 'true')}>
          <i />
        </button>
      );
    case 'color':
      return (
        <span className="pp-field color">
          <ColorField value={parseHex(value) ?? [1, 1, 1, 1]} onChange={(x) => onChange(toHex(x, x[3] < 1))} />
        </span>
      );
    case 'image':
      return <AssetPicker value={value} onChange={onChange} />;
    case 'table':
      return <TableRowsInput value={value} onChange={onChange} />;
    default:
      return <TextInput value={value} onChange={onChange} />;
  }
}

/**
 * What Update sends: the values the operator set, without the rows of the data sets (NEXT is not
 * the row on air) and without the values read from a source (they are read again on air).
 */
function updateData(t: Template, draft: Record<string, string>, read: ReadMode): Record<string, string> {
  const ds = usedDatasets(t).map((d) => d.key);
  // A data set only feeding Texts: its chosen row (and all rows / one row) go with the other values.
  const sent = new Set(usedDatasets(t).flatMap((d) => (datasetUse(t, d).source ? [rowKey(d.key), oneKey(d.key)] : [])));
  const bound = new Set(read === 'manual' ? [] : t.fields.filter((f) => f.binding?.source).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...defaultData(t), ...draft })) {
    if (bound.has(k) || (!sent.has(k) && ds.some((d) => k.startsWith(`${d}__`)))) continue;
    out[k] = v;
  }
  return { ...out, ...sourcePatch(t) };
}

/** Fields grouped by layer ("Name · Vertical": group Name, label Vertical). */
function fieldGroups(fields: Field[]): { title: string; fields: { f: Field; label: string }[] }[] {
  const out: { title: string; fields: { f: Field; label: string }[] }[] = [];
  for (const f of fields) {
    const at = f.label.indexOf(' · ');
    const title = at > 0 ? f.label.slice(0, at) : '';
    const label = at > 0 ? f.label.slice(at + 3) : f.label;
    let g = out.find((x) => x.title === title);
    if (!g) out.push((g = { title, fields: [] }));
    g.fields.push({ f, label });
  }
  return out;
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

/** Tooltip of the mini timeline of a graphic on air, by phase (translated where shown). */
const PHASE_TITLES: Record<Phase, string> = {
  playing: 'On air · playing',
  holding: 'On air · holding',
  out: 'On air · out',
  outHold: 'On air · outHold',
};

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
  const [layout, setLayout] = useLayout('pulse.operatorLayout', { left: 340, right: 480, preview: 400, air: 330, lists: 200, fields: 50 });
  const [cued, setCued] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [updateFade, setUpdateFade] = useUpdateFade();
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
  // An empty template (or one that became empty) is not part of the rundown.
  const playable = (id: string) => !!project?.templates.find((t) => t.id === id)?.layers.some((l) => l.visible !== false);
  const items = rundown.filter((r) => (r.playlist === activeList || !playlists.some((p) => p.id === r.playlist)) && playable(r.templateId));
  const activePl = playlists.find((p) => p.id === activeList);
  const setPlaylist = (patch: Partial<Playlist>) =>
    project &&
    api(
      'PUT',
      `/api/projects/${encodeURIComponent(project.id)}/playlists`,
      playlists.map((p) => (p.id === activeList ? { ...p, ...patch } : p)),
    ).catch((e) => toast((e as Error).message, 'error'));
  const item = rundown.find((r) => r.id === cued && playable(r.templateId)) ?? null;
  const template = item ? project?.templates.find((t) => t.id === item.templateId) : undefined;
  const readMode: ReadMode = item?.read ?? 'live';

  useEffect(() => {
    if (!cued || !items.some((r) => r.id === cued)) setCued(items.length ? items[0].id : null);
  }, [cued, activeList, items.length]);

  // The draft follows the selected item; its data on selection is what Revert restores.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pending = useRef<{ id: string; data: Record<string, string> } | null>(null);
  useEffect(() => {
    if (!item || !template) return;
    const fresh = { ...defaultData(template), ...item.data };
    draftRef.current = fresh;
    setDraft(fresh);
    original.current = { id: item.id, data: structuredClone(item.data) };
  }, [cued, template?.id]);
  // Changed elsewhere (another operator, MOS, the API) or new fields after a publish: follow, unless an edit is on its way.
  useEffect(() => {
    if (!item || !template || pending.current?.id === item.id) return;
    const fresh = { ...defaultData(template), ...item.data };
    if (JSON.stringify(fresh) === JSON.stringify(draftRef.current)) return;
    draftRef.current = fresh;
    setDraft(fresh);
  }, [item?.data, template?.fields]);

  // Bound fields read live show the source's value (manual ones show what was read).
  const boundDraft = useBoundData(readMode === 'manual' ? undefined : template, draft);
  const previewData = { ...(template ? defaultData(template) : {}), ...draft, ...boundDraft };
  // Texts too long for their box with these values.
  const fitWarnings = template ? textWarnings(template, previewData) : [];

  /** Saves the item's data a moment after the last edit. */
  const flush = async () => {
    clearTimeout(saveTimer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const cur = useApp.getState().project?.rundown ?? [];
    await saveRundown(cur.map((r) => (r.id === p.id ? { ...r, data: p.data } : r)));
  };
  const saveData = (id: string, data: Record<string, string>) => {
    // Another item's edit still on its way: saved now, not dropped.
    if (pending.current && pending.current.id !== id) void flush();
    pending.current = { id, data };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 500);
  };
  const editDraft = (patch: Record<string, string>) => {
    if (!item) return;
    // From the latest draft: two edits in the same moment both count.
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
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
    const tpl = project?.templates.find((x) => x.id === r.templateId);
    command({ action: 'take', zone: zoneOf(r)?.id, templateId: r.templateId, data: { ...dataOf(r), ...(tpl ? sourcePatch(tpl) : {}), ...extra }, rundownId: r.id });
    const z = zoneOf(r);
    if (z) setAirSel(z.id);
  };
  /** The NEXT row the operator chose for a data set of the graphic on air (in the cued item), if it is that one. */
  const nextRowOf = (onAir: PlayoutItem, key: string) => (item && onAirByItem.get(item.id) === onAir ? parseInt(draft[rowKey(key)] ?? '', 10) || undefined : undefined);
  /** The graphic after `r` in the playlist (the first again when it loops). */
  const after = (r: RundownItem) => {
    const i = items.findIndex((x) => x.id === r.id);
    const n = i >= 0 && i < items.length - 1 ? items[i + 1] : activePl?.loop ? items[0] : undefined;
    return n && n.id !== r.id ? n : undefined;
  };
  /** NEXT: takes the cued graphic (the one after it when it is already on air), then cues the following one. */
  const nextTarget = item && onAirByItem.get(item.id) ? after(item) : (item ?? undefined);
  const take = () => {
    if (!nextTarget) return;
    takeItem(nextTarget);
    const n = after(nextTarget);
    if (n) setCued(n.id);
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
      // Continue / Out act on the graphic on air shown in the controls (not on the next one cued).
      else if (e.key === 'F2' || e.key === ' ') (e.preventDefault(), selZone && command({ action: 'continue', zone: selZone.id }));
      else if (e.key === 'F3') (e.preventDefault(), outZone(selZone));
      else if (e.key === 'F12') (e.preventDefault(), command({ action: 'clear' }));
      else if (e.key === 'ArrowDown' && idx < items.length - 1) setCued(items[idx + 1].id);
      else if (e.key === 'ArrowUp' && idx > 0) setCued(items[idx - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!project) return <div className="opx-empty">{t('No project loaded.')}</div>;

  // Pictures of the output (main + renditions); the ones without a format in the project are off.
  const formats = projectFormats(project);
  const designed = (w: number, h: number) => formats.some((f) => Math.abs(Math.log(f.width / f.height) - Math.log(w / h)) < 0.01);
  const pictures = channelInfo ? [{ id: 'main', name: `${channelInfo.width}×${channelInfo.height}`, width: channelInfo.width, height: channelInfo.height }, ...channelInfo.renditions] : formats.map((f) => ({ id: f.id, name: f.id === 'main' ? t('Main') : f.name, width: f.width, height: f.height }));
  const visible = pictures.filter((p) => shown.includes(p.id) && designed(p.width, p.height));
  const programs = visible.length ? visible : pictures.slice(0, 1);
  const main = pictures[0];
  const previewFormat = formatFor(project, main.width, main.height);
  const itemZone = item ? zoneOf(item) : undefined;
  const fps = project.frameRate.num / project.frameRate.den || 1;
  // The data part only when the graphic reads data (a source or a data set).
  const hasData = !!template && (!!usedDatasets(template).length || template.fields.some((f) => f.binding?.source));

  return (
    <div className="opx" style={{ gridTemplateColumns: `${layout.left}px 1px minmax(0, 1fr) 1px ${layout.right}px` }}>
      {/* Left: playlists and graphics. */}
      <div className="opx-col">
        <section className="opx-pane" style={{ height: layout.lists, flex: 'none' }}>
          <header className="opx-head">
            <span className="opx-title">{t('Playlists')}</span>
            {canEdit && (
              <button
                className="opx-add"
                title={t('New playlist')}
                onClick={async () => {
                  const name = await promptDialog({ title: t('New playlist'), label: t('Name'), value: t('Playlist {n}', { n: playlists.length + 1 }), confirm: t('Create') });
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
            <span className="opx-title">{t('Rundown · {name}', { name: playlists.find((p) => p.id === activeList)?.name ?? '' })}</span>
            {activePl && canEdit && (
              <>
                <button className={`opx-btn small ${activePl.autoNext ? 'violet' : ''}`} title={t('Auto next: each graphic takes the next one after its time (set on each graphic)')} onClick={() => setPlaylist({ autoNext: !activePl.autoNext || undefined })}>
                  <Timer size={13} /> {t('Auto next')}
                </button>
                <button className={`opx-btn small ${activePl.loop ? 'violet' : ''}`} title={t('Loop: after the last graphic, the first again')} onClick={() => setPlaylist({ loop: !activePl.loop || undefined })}>
                  <Repeat size={13} />
                </button>
              </>
            )}
            {canEdit && (
              <button className="opx-add" title={t('Add a graphic from a template')} onClick={() => setAdding(!adding)}>
                <Plus size={15} />
              </button>
            )}
          </header>
          {adding && (
            <AddGraphic
              project={project}
              templates={project.templates.filter((t) => playable(t.id))}
              used={(id) => items.filter((r) => r.templateId === id).length}
              onClose={() => setAdding(false)}
              onPick={(t) => {
                const z = project.zones.find((x) => x.id === t.zone);
                const it: RundownItem = { id: newId(), name: t.name, templateId: t.id, zone: t.zone, playlist: activeList, layer: z?.layer ?? 0, data: defaultData(t) };
                saveRundown([...rundown, it]);
                setCued(it.id);
                setAdding(false);
              }}
            />
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
                cue={r.id === nextTarget?.id}
                operate={operate}
                editable={canEdit}
                onSelect={() => setCued(r.id)}
                onTake={() => takeItem(r)}
                onOut={() => outZone(zoneOf(r))}
                onRename={(name) => setItem(r.id, { name })}
                autoNext={!!activePl?.autoNext}
                onAuto={(patch) => setItem(r.id, patch)}
                onDuplicate={() => {
                  const next = [...rundown];
                  next.splice(rundown.indexOf(r) + 1, 0, { ...structuredClone(r), id: newId(), name: t('{name} copy', { name: r.name }) });
                  saveRundown(next);
                }}
                onDelete={async () => {
                  if (!(await confirmDialog({ title: t('Remove “{name}”?', { name: r.name }), message: t('It leaves the playlist (the template stays).'), confirm: t('Remove'), danger: true }))) return;
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
            {!items.length && <p className="opx-hint">{t('Empty playlist: add graphics from your templates with +.')}</p>}
          </div>
          <footer className="opx-foot">
            <button className="opx-btn big red" disabled={!nextTarget || !operate} onClick={take} title={t('F1 / Enter: takes {name}', { name: nextTarget?.name ?? t('the next graphic') })}>
              <SkipForward size={15} fill="currentColor" /> Next
              {nextTarget && <span className="opx-next-name">{nextTarget.name}</span>}
            </button>
            <button className="opx-btn big" disabled={!operate} onClick={() => command({ action: 'clear' })} title={t('F12: everything out at once')}>
              {t('Clear all')}
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
          <div className="opx-strip">{itemZone ? t('Preview · {zone}', { zone: itemZone.name }) : t('Preview')}</div>
        </section>
        <Splitter axis="y" className="opx-gap" value={layout.preview} min={160} max={900} reset={400} onChange={(v) => setLayout('preview', v)} />
        <section className="opx-pane grow">
          {item && template ? (
            <>
              <header className="opx-head tall">
                <Pencil size={13} className="muted" />
                <input className="opx-name" value={item.name} disabled={!canEdit} onChange={(e) => setItem(item.id, { name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} title={t('Name in the playlist')} />
                <span className="muted small">{t('{template} · zone {zone}', { template: template.name, zone: itemZone?.name ?? '—' })}</span>
              </header>
              <div className="opx-edit" style={{ gridTemplateColumns: hasData ? `${layout.fields}% 1px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}>
                <div className="opx-fields-col">
                  <div className="opx-fields">
                    <ValuesPane template={template} draft={draft} boundDraft={boundDraft} readMode={readMode} sourceName={sourceName} previewData={previewData} fitWarnings={fitWarnings} onDraft={editDraft} />
                    {steppedDatasets(template).map((ds) => (
                      <DataSetHand key={ds.key} ds={ds} template={template} draft={draft} onAir={onAirByItem.get(item.id)} operate={operate} zone={itemZone?.id} onDraft={editDraft} command={command} />
                    ))}
                  </div>
                  <footer className="opx-fields-foot">
                    <UpdateMode value={updateFade} onChange={setUpdateFade} disabled={!operate} />
                    <button
                      className="opx-btn violet"
                      disabled={!operate || !onAirByItem.get(item.id)}
                      title={onAirByItem.get(item.id) ? t(updateFade ? 'Send these values to the graphic on air (cross-fade)' : 'Send these values to the graphic on air (cut)') : t('Not on air: the values go with the take')}
                      onClick={() => command({ action: 'update', zone: itemZone?.id, data: updateData(template, draft, readMode), fade: updateFade })}
                    >
                      <RefreshCw size={13} /> Update
                    </button>
                  </footer>
                </div>
                {hasData && (
                  <>
                    <div
                      className="opx-vgap"
                      title={t('Drag to resize · double-click: half and half')}
                      onDoubleClick={() => setLayout('fields', 50)}
                      onPointerDown={(e) => {
                        const box = e.currentTarget.parentElement!.getBoundingClientRect();
                        const move = (ev: PointerEvent) => setLayout('fields', Math.round(Math.max(25, Math.min(75, ((ev.clientX - box.left) / box.width) * 100))));
                        const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
                        window.addEventListener('pointermove', move);
                        window.addEventListener('pointerup', up);
                      }}
                    />
                    <DataBlock project={project} template={template} item={item} draft={draft} canEdit={canEdit} onRead={(patch) => editDraft(patch)} onMode={(m) => setItem(item.id, { read: m === 'live' ? undefined : m })}>
                      {usedDatasets(template).map((ds) =>
                        datasetUse(template, ds).source ? (
                          <DataSetSource key={ds.key} ds={ds} template={template} draft={draft} onAir={onAirByItem.get(item.id)} operate={operate} sourceName={sourceName(ds.source)} onDraft={editDraft} />
                        ) : (
                          <DataSetPanel key={ds.key} ds={ds} template={template} draft={draft} onAir={onAirByItem.get(item.id)} operate={operate} zone={itemZone?.id} fps={fps} onDraft={editDraft} command={command} keys={ds === steppedDatasets(template)[0]} />
                        ),
                      )}
                    </DataBlock>
                  </>
                )}
              </div>
            </>
          ) : (
            <p className="opx-hint pad">{t('Select a graphic in the playlist.')}</p>
          )}
        </section>
      </div>

      <Splitter axis="x" className="opx-gap" sign={-1} value={layout.right} min={320} max={760} reset={480} onChange={(v) => setLayout('right', v)} />

      {/* Right: on air, then the internal controls of the graphics on air. */}
      <div className="opx-col">
        <section className="opx-pane" style={{ height: layout.air, flex: 'none' }}>
          <header className="opx-head">
            <span className={`opx-title ${busy.length ? 'live' : ''}`}>● {t('On air')}</span>
            <OutputSelect channelId={channelId} />
          </header>
          <div className="opx-pics">
            {pictures.map((p) => {
              const ok = designed(p.width, p.height);
              const on = ok && (shown.includes(p.id) || (!visible.length && p === pictures[0]));
              return (
                <button key={p.id} className={on ? 'on' : ''} disabled={!ok} title={ok ? `${p.width}×${p.height}` : t('{size}: not designed in this project (add the format in the Designer)', { size: `${p.width}×${p.height}` })} onClick={() => setShown(on ? shown.filter((x) => x !== p.id) : [...shown, p.id])}>
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
              <p className="opx-hint pad">{t('No output: choose one above to take graphics on air. You can still prepare the playlists.')}</p>
            )}
          </div>
          <div className={`opx-strip ${busy.length ? 'live' : ''}`}>{!channelId ? t('No output') : busy.length ? t('Live · {n} on screen', { n: busy.length }) : t('Off air')}</div>
        </section>
        <Splitter axis="y" className="opx-gap" value={layout.air} min={160} max={800} reset={330} onChange={(v) => setLayout('air', v)} />
        <section className="opx-pane grow">
          <header className="opx-head opx-tabs">
            {busy.length ? (
              busy.map((z) => {
                const p = channel.layers[String(z.layer)];
                return (
                  <button key={z.id} className={z.id === selZone?.id ? 'on' : ''} onClick={() => setAirSel(z.id)}>
                    {rundownName(project, p.rundownId) ?? project.templates.find((t) => t.id === p.templateId)?.name ?? t('Deleted graphic')}
                  </button>
                );
              })
            ) : (
              <span className="opx-title">{t('Controls')}</span>
            )}
          </header>
          {selItem && selZone ? <AirControls project={project} zone={selZone} item={selItem} command={command} nextRowOf={(key) => nextRowOf(selItem, key)} /> : <p className="opx-hint pad">{t('Nothing on air.')}</p>}
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
      <span className="muted small">{tn(count, '{n} item', '{n} items')}</span>
      {editable && (
        <span className="opx-more" onClick={(e) => e.stopPropagation()}>
          <button className="opx-x" onClick={() => setMenu(!menu)} title={t('More')}>
            <MoreHorizontal size={14} />
          </button>
          {menu && (
            <div className="popover" onMouseLeave={() => setMenu(false)}>
              <button
                onClick={async () => {
                  setMenu(false);
                  const name = await promptDialog({ title: t('Rename the playlist'), label: t('Name'), value: p.name, confirm: t('Rename') });
                  if (name) save(project.playlists.map((x) => (x.id === id ? { ...x, name } : x)));
                }}
              >
                {t('Rename…')}
              </button>
              {project.playlists.length > 1 && (
                <button
                  onClick={async () => {
                    setMenu(false);
                    const other = project.playlists.find((x) => x.id !== id)!;
                    if (await confirmDialog({ title: t('Remove the playlist “{name}”?', { name: p.name }), message: tn(count, 'Its {n} graphic moves to “{name}”.', 'Its {n} graphics move to “{name}”.', { name: other.name }), confirm: t('Remove'), danger: true })) save(project.playlists.filter((x) => x.id !== id));
                  }}
                >
                  {t('Remove…')}
                </button>
              )}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * The left part of a graphic: its values (texts, pictures… and what the Texts
 * fed by a data set show), then the properties exposed in the Designer, layer
 * by layer, with the Designer's controls and sections.
 */
function ValuesPane({ template, draft, boundDraft, readMode, sourceName, previewData, fitWarnings, onDraft }: { template: Template; draft: Record<string, string>; boundDraft: Record<string, string>; readMode: ReadMode; sourceName: (id: string) => string; previewData: Record<string, string>; fitWarnings: TextWarning[]; onDraft: (patch: Record<string, string>) => void }) {
  const { content, layers } = useMemo(() => exposedFields(template.fields, template.layers), [template.fields, template.layers]);
  const live = (f: Field) => !!f.binding?.source && readMode !== 'manual';
  const io: FieldIO = {
    value: (f) => draft[f.key] ?? '',
    set: (f, v) => onDraft({ [f.key]: v }),
    fed: (f) => (live(f) ? (boundDraft[f.key] ?? draft[f.key] ?? '…') : null),
  };
  // The Texts a data set feeds (it is only their source): what they show, read only.
  const fed: { layer: Layer; title: string }[] = [];
  for (const ds of usedDatasets(template)) {
    const use = datasetUse(template, ds);
    if (!use.source) continue;
    const row = Math.max(1, parseInt(draft[rowKey(ds.key)] ?? '1', 10) || 1);
    const one = draft[oneKey(ds.key)] === '1';
    for (const l of use.texts) {
      if (fed.some((x) => x.layer.id === l.id)) continue;
      // All the rows (a line each), unless the operator keeps only the chosen one.
      const all = l.type === 'text' && l.text.includes(`{{${linesKey(ds.key)}}}`) && !one;
      fed.push({ layer: l, title: all ? t('From {dataset}: all the rows', { dataset: ds.name }) : t('From {dataset}: row {row}', { dataset: ds.name, row }) });
    }
  }
  const fedIds = new Set(fed.map((x) => x.layer.id));
  const keys = new Set(template.fields.map((f) => f.key));
  return (
    <>
      {(content.length > 0 || fed.length > 0) && (
        <OpSection title={t('Content')}>
          {(() => {
            // The Texts fed by a data set with the plain values, before the values grouped by layer.
            const groups = fieldGroups(content);
            if (fed.length && !groups.some((g) => !g.title)) groups.unshift({ title: '', fields: [] });
            return groups.map((g) => (
              <div key={g.title} className="opx-group">
                {g.title && <div className="opx-sub">{g.title}</div>}
                {g.fields.map(({ f, label }) => (
                  <div key={f.key}>
                    <Row label={f.kind === 'table' ? undefined : label}>
                      {live(f) ? (
                        <span className="opx-bound" title={t(readMode === 'live' ? '{binding} · {source}, read live' : '{binding} · {source}, read on take', { binding: bindingLabel(f.binding!), source: sourceName(f.binding!.source) })}>
                          {boundDraft[f.key] ?? draft[f.key] ?? '…'}
                        </span>
                      ) : (
                        <FieldInput field={f} value={draft[f.key] ?? ''} rich={richField(template, f.key)} onChange={(v) => onDraft({ [f.key]: v })} />
                      )}
                    </Row>
                    {fitWarnings
                      .filter((w) => w.keys.includes(f.key) && !fedIds.has(w.layer.id))
                      .map((w) => (
                        <FitWarning key={w.layer.id} w={w} />
                      ))}
                  </div>
                ))}
                {!g.title &&
                  fed.map(({ layer, title }) => (
                    <FedText key={layer.id} label={layer.name} value={layer.type === 'text' ? shownText(layer, previewData) : ''} title={title}>
                      {fitWarnings
                        .filter((w) => w.layer.id === layer.id)
                        .map((w) => (
                          <FitWarning key={w.layer.id} w={w} />
                        ))}
                    </FedText>
                  ))}
              </div>
            ));
          })()}
        </OpSection>
      )}
      {layers.map((e) => (
        <LayerProperties key={e.layer.id} entry={e} io={io} />
      ))}
      {fitWarnings
        .filter((w) => !fedIds.has(w.layer.id) && !w.keys.some((k) => keys.has(k)))
        .map((w) => (
          <FitWarning key={w.layer.id} w={w} named />
        ))}
    </>
  );
}

/** A text too long for its box: reduced, or not all shown. */
function FitWarning({ w, named }: { w: TextWarning; named?: boolean }) {
  const pct = `${Math.round(w.ratio * 100)} %`;
  const mode = w.layer.overflow ?? 'fit';
  return (
    <span className={`opx-fit ${w.overflows ? 'bad' : ''}`} title={t('The text does not fit its box as designed')}>
      {named && <strong>{t('{name}:', { name: w.layer.name })}</strong>}
      {!w.overflows ? t('text reduced to {pct}', { pct }) : mode === 'fit' ? t('too long: cut even when reduced — shorten it') : mode === 'ellipsis' ? t('too long: shown with “…”') : t('too long: cut on air')}
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
    <span className={`opx-mtl ${air ? 'air' : ''}`} title={air ? t(PHASE_TITLES[air.phase]) : t('In · on air · out')}>
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
  /** NEXT takes this one. */
  cue: boolean;
  operate: boolean;
  editable: boolean;
  onSelect: () => void;
  onTake: () => void;
  onOut: () => void;
  onRename: (name: string) => void;
  /** The playlist goes on by itself: show and set this graphic's time. */
  autoNext: boolean;
  onAuto: (patch: Partial<RundownItem>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  drag: { over: 'before' | 'after' | null; onStart: (e: React.DragEvent) => void; onOver: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void; onEnd: () => void };
}) {
  const { project, item, zone, air } = props;
  const tpl = project.templates.find((x) => x.id === item.templateId);
  const paused = air && isPaused(air, project);
  const [renaming, setRenaming] = useState(false);
  const [autoAt, setAutoAt] = useState<DOMRect | null>(null);
  return (
    <div className={`opx-gr ${props.selected ? 'on' : ''} ${props.cue ? 'cue' : ''} ${air ? 'air' : ''} ${props.drag.over ? `drop-${props.drag.over}` : ''}`} onClick={props.onSelect} onDragOver={props.drag.onOver} onDrop={props.drag.onDrop}>
      {props.editable && (
        <span className="opx-grip" draggable onDragStart={props.drag.onStart} onDragEnd={props.drag.onEnd} title={t('Drag to reorder')} onClick={(e) => e.stopPropagation()}>
          <GripVertical size={14} />
        </span>
      )}
      <button
        className={`opx-sq big ${air ? (paused ? 'amber' : 'red') : ''}`}
        disabled={!props.operate}
        title={air ? t('Take out') : t('Take')}
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
          <strong title={props.editable ? t('Double-click to rename') : undefined} onDoubleClick={(e) => (e.stopPropagation(), props.editable && setRenaming(true))}>
            {item.name}
          </strong>
        )}
        <span className="muted small">
          {props.cue && <b className="opx-cue" title={t('NEXT takes this graphic')}>CUE</b>}
          <span className="opx-dot" style={{ background: zone?.color ?? '#6b7090' }} /> {zone?.name ?? t('no zone')} · {tpl?.name ?? t('missing template')}
          {props.autoNext && item.autoSecs !== undefined && <span className="opx-auto"> · {t('next {n} s', { n: item.autoSecs })}</span>}
          {item.hold && <span className="opx-hold"> · {t('hold')}</span>}
        </span>
        <MiniTimeline template={tpl} air={air} />
      </span>
      {props.editable && (
        <span className="opx-acts" onClick={(e) => e.stopPropagation()}>
          <button title={t('Auto next of this graphic: its time on air, hold anyway')} className={item.autoSecs !== undefined || item.hold ? 'on' : ''} onClick={(e) => setAutoAt(autoAt ? null : e.currentTarget.getBoundingClientRect())}>
            <Timer size={13} />
          </button>
          <button title={t('Duplicate')} onClick={props.onDuplicate}>
            <Copy size={13} />
          </button>
          <button className="red" title={t('Remove')} onClick={props.onDelete}>
            <Trash2 size={13} />
          </button>
        </span>
      )}
      {autoAt && <AutoNextEditor item={item} at={autoAt} onChange={props.onAuto} onClose={() => setAutoAt(null)} />}
    </div>
  );
}

/** Auto next settings of one graphic: its time on air before the next one, hold anyway. */
function AutoNextEditor({ item, at, onChange, onClose }: { item: RundownItem; at: DOMRect; onChange: (patch: Partial<RundownItem>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const auto = item.autoSecs !== undefined;
  return createPortal(
    <div ref={ref} className="menu marker-editor" style={{ position: 'fixed', left: Math.max(8, at.left - 240), top: at.bottom + 6 }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <header>
        <Timer size={13} />
        <strong>{item.name}</strong>
        <div className="spacer" />
        <button className="icon-btn ghost" title={t('Close')} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="me-field">
        <span>{t('Next')}</span>
        <div className="seg">
          <button className={!auto ? 'on' : ''} title={t('The operator takes the next graphic')} onClick={() => onChange({ autoSecs: undefined })}>
            {t('Operator')}
          </button>
          <button className={auto ? 'on' : ''} title={t('The next graphic is taken after this time on air')} onClick={() => onChange({ autoSecs: item.autoSecs ?? 10 })}>
            {t('After')}
          </button>
        </div>
      </div>
      {auto && (
        <label className="me-field">
          <span>{t('On air for')}</span>
          <NumberField value={item.autoSecs ?? 10} min={0} step={1} suffix="s" onChange={(v) => onChange({ autoSecs: Math.max(0, v) })} />
        </label>
      )}
      <div className="me-field">
        <span>{t('Hold anyway')}</span>
        <button className={`wk-tog ${item.hold ? 'on' : ''}`} title={t('Stays on air when the next graphic is taken')} onClick={() => onChange({ hold: !item.hold || undefined })}>
          <i />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** Sources the graphic reads, when it reads them, and Read now. */
function DataBlock({ template, item, draft, canEdit, onRead, onMode, children }: { children?: React.ReactNode; project: Project; template: Template; item: RundownItem; draft: Record<string, string>; canEdit: boolean; onRead: (patch: Record<string, string>) => void; onMode: (m: ReadMode) => void }) {
  const all = useSources();
  const auth = useApp((s) => s.auth);
  const toast = useApp((s) => s.toast);
  const bound = template.fields.filter((f) => f.binding?.source);
  const used = [...new Set(bound.map((f) => f.binding!.source))].map((id) => all.find((s) => s.id === id) ?? { id, name: id, interval: 0, updatedAt: null, error: t('not found') });
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
    toast(tn(Object.keys(patch).length, '{n} value read', '{n} values read'), 'info');
  };
  const ago = (at?: number | null) => {
    if (!at) return t('never read');
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 60 ? t('read {n} s ago', { n: s }) : t('read {n} min ago', { n: Math.round(s / 60) });
  };
  return (
    <div className="opx-data">
      <div className="opx-data-title">{t('Data')}</div>
      {children}
      {!used.length ? (
        !usedDatasets(template).length && <p className="opx-hint">{t('No data source: the operator types the values. Link a variable to a source in the Designer (Data canvas).')}</p>
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
            <span className="opx-label">{t('Read the data')}</span>
            <div className="opx-seg">
              {READ_MODES.map((m) => (
                <button key={m.id} className={mode === m.id ? 'on' : ''} disabled={!canEdit} title={t(m.hint)} onClick={() => onMode(m.id)}>
                  {t(m.label)}
                </button>
              ))}
            </div>
          </div>
          {mode === 'live' && (
            <div className="opx-every">
              {used.map((s) => (
                <label key={s.id}>
                  <span className="muted small">{t('{name} checked every', { name: s.name })}</span>
                  <select
                    value={s.interval}
                    disabled={!can.design(auth?.user) || !('type' in s)}
                    title={can.design(auth?.user) ? t('How often the server reads the source (for every graphic using it)') : t('Set by a designer in Data')}
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
            <span className="opx-label">{t('Fields fed by the sources')}</span>
            {bound.map((f) => (
              <div key={f.key} className="opx-map">
                <span>{f.label}</span>
                <code>{bindingLabel(f.binding!)}</code>
              </div>
            ))}
          </div>
          {mode !== 'live' && (
            <button className="opx-btn" disabled={reading || !canEdit} onClick={readNow} title={mode === 'manual' ? t('Read the sources now and keep the values in this item') : t('Read now to check; the take reads again')}>
              <RefreshCw size={13} /> {reading ? t('Reading…') : t('Read now')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Internal controls of one graphic on air: widgets, number values, triggers, continue / update / out. */
/** Operator controls of a spec widget of the graphic on air (web/src/widgets). */
function SpecControls({ layer, item, act, fps }: { layer: Layer; item: PlayoutItem; act: (op: string, args?: unknown) => void; fps: number }) {
  const def = widgetOf(layer.type)!;
  const Op = def.Operator;
  const offset = useApp((s) => s.serverOffset);
  const tz = useApp((s) => s.timezone);
  const state = item.widgets?.[layer.id];
  const warnings = (def.warnings?.(layer as never, { data: item.data, state }) ?? []).filter((w) => w.op);
  const Icon = def.icon;
  // A widget without controls shows only its alerts for the Operator.
  if (!Op && !warnings.length) return null;
  return (
    <div className="opx-spec">
      <div className="opx-spec-head">
        <Icon size={13} />
        <strong>{layer.name}</strong>
        <span className="muted small">{t(def.label)}</span>
      </div>
      <Warnings list={warnings} />
      {Op && <Op layer={layer as never} state={state} data={item.data} act={act} item={item} time={{ nowMs: Date.now() + offset, ageSecs: (item.age ?? 0) / fps, defaultTz: tz, fps }} />}
    </div>
  );
}

/** The templates the operator can add to the rundown: searchable cards with their picture, by zone. */
function AddGraphic({ project, templates, used, onPick, onClose }: { project: Project; templates: Template[]; used: (id: string) => number; onPick: (t: Template) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.opx-add') && onClose();
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [onClose]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const zoneOf = (t: Template) => project.zones.find((z) => z.id === t.zone);
  const list = templates.filter((t) => words.every((w) => `${t.name} ${zoneOf(t)?.name ?? ''}`.toLowerCase().includes(w)));
  // By zone, in the zones' order.
  const groups = [...project.zones.map((z) => ({ zone: z as Zone | undefined, list: list.filter((t) => t.zone === z.id) })), { zone: undefined, list: list.filter((t) => !zoneOf(t)) }].filter((g) => g.list.length);
  const fps = project.frameRate.num / project.frameRate.den || 25;
  const secs = (f: number) => `${+(f / fps).toFixed(1)} s`;
  return (
    <div className="opx-addpanel" ref={ref} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="opx-addsearch">
        <input
          autoFocus
          placeholder={templates.length > 1 ? t('Search {n} graphics…', { n: templates.length }) : t('Search a graphic…')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) onPick(list[0]);
          }}
        />
        <button className="icon-btn ghost" title={t('Close (Esc)')} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="opx-addbody">
        {groups.map((g) => (
          <section key={g.zone?.id ?? '-'}>
            <h4>
              <span className="opx-dot" style={{ background: g.zone?.color ?? '#6b7090' }} /> {g.zone?.name ?? t('No zone')}
              <em>{g.list.length}</em>
            </h4>
            <div className="opx-addgrid">
              {g.list.map((tpl) => {
                const n = used(tpl.id);
                return (
                  <button key={tpl.id} className="opx-addcard" title={t('Add “{name}” to the rundown', { name: tpl.name })} onClick={() => onPick(tpl)}>
                    <span className="opx-addpic" style={{ aspectRatio: `${project.width} / ${project.height}` }}>
                      <img src={thumbnailUrl(project.id, tpl)} alt="" loading="lazy" draggable={false} />
                      {n > 0 && <i title={t('Already {n}× in this playlist', { n })}>×{n}</i>}
                    </span>
                    <strong>{tpl.name}</strong>
                    <span className="muted small">
                      {secs(tpl.duration)}
                      {tpl.fields.length ? ` · ${tn(tpl.fields.length, '{n} field', '{n} fields')}` : ''}
                      {usedDatasets(tpl).length ? ` · ${t('data set')}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {!groups.length && <p className="opx-hint pad">{templates.length ? t('No graphic matches.') : t('No graphic published yet: publish templates from the Designer.')}</p>}
      </div>
    </div>
  );
}

/** How Update changes the values on air: a cross-fade or a cut (kept in this browser). */
function UpdateMode({ value, onChange, disabled }: { value: boolean; onChange: (fade: boolean) => void; disabled: boolean }) {
  return (
    <div className="opx-seg opx-upd-mode" title={t('How the values change on air')}>
      <button className={value ? 'on' : ''} disabled={disabled} title={t('The new values cross-fade in (½ s)')} onClick={() => onChange(true)}>
        {t('Fade')}
      </button>
      {/* CUT keeps its broadcast name. */}
      <button className={value ? '' : 'on'} disabled={disabled} title={t('The new values replace the old ones at once')} onClick={() => onChange(false)}>
        Cut
      </button>
    </div>
  );
}

function useUpdateFade(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem('pulse.operator.updateFade') === '1';
    } catch {
      return false;
    }
  });
  const set = (x: boolean) => {
    setV(x);
    try {
      localStorage.setItem('pulse.operator.updateFade', x ? '1' : '0');
    } catch {
      /* private mode */
    }
  };
  return [v, set];
}

function AirControls({ project, zone, item, command, nextRowOf }: { project: Project; zone: Zone; item: PlayoutItem; command: (c: Command) => void; nextRowOf?: (dataset: string) => number | undefined }) {
  const tpl = project.templates.find((x) => x.id === item.templateId);
  const target = { zone: zone.id };
  // Deleted (or unpublished) while on air: it can still be taken out.
  if (!tpl)
    return (
      <div className="opx-controls">
        <div className="opx-actions sticky">
          <button className="opx-btn" onClick={() => command({ action: 'takeOut', ...target })} title="F3">
            <CircleStop size={14} /> Out
          </button>
        </div>
        <p className="opx-hint">{t('This graphic is no longer in the project: take it out.')}</p>
      </div>
    );
  // A Text scrolls by itself: no start / pause for it in the Operator.
  const timed = tpl.layers.filter((l) => isTimed(l) && l.type !== 'text');
  // Pauses waiting for a trigger, and values set by hand until one.
  const triggers = [...new Set([...tpl.markers.flatMap((m) => (m.kind === 'pause' && m.resume?.type === 'trigger' ? [m.resume.name] : [])), ...Object.entries(item.data).flatMap(([k, v]) => (k.endsWith('__manual') && v.startsWith('trigger:') ? [v.slice(8)] : []))])];
  const waiting = pauseOf(item, project);
  return (
    <div className="opx-controls">
      <div className="opx-actions sticky">
        <button className={`opx-btn ${waiting ? 'amber' : ''}`} onClick={() => command({ action: 'continue', ...target })} title={t('F2 / Space')}>
          <ChevronsRight size={14} /> Continue
        </button>
        <button className="opx-btn" onClick={() => command({ action: 'takeOut', ...target })} title="F3">
          <CircleStop size={14} /> Out
        </button>
      </div>
      {!!steppedDatasets(tpl).length && <AirRows sets={steppedDatasets(tpl)} item={item} command={command} zone={zone.id} nextRowOf={nextRowOf} />}
      {tpl.layers
        .filter((l) => l.visible && (widgetOf(l.type)?.Operator || widgetOf(l.type)?.warnings))
        .map((l) => (
          <SpecControls key={l.id} layer={l} item={item} fps={project.frameRate.num / project.frameRate.den || 50} act={(op, args) => command({ action: 'act', target: l.id, op, args, ...target })} />
        ))}
      {timed
        .filter((l) => !widgetOf(l.type)?.Operator)
        .map((l) => {
          const c = item.clocks?.[l.id];
          const running = c ? c.pausedAt == null : !l.manualStart;
          return (
            <div key={l.id} className="opx-widget">
              <button className={`opx-sq ${running ? '' : 'green'}`} title={running ? t('Pause') : tc('action', 'Start')} onClick={() => command({ action: 'widget', target: l.id, control: 'toggle', ...target })}>
                {running ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
              </button>
              <span className="opx-widget-name">
                <strong>{l.name}</strong>
                <span className="muted small">{running ? t('running') : t('stopped')}</span>
              </span>
              <button className="opx-sq" title={t('Back to the start')} onClick={() => command({ action: 'widget', target: l.id, control: running ? 'restart' : 'reset', ...target })}>
                <RotateCcw size={13} />
              </button>
            </div>
          );
        })}
      {triggers.length > 0 && (
        <div className="opx-triggers">
          <span className="opx-label">{t('Triggers')}</span>
          {triggers.map((n) => (
            <button key={n} className={`opx-btn small ${waiting?.resume?.type === 'trigger' && waiting.resume.name === n ? 'amber' : ''}`} onClick={() => command({ action: 'trigger', name: n })} title={t('Every graphic waiting for this trigger plays on')}>
              <Zap size={12} /> {n}
            </button>
          ))}
        </div>
      )}
      {!timed.length && !triggers.length && !steppedDatasets(tpl).length && !tpl.layers.some((l) => widgetOf(l.type)?.Operator) && <p className="opx-hint">{t('This graphic has no internal controls.')}</p>}
    </div>
  );
}

/** The output the operator takes to; another project's output is taken over after a confirmation. */
function OutputSelect({ channelId }: { channelId: string | null }) {
  const { channels, projects, project, live, loadOnChannel } = useApp();
  const projectName = (id?: string | null) => projects.find((p) => p.id === id)?.name ?? t('another project');
  const pick = async (id: string) => {
    if (!project) return;
    if (!id) return navigate(projectPath(project.id, 'operator', 'none'));
    const c = channels.find((x) => x.id === id);
    if (!c) return;
    if (c.projectId !== project.id) {
      const onAir = Object.keys(live[c.id]?.state.layers ?? {}).length;
      if (
        c.projectId &&
        !(await confirmDialog({
          title: t('{channel} is used by “{project}”', { channel: c.name, project: projectName(c.projectId) }),
          message: onAir ? tn(onAir, '{n} graphic is on air there and will be cleared. Load “{name}” on it instead?', '{n} graphics are on air there and will be cleared. Load “{name}” on it instead?', { name: project.name }) : t('Load “{name}” on it instead?', { name: project.name }),
          confirm: t('Load here'),
          danger: onAir > 0,
        }))
      )
        return;
      await loadOnChannel(c.id, project.id);
    }
    navigate(projectPath(project.id, 'operator', c.id));
  };
  const own = channels.filter((c) => c.projectId === project?.id);
  const free = channels.filter((c) => !c.projectId);
  const other = channels.filter((c) => c.projectId && c.projectId !== project?.id);
  return (
    <select className="opx-output" value={channelId ?? ''} onChange={(e) => void pick(e.target.value)} title={t('Output')}>
      <option value="">{t('No output (preview only)')}</option>
      {own.length > 0 && (
        <optgroup label={t('This project')}>
          {own.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )}
      {free.length > 0 && (
        <optgroup label={tc('channels', 'Free')}>
          {free.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )}
      {other.length > 0 && (
        <optgroup label={t('Used by another project')}>
          {other.map((c) => (
            <option key={c.id} value={c.id}>
              {t('{channel} — used by “{project}”', { channel: c.name, project: projectName(c.projectId) })}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
