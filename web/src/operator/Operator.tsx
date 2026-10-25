import { RichInput } from '../ui/RichText';
import { plain, richField } from '../engine/rich';
import { AssetPicker } from '../designer/AssetPicker';
import { ChevronsRight, CircleStop, Copy, Database, Layers, Lock, MoreHorizontal, Pause, PenLine, Pencil, Play, Plus, RefreshCw, Repeat, RotateCcw, SkipForward, Square, Timer, Trash2, Type, Undo2, X, Zap, GripVertical } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { createPortal } from 'react-dom';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Scene, Viewport } from '../engine/Scene';
import { defaultData, holdFrame, interpolateText, newId, parseHex, toHex } from '../engine/evaluate';
import { oneKey, rowKey, usedDatasets, type Command, type Field, type Layer, type Marker, type Phase, type PlayoutItem, type Playlist, type Project, type ReadMode, type RundownItem, type Template, type Zone } from '../engine/types';
import { isTimed, layerAgeFrames } from '../engine/widgets';
import { widgetOf } from '../widgets';
import { CentreModeContext } from '../widgets/kit';
import { Centre, OperatorBound, StartStatus } from '../widgets/centre';
import { LiveTime, useTicker } from '../engine/LiveTime';
import { formatFor, inFormat, projectFormats } from '../engine/formats';
import { api, can, thumbnailUrl, useApp, type Live } from '../store';
import { Program } from '../output/Program';
import { ColorField, NumberField, Segmented, TextInput } from '../ui/fields';
import { KeyScope, Row } from '../widgets/kit';
import { AirRows, DataSetHand, DataSetPanel, DataSetSource, datasetUse, manualKey, shownData, sourcePatch, steppedDatasets } from './DataSets';
import { changedKeys, hasControls, heldAt, newPreviewRun, partKeys, PreviewControls, widgetParts, widgetWaits, type PreviewRun, type WidgetPart } from './WidgetTabs';
import { FedText, LayerProperties, OpSection, type ExposedLayer, type FieldIO } from './Exposed';
import { maxChars, shownText } from '../widgets/text';
import { bindingLabel, readBinding, useBoundData, useSources } from '../data/dataStore';
import { DataWarning } from './DataWarning';
import { navigate, projectPath } from '../router';
import { areaClip, zoneArea } from '../engine/zones';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { TableRowsField } from './TableRowsField';
import { Splitter, useLayout } from '../ui/Splitter';
import { t, tc, tn } from '../i18n';
import { LockedBy, useZoneLocks, ZoneBar } from './ZoneBar';
import { OperatorTop } from './Presence';
import { requestUndo, UndoHistory, UndoShortcut } from './UndoToast';
import { KeyCap, openShortcuts } from './ShortcutsOverlay';
import { ScheduleCell, ScheduleTop, toggleScheduleList } from './Schedule';
import { actionLabel, useShortcuts } from './shortcuts';
import type { ZoneLock } from '../store';

/*
 * Operator page, four areas (each resizable):
 *   left    playlists, and the graphics of the playlist with take / out
 *   center  the preview of the selected graphic, and its variables and data
 *   right   what is on air (the output's pictures), and the internal
 *           controls of the graphics on air (widgets, values, triggers)
 */

/** The control of an exposed value, as in the Designer (text, choices, number, colour, picture, on / off). */
export function FieldInput({ field, value, onChange, rich, maxLength }: { field: Field; value: string; onChange: (v: string) => void; rich?: boolean; /** Most characters (a Text's « Max characters »). */ maxLength?: number }) {
  // A text the operator can style (bold, colour…: it is only shown in Texts).
  if (rich) return <RichInput multiline={field.kind === 'multiline'} value={value} onChange={onChange} maxLength={maxLength} />;
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
      return <TextInput multiline value={value} onChange={onChange} maxLength={maxLength} />;
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
      return <TableRowsField value={value} onChange={onChange} />;
    default:
      return <TextInput value={value} onChange={onChange} maxLength={maxLength} />;
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
  // Typed by hand over the data (`<key>__manual`): sent, and its mark too (empty: back to the data).
  const byHand = (k: string) => !!draft[manualKey(k)]?.trim() || k.endsWith('__manual');
  const bound = new Set(read === 'manual' ? [] : t.fields.filter((f) => f.binding?.source && !byHand(f.key)).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...defaultData(t), ...draft })) {
    if (bound.has(k) || (!sent.has(k) && !byHand(k) && ds.some((d) => k.startsWith(`${d}__`)))) continue;
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

/** The first text typed for a graphic (a person's name…): the item's name follows it. */
const firstText = (t: Template) => t.fields.find((f) => (f.kind === 'text' || f.kind === 'multiline') && !f.options?.length && !f.binding?.source);
const firstLine = (v: string | undefined) => plain(v ?? '').split('\n')[0].trim();

/**
 * The item's new name when its first text changes, as long as the name was
 * that text (or the template's name): renamed by hand, it stays. `pendingName`:
 * a new name not saved yet.
 */
function followName(t: Template, name: string, pendingName: string | undefined, before: Record<string, string>, next: Record<string, string>): string | undefined {
  const f = firstText(t);
  if (!f || before[f.key] === next[f.key]) return undefined;
  const current = (pendingName ?? name).trim();
  if (current && current !== firstLine(before[f.key]) && current !== t.name) return undefined;
  const v = firstLine(next[f.key]);
  return v || t.name;
}

/** The tab id of the fields that belong to no widget layer (texts, exposed shape settings). */
const SHARED_TAB = '__texts__';

/** The pause marker the graphic holds on, if it holds on a pause (not on the On air point). */
function pauseOf(p: PlayoutItem, project: Project): Marker | undefined {
  if (p.phase !== 'holding' && p.phase !== 'outHold') return undefined;
  const t = project.templates.find((x) => x.id === p.templateId);
  return t?.markers.find((m) => m.kind === 'pause' && Math.abs(m.frame - p.frame) < 0.5);
}

/** Continue would move it on: a widget waits for it (its next page, its start), or the graphic is held on a pause, playing towards one, or paused while going out (as the server's `resume`, crates/cg-core/src/playout.rs). */
function canContinue(p: PlayoutItem, t: Template | undefined): boolean {
  if (!t || p.phase === 'out') return false;
  if (widgetWaits(t.layers, p)) return true;
  if (p.phase === 'outHold') return true;
  return Math.max(p.target, p.frame) < holdFrame(t) - 1e-6;
}

/** What a graphic on air does by itself, the soonest: a timed pause plays on, it goes out (IN/OUT marker after a delay), or auto next takes the next graphic. `at`: client time (ms); `secs`: the whole delay. As the server, the time counts from the stop it holds at. */
interface AutoStep {
  kind: 'resume' | 'out' | 'next';
  at: number;
  secs: number;
}
function autoStep(project: Project, p: PlayoutItem & { advanced?: boolean }, liveAt: number): AutoStep | null {
  if (p.phase !== 'holding') return null;
  const t = project.templates.find((x) => x.id === p.templateId);
  if (!t) return null;
  const fps = project.frameRate.num / project.frameRate.den || 1;
  const step = (kind: AutoStep['kind'], secs: number): AutoStep => ({ kind, secs: Math.max(0, secs), at: liveAt + (Math.max(0, secs) - (p.held ?? 0) / fps) * 1000 });
  const pause = pauseOf(p, project);
  if (pause) return pause.resume?.type === 'after' ? step('resume', pause.resume.seconds) : null;
  if (p.frame < holdFrame(t) - 1e-6) return null;
  const steps: AutoStep[] = [];
  const out = t.markers.find((m) => m.kind === 'out');
  if (out?.resume?.type === 'after') steps.push(step('out', out.resume.seconds));
  const r = p.rundownId ? project.rundown.find((x) => x.id === p.rundownId) : undefined;
  if (!p.advanced && r?.autoSecs !== undefined && project.playlists.some((x) => x.id === r.playlist && x.autoNext)) steps.push(step('next', r.autoSecs));
  return steps.sort((a, b) => a.at - b.at)[0] ?? null;
}

/** Seconds left before an automatic step, ticking. */
function useLeft(step: AutoStep | null): number {
  const now = useTicker(!!step, 10);
  return step ? Math.max(0, (step.at - now) / 1000) : 0;
}

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
/** Auto next of a new graphic: the next one after this time on air. */
const AUTO_SECS = 5;

/** Tooltip of the mini timeline of a graphic on air, by phase (translated where shown). */
const PHASE_TITLES: Record<Phase, string> = {
  playing: 'On air · playing',
  holding: 'On air · holding',
  out: 'On air · out',
  outHold: 'On air · outHold',
};

export function Operator({ channelId }: { channelId: string | null }) {
  const { project, command: send, saveRundown, auth, channels, toast } = useApp(useShallow((s) => ({ project: s.project, command: s.command, saveRundown: s.saveRundown, auth: s.auth, channels: s.channels, toast: s.toast })));
  const allSources = useSources();
  const sourceName = (id: string) => allSources.find((s) => s.id === id)?.name ?? id;
  const liveState = useApp((s) => (channelId ? s.live[channelId] : undefined));
  const channel = liveState?.state ?? { layers: {} };
  // Editing the rundown needs the rights; going on air also needs an output.
  const canEdit = can.operate(auth?.user);
  const operate = canEdit && !!channelId;
  const command: typeof send = (cmd) => {
    if (!operate) return;
    const go = () => send(cmd, channelId!);
    // A new name on its way: saved first, so the action (and the as-run) has it.
    if (pending.current?.name !== undefined) void flush().then(go);
    else go();
  };
  const [layout, setLayout] = useLayout('pulse.operatorLayout', { left: 340, right: 480, preview: 400, air: 330, lists: 200, fields: 50 });
  const [cued, setCued] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [updateFade, setUpdateFade] = useUpdateFade();
  // The widget tab shown, by rundown item; what the preview's controls changed.
  const [tabOf, setTabOf] = useState<Record<string, string>>({});
  // Every widget's content and data together, or a tab each (default).
  const [merged, setMerged] = useState(() => {
    try {
      return localStorage.getItem('strata.opMerged') === '1';
    } catch {
      return false;
    }
  });
  const toggleMerged = () =>
    setMerged((m) => {
      try {
        localStorage.setItem('strata.opMerged', m ? '' : '1');
      } catch {
        /* private mode */
      }
      return !m;
    });
  const [pv, setPv] = useState<PreviewRun>(newPreviewRun);
  const [adding, setAdding] = useState(false);
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [shown, setShown] = useState<string[]>(['main']);
  // The widget of a graphic on air whose keys are on (`zone:layer`, a click on its row), and the ⋯ unfolded.
  const [airWidget, setAirWidget] = useState<string | null>(null);
  const [airMore, setAirMore] = useState<Record<string, boolean>>({});
  // Reordering the graphics by dragging their grip.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; where: 'before' | 'after' } | null>(null);
  const original = useRef<{ id: string; data: Record<string, string> } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const channelInfo = channels.find((c) => c.id === channelId);
  // Zones held by other operators: their graphics are locked here.
  const zoneLocks = useZoneLocks(channelId, project);

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
  const pending = useRef<{ id: string; data: Record<string, string>; name?: string } | null>(null);
  useEffect(() => {
    if (!item || !template) return;
    const fresh = { ...defaultData(template), ...item.data };
    draftRef.current = fresh;
    setDraft(fresh);
    original.current = { id: item.id, data: structuredClone(item.data) };
    setPv(newPreviewRun());
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
  // Kept while nothing changes: the preview is not drawn again for nothing.
  const previewData = useMemo(() => ({ ...(template ? defaultData(template) : {}), ...draft, ...boundDraft }), [template, draft, boundDraft]);

  /** Saves the item's data a moment after the last edit. */
  const flush = async () => {
    clearTimeout(saveTimer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const cur = useApp.getState().project?.rundown ?? [];
    await saveRundown(cur.map((r) => (r.id === p.id ? { ...r, data: p.data, ...(p.name !== undefined ? { name: p.name } : {}) } : r)));
  };
  const saveData = (id: string, data: Record<string, string>, name?: string) => {
    // Another item's edit still on its way: saved now, not dropped.
    if (pending.current && pending.current.id !== id) void flush();
    pending.current = { id, data, name: name ?? (pending.current?.id === id ? pending.current.name : undefined) };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 500);
  };
  const editDraft = (patch: Record<string, string>) => {
    if (!item) return;
    // From the latest draft: two edits in the same moment both count.
    const before = draftRef.current;
    const next = { ...before, ...patch };
    draftRef.current = next;
    setDraft(next);
    saveData(item.id, next, template ? followName(template, item.name, pending.current?.id === item.id ? pending.current.name : undefined, before, next) : undefined);
  };
  const setItem = (id: string, patch: Partial<RundownItem>) => {
    // Renamed by hand: the name no longer follows the first text.
    if (patch.name !== undefined && pending.current?.id === id) pending.current.name = undefined;
    return saveRundown(rundown.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

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
  const continueZone = (z: Zone | undefined) => z && command({ action: 'continue', zone: z.id });

  // On air, front-most zone first; the internal controls show one of them.
  const zones = useMemo(() => [...(project?.zones ?? [])].sort((a, b) => b.layer - a.layer), [project?.zones]);
  const busy = zones.filter((z) => channel.layers[String(z.layer)]);
  // CONTINUE / OUT drive the front-most graphic on air.
  const selZone = busy[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key the selected widget on air took (its own shortcuts) is not the Operator's.
      if (e.defaultPrevented || (e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'Escape' && airWidget) (e.preventDefault(), setAirWidget(null));
      // « ? »: the keyboard shortcuts (not over a dialog).
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector('.modal-back')) (e.preventDefault(), openShortcuts());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // The user's keyboard shortcuts (Settings › Shortcuts), through the same functions as the buttons.
  useShortcuts({
    next: take,
    take: () => item && takeItem(item),
    continue: () => continueZone(selZone),
    continueAll: () => busy.forEach(continueZone),
    out: () => outZone(selZone),
    outSelected: () => item && outZone(zoneOf(item)),
    clear: () => command({ action: 'clear' }),
    undo: requestUndo,
    update: () => item && template && onAirByItem.get(item.id) && command({ action: 'update', zone: zoneOf(item)?.id, data: updateData(template, draftRef.current, readMode), fade: updateFade }),
    select: (d) => {
      const i = items.findIndex((r) => r.id === cued) + d;
      if (i >= 0 && i < items.length) setCued(items[i].id);
    },
    takeAt: (n) => items[n - 1] && takeItem(items[n - 1]),
    outZone: (name) => outZone(project?.zones.find((z) => z.name === name) ?? project?.zones.find((z) => z.id === name)),
    trigger: (name) => command({ action: 'trigger', name }),
    schedule: toggleScheduleList,
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
  const lang = project.language || 'fr';
  // The selected graphic widget by widget (a tab each when there are several).
  const parts = template ? widgetParts(template) : { shared: [], widgets: [] };
  // The fields outside the widget layers live in their own tab (Texts) once widgets have tabs.
  const sharedSel = !!item && tabOf[item.id] === SHARED_TAB && parts.shared.length > 0 && parts.widgets.length > 0;
  const part = sharedSel ? undefined : ((item && parts.widgets.find((p) => p.layer.id === tabOf[item.id])) ?? parts.widgets[0]);
  // The widgets shown: the tab's, or all of them together.
  const together = merged && parts.widgets.length > 1;
  const shownParts = together ? parts.widgets : part ? [part] : [];
  const bound = [...new Set(shownParts.flatMap((p) => p.bound))];
  const datasets = [...new Map(shownParts.flatMap((p) => p.datasets).map((d) => [d.key, d])).values()];
  // The data part only when the widgets read data (a source or a data set).
  const hasData = datasets.length > 0 || bound.length > 0;
  // Nothing to type for them (a table fed by a data set…): the data takes the width.
  const showShared = together || sharedSel || parts.widgets.length === 0;
  const hasContent = (showShared && parts.shared.length > 0) || (!part && !sharedSel) || shownParts.some((p) => p.fields.length > 0 || !!p.exposed || p.fed.length > 0);
  // What Update would change on air, by widget.
  const onAirNow = item ? onAirByItem.get(item.id) : undefined;
  const sent = template ? updateData(template, draft, readMode) : {};
  const changed = changedKeys(sent, onAirNow ? shownData(onAirNow) : undefined);
  const partChanged = (p: WidgetPart) => !!template && partKeys(template, p).some((k) => changed.has(k));
  const updates = parts.widgets.filter(partChanged).length + (parts.shared.some((f) => changed.has(f.key)) ? 1 : 0) || (changed.size ? 1 : 0);
  const pvHold = template ? holdFrame(template) / fps : 0;
  const pvAge = () => pvHold + (pv.active ? Math.max(0, Date.now() - pv.since) / 1000 : 0);
  const setRun = (f: (r: PreviewRun) => PreviewRun) => setPv((r) => f(r.active ? r : { ...r, active: true, since: Date.now() }));

  // A graphic of a zone another operator holds: no take, out or update here.
  const lockOf = (r: RundownItem | null | undefined) => (r && channelId ? zoneLocks.other(zoneOf(r)?.id) : undefined);
  const operateItem = operate && !lockOf(item);

  return (
    <div className="opl-page">
    <OperatorTop channelId={channelId} operate={operate} />
    <ScheduleTop channelId={channelId} project={project} />
    {channelId && <ZoneBar project={project} channelId={channelId} locks={zoneLocks.locks} operate={operate} />}
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
              <PlaylistRow key={p.id} project={project} id={p.id} active={p.id === activeList} editable={canEdit} onSelect={setPlaylistId} />
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
                const it: RundownItem = { id: newId(), name: t.name, templateId: t.id, zone: t.zone, playlist: activeList, layer: z?.layer ?? 0, data: defaultData(t), autoSecs: AUTO_SECS };
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
                liveAt={liveState?.at ?? 0}
                selected={r.id === cued}
                cue={r.id === nextTarget?.id}
                operate={operate && !lockOf(r)}
                lockedBy={lockOf(r)}
                schedule={<ScheduleCell channelId={channelId} project={project} item={r} operate={operate && !lockOf(r)} />}
                editable={canEdit}
                onSelect={() => setCued(r.id)}
                onTake={() => takeItem(r)}
                onOut={() => outZone(zoneOf(r))}
                onContinue={() => continueZone(zoneOf(r))}
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
                  <PreviewScene template={template} format={previewFormat.id} data={previewData} fps={fps} run={pv} lang={lang} />
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
                <span className="muted small opx-head-sub" title={t('{template} · zone {zone}', { template: template.name, zone: itemZone?.name ?? '—' })}>{t('{template} · zone {zone}', { template: template.name, zone: itemZone?.name ?? '—' })}</span>
                <span className="spacer" />
                {onAirNow && (
                  <>
                    <UpdateMode value={updateFade} onChange={setUpdateFade} disabled={!operateItem} />
                    <button className="opx-btn violet" disabled={!operateItem || !updates} title={t(updateFade ? 'Send these values to the graphic on air (cross-fade)' : 'Send these values to the graphic on air (cut)')} onClick={() => command({ action: 'update', zone: itemZone?.id, data: sent, fade: updateFade })}>
                      <RefreshCw size={13} /> Update{updates ? ` · ${updates}` : ''}
                    </button>
                  </>
                )}
              </header>
              {(parts.widgets.length > 1 || (parts.widgets.length > 0 && parts.shared.length > 0)) && (
                <div className="opx-head opx-tabs opx-wtabs">
                  {!together &&
                    parts.widgets.map((p, i) => {
                      const Icon = widgetOf(p.layer)?.icon;
                      const ws = pv.widgets[p.layer.id] as { running?: boolean } | undefined;
                      return (
                        <button key={p.layer.id} className={`opx-wtab ${!sharedSel && p === part ? 'on' : ''}`} onClick={() => setTabOf({ ...tabOf, [item.id]: p.layer.id })}>
                          {Icon && <Icon size={13} />}
                          <span>{tabName(parts.widgets, i)}</span>
                          {ws?.running && <i className="opx-run" title={t('Animation running')} />}
                          {partChanged(p) && <i className="opx-chg" />}
                        </button>
                      );
                    })}
                  {!together && parts.shared.length > 0 && (
                    <button className={`opx-wtab ${sharedSel ? 'on' : ''}`} onClick={() => setTabOf({ ...tabOf, [item.id]: SHARED_TAB })}>
                      <Type size={13} />
                      <span>{t('Texts')}</span>
                      {parts.shared.some((f) => changed.has(f.key)) && <i className="opx-chg" />}
                    </button>
                  )}
                  <span className="spacer" />
                  <button className={`opx-wmerge ${together ? 'on' : ''}`} title={together ? t('One tab per layer') : t('All the layers together')} onClick={toggleMerged}>
                    <Layers size={14} />
                  </button>
                </div>
              )}
              {shownParts.some((p) => p.controls) && (
                <div className="opx-wbar">
                  {shownParts
                    .filter((p) => p.controls)
                    .map((p) => (
                      <PreviewControls key={`${item.id}-${p.layer.id}`} layer={p.layer} run={pv} setRun={setRun} data={previewData} fps={fps} ageSecs={pvAge} holdSecs={pvHold} lang={lang} onData={editDraft} />
                    ))}
                </div>
              )}
              <div className="opx-edit" style={{ gridTemplateColumns: hasData && hasContent ? `${Number.isFinite(layout.fields) ? layout.fields : 50}% 1px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}>
                {hasContent && (
                <div className="opx-fields-col">
                  <div className="opx-fields">
                    <ValuesPane template={template} fields={[...(showShared ? parts.shared : []), ...shownParts.flatMap((p) => p.fields)]} exposed={shownParts.flatMap((p) => (p.exposed ? [p.exposed] : []))} fedLayers={shownParts.filter((p) => p.fed.length).map((p) => p.layer)} changed={changed} draft={draft} boundDraft={boundDraft} readMode={readMode} sourceName={sourceName} previewData={previewData} onDraft={editDraft} />
                  </div>
                </div>
                )}
                {hasData && part && (
                  <>
                    {hasContent && (
                    <div
                      className="opx-vgap"
                      title={t('Drag to resize · double-click: half and half')}
                      onDoubleClick={() => setLayout('fields', 50)}
                      onPointerDown={(e) => {
                        const box = e.currentTarget.parentElement!.getBoundingClientRect();
                        const move = (ev: PointerEvent) => box.width > 0 && setLayout('fields', Math.round(Math.max(25, Math.min(75, ((ev.clientX - box.left) / box.width) * 100))));
                        const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
                        window.addEventListener('pointermove', move);
                        window.addEventListener('pointerup', up);
                      }}
                    />
                    )}
                    <DataBlock project={project} template={template} fields={bound} item={item} draft={draft} canEdit={canEdit} onRead={(patch) => editDraft(patch)} onMode={(m) => setItem(item.id, { read: m === 'live' ? undefined : m })}>
                      {datasets.map((ds) =>
                        datasetUse(template, ds).source ? (
                          <DataSetSource key={ds.key} ds={ds} template={template} draft={draft} onAir={onAirNow} sourceName={sourceName(ds.source)} onDraft={editDraft} />
                        ) : (
                          <div key={ds.key} className="opx-ds-stack">
                            <DataSetPanel ds={ds} template={template} draft={draft} onAir={onAirNow} operate={operateItem} zone={itemZone?.id} fps={fps} onDraft={editDraft} command={command} keys={ds === steppedDatasets(template)[0]} />
                            <DataSetHand ds={ds} template={template} draft={draft} onAir={onAirNow} operate={operateItem} zone={itemZone?.id} onDraft={editDraft} command={command} />
                          </div>
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
                    {/* A monitor: 30 frames a second are enough (the HTML5 output runs at the display rate). */}
                    <Program project={project} live={liveState} width={p.width} height={p.height} maxFps={MONITOR_FPS} />
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
          {busy.length ? (
            <div className="opx-airlist">
              {busy.map((z) => {
                const p = channel.layers[String(z.layer)];
                return (
                  <AirCard
                    key={z.id}
                    project={project}
                    zone={z}
                    item={p}
                    liveAt={liveState?.at ?? 0}
                    operate={operate && !zoneLocks.other(z.id)}
                    lockedBy={channelId ? zoneLocks.other(z.id) : undefined}
                    command={command}
                    nextRowOf={(key) => nextRowOf(p, key)}
                    widget={{ selected: airWidget, onSelect: setAirWidget, more: airMore, onMore: (k, open) => setAirMore({ ...airMore, [k]: open }) }}
                  />
                );
              })}
            </div>
          ) : (
            <p className="opx-hint pad">{t('Nothing on air.')}</p>
          )}
        </section>
      </div>
    </div>
    {/* The transport, the whole width: NEXT, CONTINUE, OUT · history, undo, clear, shortcuts. */}
    <footer className="ux1-transport">
      <NextButton project={project} live={liveState} target={nextTarget} disabled={!nextTarget || !operate || !!lockOf(nextTarget)} onTake={take} cap={<KeyCap action="next" />} />
      <button className={`opx-btn ${selZone && pauseOf(channel.layers[String(selZone.layer)], project) ? 'amber' : ''}`} disabled={!operate || !selZone || !!zoneLocks.other(selZone.id)} onClick={() => continueZone(selZone)} title={actionLabel('continue')}>
        <ChevronsRight size={16} /> Continue <KeyCap action="continue" />
      </button>
      <button className="opx-btn" disabled={!operate || !selZone || !!zoneLocks.other(selZone.id)} onClick={() => outZone(selZone)} title={actionLabel('out')}>
        <CircleStop size={16} /> Out <KeyCap action="out" />
      </button>
      <span className="spacer" />
      {channelId && <UndoHistory channelId={channelId} operate={operate} />}
      <button className="opx-btn" disabled={!operate} onClick={requestUndo} title={actionLabel('undo')}>
        <Undo2 size={16} /> {t('Undo')} <KeyCap action="undo" />
      </button>
      <button className="opx-btn ux1-clear" disabled={!operate || !Object.keys(channel.layers).length} onClick={() => command({ action: 'clear' })} title={actionLabel('clear')}>
        {t('Clear all')} <KeyCap action="clear" />
      </button>
      <button className="opx-btn ux1-help" title={t('Keyboard shortcuts')} aria-label={t('Keyboard shortcuts')} onClick={openShortcuts}>
        ?
      </button>
    </footer>
    <UndoShortcut channelId={channelId} operate={operate} />
    </div>
  );
}

/** The Operator's monitors and countdowns redraw at most this many times a second. */
const MONITOR_FPS = 30;

/** An auto next on its way: the graphic on air, the one it takes, and when (client clock, ms). */
function pendingAutoNext(project: Project, live: Live | undefined): { from: RundownItem; to: RundownItem | undefined; at: number; secs: number } | null {
  if (!live) return null;
  const fps = project.frameRate.num / project.frameRate.den || 1;
  let best: { from: RundownItem; to: RundownItem | undefined; at: number; secs: number } | null = null;
  for (const p of Object.values(live.state.layers) as (PlayoutItem & { advanced?: boolean })[]) {
    if (p.advanced || p.phase === 'out' || p.phase === 'outHold' || !p.rundownId) continue;
    const r = project.rundown.find((x) => x.id === p.rundownId);
    if (!r || r.autoSecs === undefined) continue;
    // Counts from the on-air point (after the in animation and the pauses before it).
    const tpl = project.templates.find((x) => x.id === p.templateId);
    if (!tpl || p.phase !== 'holding' || p.frame < holdFrame(tpl) - 1e-6) continue;
    const list = project.playlists.find((x) => x.id === r.playlist && x.autoNext);
    if (!list) continue;
    // As the server: the graphics of the playlist (an empty template is not part of it).
    const items = project.rundown.filter((x) => x.playlist === r.playlist && (x.id === r.id || !!project.templates.find((t) => t.id === x.templateId)?.layers.some((l) => l.visible !== false)));
    const i = items.findIndex((x) => x.id === r.id);
    const to = items[i + 1] ?? (list.loop ? items[0] : undefined);
    const at = live.at + (Math.max(0, r.autoSecs) - (p.held ?? 0) / fps) * 1000;
    if (!best || at < best.at) best = { from: r, to, at, secs: r.autoSecs };
  }
  return best;
}

/** NEXT: takes the cued graphic; with an auto next on its way, its countdown (and what it takes). */
function NextButton({ project, live, target, disabled, onTake, cap }: { project: Project; live: Live | undefined; target: RundownItem | undefined; disabled: boolean; onTake: () => void; /** Its key. */ cap?: React.ReactNode }) {
  const auto = pendingAutoNext(project, live);
  const now = useTicker(!!auto, MONITOR_FPS);
  const left = auto ? Math.max(0, (auto.at - now) / 1000) : 0;
  if (auto) {
    const done = auto.secs > 0 ? Math.min(1, Math.max(0, 1 - left / auto.secs)) : 1;
    return (
      <button className="opx-btn big red opx-next-auto" disabled={disabled} onClick={onTake} title={t('F1 / Enter: takes {name}', { name: target?.name ?? t('the next graphic') })}>
        <span className="opx-next-fill" style={{ width: `${done * 100}%` }} />
        <span className="opx-next-top">
          <b className="opx-next-n">{Math.ceil(left - 1e-3)}</b>
          {/* NEXT keeps its broadcast name. */}
          <span className="opx-next-unit">s</span>
          <span>· Next</span>
        </span>
        <span className="opx-next-sub">{auto.to ? t('Auto: {name}', { name: auto.to.name }) : t('Auto: out')}</span>
      </button>
    );
  }
  return (
    <button className="opx-btn big red" disabled={disabled} onClick={onTake} title={t('F1 / Enter: takes {name}', { name: target?.name ?? t('the next graphic') })}>
      <SkipForward size={15} fill="currentColor" /> Next
      {target && <span className="opx-next-name">{target.name}</span>}
      {cap}
    </button>
  );
}

// Not drawn again on each frame of the channel (only its props matter).
const PlaylistRow = memo(function PlaylistRow({ project, id, active, editable, onSelect }: { project: Project; id: string; active: boolean; editable: boolean; onSelect: (id: string) => void }) {
  const toast = useApp((s) => s.toast);
  const [menu, setMenu] = useState(false);
  // Esc closes the "…" menu.
  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), setMenu(false));
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [menu]);
  const p = project.playlists.find((x) => x.id === id)!;
  const count = project.rundown.filter((r) => r.playlist === id).length;
  const save = (lists: Project['playlists']) => api('PUT', `/api/projects/${encodeURIComponent(project.id)}/playlists`, lists).catch((e) => toast((e as Error).message, 'error'));
  return (
    <div className={`opx-pl ${active ? 'on' : ''}`} onClick={() => onSelect(id)}>
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
});

/**
 * The left part of a graphic: its values (texts, pictures… and what the Texts
 * fed by a data set show), then the properties exposed in the Designer, layer
 * by layer, with the Designer's controls and sections.
 */
function ValuesPane({ template, fields, exposed, fedLayers, changed, draft, boundDraft, readMode, sourceName, previewData, onDraft }: { template: Template; fields: Field[]; exposed: ExposedLayer[]; fedLayers: Layer[]; changed: Set<string>; draft: Record<string, string>; boundDraft: Record<string, string>; readMode: ReadMode; sourceName: (id: string) => string; previewData: Record<string, string>; onDraft: (patch: Record<string, string>) => void }) {
  // Typed by hand over the data, until the operator goes back to it.
  const byHand = (k: string) => !!draft[manualKey(k)]?.trim();
  const fromData = (f: Field) => !!f.binding?.source && readMode !== 'manual';
  const live = (f: Field) => fromData(f) && !byHand(f.key);
  /** The pen (type over the data, from what it shows) or the data (back to it). */
  const handToggle = (keys: string[], shown: (k: string) => string) =>
    keys.some(byHand) ? (
      <button className="icon-btn ghost" title={t('Back to the data')} onClick={() => onDraft(Object.fromEntries(keys.map((k) => [manualKey(k), ''])))}>
        <Database size={13} />
      </button>
    ) : (
      <button className="icon-btn ghost" title={t('Type it by hand')} onClick={() => onDraft(Object.fromEntries(keys.flatMap((k) => [[k, shown(k)], [manualKey(k), 'removed']])))}>
        <PenLine size={13} />
      </button>
    );
  const io: FieldIO = {
    value: (f) => draft[f.key] ?? '',
    set: (f, v) => onDraft({ [f.key]: v }),
    fed: (f) => (live(f) ? (boundDraft[f.key] ?? draft[f.key] ?? '…') : null),
    changed: (f) => changed.has(f.key),
  };
  // A Text a data set feeds (it is only its source): what it shows, read only.
  const fed: { layer: Layer; title: string; cols: string[]; at: number }[] = [];
  for (const ds of usedDatasets(template)) {
    const use = datasetUse(template, ds);
    if (!use.source || !fedLayers.length) continue;
    const row = Math.max(1, parseInt(draft[rowKey(ds.key)] ?? '1', 10) || 1);
    for (const l of use.texts) {
      if (!fedLayers.some((x) => x.id === l.id) || fed.some((x) => x.layer.id === l.id)) continue;
      // The columns it shows (typed by hand over the row, one by one).
      const at = new RegExp(`\\{\\{\\s*(${ds.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[A-Za-z0-9][A-Za-z0-9_]*)\\s*\\}\\}`, 'g');
      const cols = l.type !== 'text' && l.type !== 'typewriter' ? [] : [...new Set([...l.text.matchAll(at)].map((m) => m[1]))];
      fed.push({ layer: l, title: t('From {dataset}: row {row}', { dataset: ds.name, row }), cols, at: ds.key.length + 1 });
    }
  }
  const fedChanged = fedLayers.length > 0 && usedDatasets(template).some((d) => changed.has(rowKey(d.key)) || changed.has(oneKey(d.key)));
  const dot = (on: boolean, label: React.ReactNode) =>
    on ? (
      <>
        <i className="opx-chg" />
        {label}
      </>
    ) : (
      label
    );
  return (
    <>
      {(fields.length > 0 || fed.length > 0) && (
        <OpSection title={t('Content')}>
          {(() => {
            // The Text fed by a data set with the plain values, before the values grouped by layer.
            const groups = fieldGroups(fields);
            if (fed.length && !groups.some((g) => !g.title)) groups.unshift({ title: '', fields: [] });
            return groups.map((g) => (
              <div key={g.title} className="opx-group">
                {g.title && <div className="opx-sub">{g.title}</div>}
                {g.fields.map(({ f, label }) => (
                  <div key={f.key}>
                    <Row label={f.kind === 'table' ? undefined : dot(changed.has(f.key), label)} tail={fromData(f) && f.kind !== 'table' ? handToggle([f.key], (k) => boundDraft[k] ?? draft[k] ?? '') : undefined}>
                      {live(f) ? (
                        <span className="opx-bound" title={t(readMode === 'live' ? '{binding} · {source}, read live' : '{binding} · {source}, read on take', { binding: bindingLabel(f.binding!), source: sourceName(f.binding!.source) })}>
                          {boundDraft[f.key] ?? draft[f.key] ?? '…'}
                        </span>
                      ) : (
                        <FieldInput field={f} value={draft[f.key] ?? ''} rich={richField(template, f.key)} maxLength={maxChars(template, f.key) || undefined} onChange={(v) => onDraft({ [f.key]: v })} />
                      )}
                    </Row>
                    {/* A Text's « Max characters »: what is typed, out of the most. */}
                    {!live(f) && maxChars(template, f.key) > 0 && (
                      <p className="hint" style={{ textAlign: 'right', padding: '0 10px 6px' }}>
                        {plain(draft[f.key] ?? '').length} / {maxChars(template, f.key)}
                      </p>
                    )}
                  </div>
                ))}
                {!g.title &&
                  fed.map(({ layer, title, cols, at }) => {
                    const toggle = cols.length ? handToggle(cols, (k) => previewData[k] ?? '') : undefined;
                    return cols.some(byHand) ? (
                      <div key={layer.id}>
                        {cols.map((k, i) => (
                          <Row key={k} label={dot(changed.has(k), cols.length > 1 ? `${layer.name} · ${k.slice(at)}` : layer.name)} tail={i === 0 ? toggle : undefined}>
                            <TextInput value={draft[k] ?? ''} onChange={(v) => onDraft({ [k]: v })} />
                          </Row>
                        ))}
                      </div>
                    ) : (
                      <FedText key={layer.id} label={dot(fedChanged, layer.name)} value={layer.type === 'text' ? shownText(layer, previewData) : layer.type === 'typewriter' ? interpolateText(layer.text, previewData) : ''} title={title} tail={toggle} />
                    );
                  })}
              </div>
            ));
          })()}
        </OpSection>
      )}
      {exposed.map((e) => (
        <LayerProperties key={e.layer.id} entry={e} io={io} bare />
      ))}
    </>
  );
}

/** A widget's tab: its layer's name, numbered when several widgets have that name (Image, Image 2…). */
function tabName(widgets: WidgetPart[], i: number) {
  const name = widgets[i].layer.name;
  const same = widgets.filter((w) => w.layer.name === name);
  const n = same.indexOf(widgets[i]);
  return same.length > 1 && n > 0 ? `${name} ${n + 1}` : name;
}

/**
 * The preview of the selected graphic, held at its On air point; its widgets run once the preview's
 * controls were used. A widget moving by itself waits for its Play, still at its start (heldAt).
 */
const PreviewScene = memo(function PreviewScene({ template: base, format, data, fps, run, lang }: { template: Template; format: string; data: Record<string, string>; fps: number; run: PreviewRun; lang: string }) {
  const template = useMemo(() => inFormat(base, format), [base, format]);
  const hold = holdFrame(template);
  const holdSecs = hold / fps;
  // Kept while the preview's run and values stay: only the widgets that move redraw on each frame (while it runs).
  const layerAge = useCallback(
    (l: Layer, age: number) => heldAt(run, l, data, holdSecs) ?? (run.active ? layerAgeFrames({ clocks: run.clocks } as PlayoutItem, age * fps, l) / fps : age),
    [run, data, holdSecs, fps],
  );
  const clocked = useCallback((l: Layer) => heldAt(run, l, data, holdSecs) !== undefined || (run.active && (!!run.clocks[l.id] || !!l.manualStart)), [run, data, holdSecs]);
  const widgetState = useMemo(() => (run.active ? (id: string) => run.widgets[id] : undefined), [run]);
  return (
    <LiveTime ageSecs={holdSecs} since={run.active ? run.since : undefined} ticking={run.active ? 'all' : false} layerAge={layerAge} clocked={clocked} widgetState={widgetState} fps={fps} lang={lang}>
      <Scene template={template} frame={hold} data={data} />
    </LiveTime>
  );
});

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
  /** When the channel state was received (client ms). */
  liveAt: number;
  selected: boolean;
  /** NEXT takes this one. */
  cue: boolean;
  operate: boolean;
  /** Its zone is held by another operator. */
  lockedBy?: ZoneLock;
  /** Its scheduled takes and the clock button. */
  schedule?: React.ReactNode;
  editable: boolean;
  onSelect: () => void;
  onTake: () => void;
  onOut: () => void;
  onContinue: () => void;
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
  const pause = air ? pauseOf(air, project) : undefined;
  const step = air ? autoStep(project, air, props.liveAt) : null;
  const left = useLeft(step);
  const [renaming, setRenaming] = useState(false);
  const [autoAt, setAutoAt] = useState<DOMRect | null>(null);
  return (
    <div className={`opx-gr ${props.selected ? 'on' : ''} ${props.cue ? 'cue' : ''} ${air ? 'air' : ''} ${props.lockedBy ? 'opl-locked' : ''} ${props.drag.over ? `drop-${props.drag.over}` : ''}`} onClick={props.onSelect} onDragOver={props.drag.onOver} onDrop={props.drag.onDrop}>
      {props.editable && (
        <span className="opx-grip" draggable onDragStart={props.drag.onStart} onDragEnd={props.drag.onEnd} title={t('Drag to reorder')} onClick={(e) => e.stopPropagation()}>
          <GripVertical size={14} />
        </span>
      )}
      {props.lockedBy ? (
        <button className={`opx-sq big opl-sq ${air ? 'red' : ''}`} disabled title={t('{name} holds this zone', { name: props.lockedBy.userName })} onClick={(e) => e.stopPropagation()}>
          <Lock size={14} />
        </button>
      ) : air && pause ? (
        <PauseButton pause={pause} step={step} left={left} operate={props.operate} onContinue={props.onContinue} />
      ) : (
        <button
          className={`opx-sq big ${air ? 'red' : ''} ${step ? 'opx-pause wait-out' : ''}`}
          style={step ? ({ '--p': step.secs ? 1 - left / step.secs : 1 } as React.CSSProperties) : undefined}
          disabled={!props.operate}
          title={air ? (step ? `${(step.kind === 'next' ? t('Next graphic in {n} s', { n: Math.ceil(left) }) : t('Goes out in {n} s', { n: Math.ceil(left) }))} · ${t('Take out')}` : t('Take out')) : t('Take')}
          onClick={(e) => {
            e.stopPropagation();
            if (air) props.onOut();
            else props.onTake();
          }}
        >
          {step ? <b>{Math.ceil(left)}</b> : air ? <Square size={12} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
      )}
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
        </span>
        <MiniTimeline template={tpl} air={air} />
      </span>
      <DataWarning template={tpl} />
      {props.lockedBy && <LockedBy lock={props.lockedBy} />}
      {props.schedule}
      {props.editable && (
        <span className="opx-acts" onClick={(e) => e.stopPropagation()}>
          <button title={t('Auto next of this graphic: its time on air')} className={item.autoSecs !== undefined ? 'on' : ''} onClick={(e) => setAutoAt(autoAt ? null : e.currentTarget.getBoundingClientRect())}>
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

/** A graphic held on a pause: Continue when the operator resumes it, else what it waits for (seconds left, a trigger). */
function PauseButton({ pause, step, left, operate, onContinue }: { pause: Marker; step: AutoStep | null; left: number; operate: boolean; onContinue: () => void }) {
  const resume = pause.resume ?? { type: 'manual' };
  if (step) {
    return (
      <span className="opx-sq big amber opx-pause wait" style={{ '--p': step.secs ? 1 - left / step.secs : 1 } as React.CSSProperties} title={t('Pause · plays on in {n} s', { n: Math.ceil(left) })} onClick={(e) => e.stopPropagation()}>
        <b>{Math.ceil(left)}</b>
      </span>
    );
  }
  if (resume.type === 'trigger')
    return (
      <span className="opx-sq big amber opx-pause wait" title={t('Pause · waits for the trigger {name}', { name: resume.name })} onClick={(e) => e.stopPropagation()}>
        <Zap size={14} fill="currentColor" />
      </span>
    );
  return (
    <button
      className="opx-sq big amber opx-pause"
      disabled={!operate}
      title={`${t('Pause · Continue')} · F2`}
      onClick={(e) => {
        e.stopPropagation();
        onContinue();
      }}
    >
      <ChevronsRight size={18} />
    </button>
  );
}

/** Auto next settings of one graphic: its time on air before the next one, or the operator takes it. */
function AutoNextEditor({ item, at, onChange, onClose }: { item: RundownItem; at: DOMRect; onChange: (patch: Partial<RundownItem>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key, true);
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
          <button className={!auto ? 'on' : ''} title={t('The operator takes the next graphic')} onClick={() => onChange({ autoSecs: undefined, hold: undefined })}>
            {t('Operator')}
          </button>
          <button className={auto ? 'on' : ''} title={t('The next graphic is taken after this time on air')} onClick={() => onChange({ autoSecs: item.autoSecs ?? AUTO_SECS, hold: undefined })}>
            {t('After')}
          </button>
        </div>
      </div>
      {auto && (
        <label className="me-field">
          <span>{t('On air for')}</span>
          <NumberField value={item.autoSecs ?? AUTO_SECS} min={0} step={1} suffix="s" onChange={(v) => onChange({ autoSecs: Math.max(0, v), hold: undefined })} />
        </label>
      )}
    </div>,
    document.body,
  );
}

/** Sources the graphic reads, when it reads them, and Read now. */
function DataBlock({ template, fields, item, draft, canEdit, onRead, onMode, children }: { children?: React.ReactNode; project: Project; template: Template; /** The fields of the widget read from a source. */ fields: Field[]; item: RundownItem; draft: Record<string, string>; canEdit: boolean; onRead: (patch: Record<string, string>) => void; onMode: (m: ReadMode) => void }) {
  const all = useSources();
  const auth = useApp((s) => s.auth);
  const toast = useApp((s) => s.toast);
  const bound = template.fields.filter((f) => f.binding?.source);
  const used = [...new Set(fields.filter((f) => f.binding?.source).map((f) => f.binding!.source))].map((id) => all.find((s) => s.id === id) ?? { id, name: id, interval: 0, updatedAt: null, error: t('not found') });
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
      {used.length > 0 && (
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

/** Which widget row of the graphics on air is selected (its keys are on) and which ones are unfolded (⋯). */
interface AirWidgets {
  selected: string | null;
  onSelect: (key: string) => void;
  more: Record<string, boolean>;
  onMore: (key: string, open: boolean) => void;
}

/**
 * The control centre of a widget of the graphic on air (web/src/widgets/centre.tsx): its state,
 * its actions, its exposed settings (written into the take). A click on it selects it: only then
 * its keyboard shortcuts work.
 */
function SpecControls({ layer, item, act, setData, fps, lang, selected, onSelect }: { layer: Layer; item: PlayoutItem; act: (op: string, args?: unknown) => void; setData: (patch: Record<string, string>) => void; fps: number; lang: string; selected: boolean; onSelect: () => void }) {
  const def = widgetOf(layer)!;
  const offset = useApp((s) => s.serverOffset);
  const tz = useApp((s) => s.timezone);
  const state = item.widgets?.[layer.id];
  const Op = def.Operator;
  if (!Op) return null;
  // The layer's own time on air: still while it waits for its start, or paused.
  const time = { nowMs: Date.now() + offset, ageSecs: layerAgeFrames(item, item.age ?? 0, layer) / fps, defaultTz: tz, fps, lang };
  return (
    <KeyScope.Provider value={selected}>
      <div className={`opx-widget cc-host ${selected ? 'sel' : ''}`} onClick={onSelect}>
        <CentreModeContext.Provider value="operator">
          <OperatorBound layer={layer} data={item.data} setData={setData}>
            <Op layer={layer as never} state={state} data={item.data} act={act} item={item} time={time} lang={lang} setData={setData} />
          </OperatorBound>
        </CentreModeContext.Provider>
      </div>
    </KeyScope.Provider>
  );
}

/** The templates the operator can add to the rundown: searchable cards with their picture, by zone. */
function AddGraphic({ project, templates, used, onPick, onClose }: { project: Project; templates: Template[]; used: (id: string) => number; onPick: (t: Template) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const zoneOf = (t: Template) => project.zones.find((z) => z.id === t.zone);
  const list = templates.filter((t) => words.every((w) => `${t.name} ${zoneOf(t)?.name ?? ''}`.toLowerCase().includes(w)));
  // By zone, in the zones' order.
  const groups = [...project.zones.map((z) => ({ zone: z as Zone | undefined, list: list.filter((t) => t.zone === z.id) })), { zone: undefined, list: list.filter((t) => !zoneOf(t)) }].filter((g) => g.list.length);
  const fps = project.frameRate.num / project.frameRate.den || 25;
  const secs = (f: number) => `${+(f / fps).toFixed(1)} s`;
  return createPortal(
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal opx-addmodal" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header>
          <h2>{t('Add a graphic from a template')}</h2>
          <button className="icon-btn ghost" title={t('Close (Esc)')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
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
    </div>,
    document.body,
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

/** One graphic on air: a card — the on-air family in its header, the animation pills below. */
function AirCard({ project, zone, item, liveAt, operate, lockedBy, command, nextRowOf, widget }: { project: Project; zone: Zone; item: PlayoutItem; liveAt: number; operate: boolean; /** Its zone is held by another operator. */ lockedBy?: ZoneLock; command: (c: Command) => void; nextRowOf?: (dataset: string) => number | undefined; widget: AirWidgets }) {
  const tpl = project.templates.find((x) => x.id === item.templateId);
  const waiting = tpl ? pauseOf(item, project) : undefined;
  const step = autoStep(project, item, liveAt);
  const left = useLeft(step);
  const count = (kind: AutoStep['kind']) =>
    step?.kind === kind || (kind === 'out' && step?.kind === 'next') ? (
      <b className="opx-count" style={{ '--p': step.secs ? 1 - left / step.secs : 1 } as React.CSSProperties} title={step.kind === 'resume' ? t('Pause · plays on in {n} s', { n: Math.ceil(left) }) : step.kind === 'next' ? t('Next graphic in {n} s', { n: Math.ceil(left) }) : t('Goes out in {n} s', { n: Math.ceil(left) })}>
        {Math.ceil(left)}
      </b>
    ) : null;
  const name = rundownName(project, item.rundownId) ?? tpl?.name ?? t('Deleted graphic');
  return (
    <div className={`opx-aircard ${lockedBy ? 'opl-locked' : ''}`} title={lockedBy ? t('{name} holds this zone', { name: lockedBy.userName }) : undefined}>
      <header>
        <span className="opx-dot" style={{ background: 'var(--live)' }} />
        <strong>{name}</strong>
        <span className="muted small">
          {zone.name}
          {lockedBy && (
            <>
              {' · '}
              <Lock size={10} /> {lockedBy.userName}
            </>
          )}
        </span>
        <span className="spacer" />
        <DataWarning template={tpl} />
        {canContinue(item, tpl) && (
          <button className={`opx-btn small ${waiting ? 'amber' : ''}`} disabled={!operate} onClick={() => command({ action: 'continue', zone: zone.id })} title={t('F2 / Space')}>
            <ChevronsRight size={13} /> Continue {count('resume')}
          </button>
        )}
        <button className="opx-btn small red" disabled={!operate} onClick={() => command({ action: 'takeOut', zone: zone.id })} title="F3">
          <CircleStop size={13} /> Out {count('out')}
        </button>
      </header>
      <AirControls project={project} zone={zone} item={item} command={command} nextRowOf={nextRowOf} widget={widget} bare />
    </div>
  );
}

function AirControls({ project, zone, item, command, nextRowOf, widget, bare }: { project: Project; zone: Zone; item: PlayoutItem; command: (c: Command) => void; nextRowOf?: (dataset: string) => number | undefined; widget: AirWidgets; bare?: boolean }) {
  const tpl = project.templates.find((x) => x.id === item.templateId);
  const target = { zone: zone.id };
  // Deleted (or unpublished) while on air: it can still be taken out.
  if (!tpl)
    return (
      <div className="opx-controls">
        {!bare && (
          <div className="opx-actions sticky">
            <button className="opx-btn" onClick={() => command({ action: 'takeOut', ...target })} title="F3">
              <CircleStop size={14} /> Out
            </button>
          </div>
        )}
        <p className="opx-hint">{t('This graphic is no longer in the project: take it out.')}</p>
      </div>
    );
  // A Text scrolls by itself: no start / pause for it in the Operator.
  const timed = tpl.layers.filter((l) => isTimed(l) && l.type !== 'text');
  // Pauses waiting for a trigger, and values set by hand until one.
  // …and the widgets' triggers (a start, the next page): every setting named `…Trigger` of a layer.
  const widgetTriggers = tpl.layers.flatMap((l) => Object.entries(l as unknown as Record<string, unknown>).flatMap(([k, v]) => (/Trigger$/.test(k) && typeof v === 'string' && v.trim() ? [v.trim()] : [])));
  const triggers = [...new Set([...tpl.markers.flatMap((m) => (m.kind === 'pause' && m.resume?.type === 'trigger' ? [m.resume.name] : [])), ...Object.entries(item.data).flatMap(([k, v]) => (k.endsWith('__manual') && v.startsWith('trigger:') ? [v.slice(8)] : [])), ...widgetTriggers])];
  const waiting = pauseOf(item, project);
  return (
    <div className="opx-controls">
      {!bare && (
        <div className="opx-actions sticky">
          {canContinue(item, tpl) && (
            <button className={`opx-btn ${waiting ? 'amber' : ''}`} onClick={() => command({ action: 'continue', ...target })} title={t('F2 / Space')}>
              <ChevronsRight size={14} /> Continue
            </button>
          )}
          <button className="opx-btn" onClick={() => command({ action: 'takeOut', ...target })} title="F3">
            <CircleStop size={14} /> Out
          </button>
        </div>
      )}
      {!!steppedDatasets(tpl).length && <AirRows sets={steppedDatasets(tpl)} item={item} command={command} zone={zone.id} nextRowOf={nextRowOf} />}
      {tpl.layers
        .filter((l) => l.visible && !!widgetOf(l)?.Operator && hasControls(l, item.data))
        .map((l) => {
          const key = `${zone.id}:${l.id}`;
          return (
            <SpecControls
              key={l.id}
              layer={l}
              item={item}
              fps={project.frameRate.num / project.frameRate.den || 50}
              lang={project.language || 'fr'}
              act={(op, args) => command({ action: 'act', target: l.id, op, args, ...target })}
              setData={(patch) => command({ action: 'update', data: patch, fade: false, ...target })}
              selected={widget.selected === key}
              onSelect={() => widget.onSelect(key)}
            />
          );
        })}
      {timed
        .filter((l) => !widgetOf(l)?.Operator)
        .map((l) => {
          const c = item.clocks?.[l.id];
          const running = c ? c.pausedAt == null : !l.manualStart;
          const toggle = () => command({ action: 'widget', target: l.id, control: 'toggle', ...target });
          return (
            <div key={l.id} className="opx-widget cc-host">
              <CentreModeContext.Provider value="operator">
                <Centre
                  name={l.name}
                  status={<StartStatus layer={l} item={item} />}
                  actions={[
                    running ? { icon: Pause, label: tc('cc', 'Pause'), key: 'P', main: true, onClick: toggle } : { icon: Play, label: tc('cc', 'Play'), key: 'P', main: true, onClick: toggle },
                    { icon: RotateCcw, label: tc('cc', 'Restart'), key: 'T', onClick: () => command({ action: 'widget', target: l.id, control: running ? 'restart' : 'reset', ...target }) },
                  ]}
                />
              </CentreModeContext.Provider>
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
    </div>
  );
}

/** The output the operator takes to; another project's output is taken over after a confirmation. */
const OutputSelect = memo(function OutputSelect({ channelId }: { channelId: string | null }) {
  const { channels, projects, project, loadOnChannel } = useApp(useShallow((s) => ({ channels: s.channels, projects: s.projects, project: s.project, loadOnChannel: s.loadOnChannel })));
  // Read when asked, not followed: this list is not drawn again on each frame.
  const live = () => useApp.getState().live;
  const projectName = (id?: string | null) => projects.find((p) => p.id === id)?.name ?? t('another project');
  const pick = async (id: string) => {
    if (!project) return;
    if (!id) {
      // No output: the channel it had is unloaded (it shows its picture without project).
      const cur = channels.find((x) => x.id === channelId && x.projectId === project.id);
      if (cur) {
        const onAir = Object.keys(live()[cur.id]?.state.layers ?? {}).length;
        if (onAir && !(await confirmDialog({ title: t('Unload {channel}?', { channel: cur.name }), message: tn(onAir, 'The {n} graphic on air on {channel} is cleared.', 'The {n} graphics on air on {channel} are cleared.', { channel: cur.name }), confirm: t('Unload'), danger: true }))) return;
        await loadOnChannel(cur.id, null);
      }
      return navigate(projectPath(project.id, 'operator', 'none'));
    }
    const c = channels.find((x) => x.id === id);
    if (!c) return;
    if (c.projectId !== project.id) {
      const onAir = Object.keys(live()[c.id]?.state.layers ?? {}).length;
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
});
