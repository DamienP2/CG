import { LayoutGrid, Copy, FileUp, Link2, Plus, Settings2, Redo2, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { newId, num, propValue } from '../engine/evaluate';
import type { Layer, LayerType, Project, Template } from '../engine/types';
import { importAfterEffects, thumbnailUrl, useApp } from '../store';
import { descendants, duplicateLayers, findLayer, makeLayer, newTemplate, setProp, useDesigner } from './designerStore';
import { Inspector } from './Inspector';
import { LockOverlay, useEditLock } from './Collab';
import { Stage } from './Stage';
import { Timeline } from './Timeline';
import { ZonesDialog } from './ZonesDialog';
import { LogicEditor } from './LogicEditor';
import { DataCanvas, DataCanvasButton } from './DataCanvas';
import { TableEditor } from '../widgets/table-editor';
import { exposeRows } from '../widgets/table-rows';
import { GuidesMenu, SafeMenu, SplitButton, useGuidesView } from './Guides';
import { ProjectHistory, ProjectPanel } from './ProjectPanel';
import { Splitter, useLayout } from '../ui/Splitter';
import { FormatBar } from './Formats';
import { formatById } from '../engine/formats';
import { designTemplates, publishState } from '../engine/drafts';
import { confirmDialog } from '../ui/dialogs';
import { projectPath, setLeaveGuard } from '../router';

function usePlayback(fps: number) {
  const playing = useDesigner((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const st = useDesigner.getState();
      const t = st.template;
      if (!t) return;
      // The first rAF timestamp can precede the effect: never step back.
      const dt = (Math.max(0, now - last) / 1000) * fps;
      last = now;
      let next = st.frame + dt;
      // Like on air: stop on the pauses and the On air point (Loop plays through).
      if (!st.loop) {
        const stop = t.markers.filter((m) => (m.kind === 'pause' || m.kind === 'out') && m.frame > st.frame + 1e-3 && m.frame <= next).sort((a, b) => a.frame - b.frame)[0];
        if (stop) {
          useDesigner.setState({ frame: stop.frame, playing: false });
          // A timed pause plays on by itself, as on air.
          if (stop.resume?.type === 'after')
            setTimeout(() => {
              const s = useDesigner.getState();
              if (!s.playing && Math.abs(s.frame - stop.frame) < 1e-3) s.setPlaying(true);
            }, stop.resume.seconds * 1000);
          return;
        }
      }
      if (next >= t.duration) {
        if (st.loop) next = 0;
        else {
          useDesigner.setState({ frame: t.duration, playing: false });
          return;
        }
      }
      useDesigner.setState({ frame: next });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps]);
}

/** Asks before leaving the designer while changes are not in the Operator yet. */
function useLeaveUnpublished(project: Project | null) {
  const changed = project?.drafts?.length ?? 0;
  const id = project?.id;
  useEffect(() => {
    if (!changed || !id) return;
    const here = projectPath(id, 'designer');
    return setLeaveGuard(
      (path) => !path.startsWith(here),
      () =>
        confirmDialog({
          title: 'Leave without publishing?',
          message: `${changed} template${changed > 1 ? 's have' : ' has'} changes the Operator does not have yet. They stay saved here as drafts; publish them from the Project block to put them on air.`,
          confirm: 'Leave',
          cancel: 'Stay',
        }),
    );
  }, [changed, id]);
}

function useAutosave() {
  // Saves the draft after the user's edits (not when a template is opened).
  const edits = useDesigner((s) => s.edits);
  const saveTemplate = useApp((s) => s.saveTemplate);
  const [state, setState] = useState<'saved' | 'pending'>('saved');
  // Edits waiting to be saved, per template: switching template or leaving never drops one.
  const pending = useRef(new Map<string, Template>());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flush = useRef(async () => {});
  flush.current = async () => {
    clearTimeout(timer.current);
    const list = [...pending.current.values()];
    pending.current.clear();
    for (const t of list) await saveTemplate(t);
    setState('saved');
  };
  useEffect(() => {
    if (!edits) return;
    const { base, readOnly } = useDesigner.getState();
    if (!base || readOnly) return;
    setState('pending');
    pending.current.set(base.id, base);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush.current(), 500);
  }, [edits, saveTemplate]);
  // Leaving the Designer: saved now.
  useEffect(() => () => void flush.current(), []);
  return state;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      // A full-screen editor (Logic, Data, table) or a dialog is open: its keys are its own (Delete would remove the layer behind it).
      if (e.defaultPrevented || document.querySelector('.logic-editor, .modal-back')) return;
      const st = useDesigner.getState();
      const t = st.template;
      // Esc: out of the safe area editing, off the selected layers, then off the template (overview).
      if (e.key === 'Escape' && useGuidesView.getState().editSafe) return useGuidesView.getState().set({ editSafe: false });
      if (e.key === 'Escape' && t) {
        if (st.selected.length || st.selectedKeys.length) st.set({ selected: [], selectedKeys: [] });
        else st.load(null);
        return;
      }
      if (!t) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (e.key === ' ') {
        e.preventDefault();
        // A focused button would also "click" on Space.
        if (target.closest('button')) (target as HTMLElement).blur();
        if (!e.repeat) st.setPlaying(!st.playing);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selectedKeys.length) {
          st.update((d) => {
            for (const k of st.selectedKeys) {
              const l = findLayer(d, k.layerId);
              const tr = l?.tracks[k.prop];
              if (!l || !tr) continue;
              const remaining = tr.filter((x) => x.frame !== k.frame);
              if (remaining.length) l.tracks[k.prop] = remaining;
              else {
                l.props[k.prop] = tr[0].value;
                delete l.tracks[k.prop];
              }
            }
          });
          st.selectKeys([]);
        } else if (st.selected.length) {
          st.update((d) => {
            const ids = new Set(st.selected.flatMap((id) => [id, ...descendants(d, id)]));
            d.layers = d.layers.filter((l) => !ids.has(l.id));
          });
          st.select([]);
        }
      } else if (e.key === 'Home') st.setFrame(0);
      else if (e.key === 'End') st.setFrame(t.duration);
      else if (e.key === ',' || e.key === 'PageUp') st.setFrame(Math.round(st.frame) - (e.shiftKey ? 10 : 1));
      else if (e.key === '.' || e.key === 'PageDown') st.setFrame(Math.round(st.frame) + (e.shiftKey ? 10 : 1));
      else if (e.key.startsWith('Arrow') && st.selected.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const [dx, dy] = {
          ArrowLeft: [-d, 0],
          ArrowRight: [d, 0],
          ArrowUp: [0, -d],
          ArrowDown: [0, d],
        }[e.key] ?? [0, 0];
        st.update((draft) => {
          for (const id of st.selected) {
            const l = findLayer(draft, id);
            if (!l || l.locked) continue;
            if (dx) setProp(l, 'x', num(propValue(l, 'x', st.frame)) + dx, st.frame);
            if (dy) setProp(l, 'y', num(propValue(l, 'y', st.frame)) + dy, st.frame);
          }
        }, 'nudge');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function duplicateSelection() {
  duplicateLayers(useDesigner.getState().selected);
}

/** Zones button: show them on the stage, see the list, manage them. */
function ZonesMenu({ project, show, onShow, onManage }: { project: Project; show: boolean; onShow: (v: boolean) => void; onManage: () => void }) {
  const current = useDesigner((s) => s.template?.zone);
  return (
    <SplitButton icon={<LayoutGrid size={13} />} label="Zones" on={show} onToggle={() => onShow(!show)} title="screen zones" width={260}>
      <div className="zm-list">
        {[...project.zones]
          .sort((a, b) => b.layer - a.layer)
          .map((z) => (
            <div key={z.id} className={`zm-zone ${z.id === current ? 'mine' : ''}`} style={{ ['--zc' as string]: z.color }}>
              <span className="zm-dot" />
              <span>{z.name}</span>
              <em>{z.id === current ? 'this template' : `layer ${z.layer}`}</em>
            </div>
          ))}
      </div>
      <p className="zm-hint">On the stage, drag a zone by its name and resize it with its handles.</p>
      <button className="btn small" data-close onClick={onManage}>
        <Settings2 size={13} /> Manage zones…
      </button>
    </SplitButton>
  );
}

const BG_LABELS = {
  checker: 'transparent',
  black: 'black',
  studio: 'studio',
} as const;

function TemplateList({ project }: { project: Project }) {
  const { template, load, format, update } = useDesigner();
  // The template whose name is being edited (a click on the open template's name).
  const [renaming, setRenaming] = useState<string | null>(null);
  const { saveTemplate, deleteTemplate, toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const create = async (base?: Template) => {
    const t = base ? { ...structuredClone(base), id: newId(), name: `${base.name} copy` } : newTemplate(`Template ${designTemplates(project).length + 1}`, (project.zones.find((z) => z.id === 'full-screen' || /full/i.test(z.name)) ?? project.zones[0])?.id);
    // Open it at once; the save follows.
    load(t);
    await saveTemplate(t);
  };
  return (
    // A click beside the templates leaves the open one, like Esc.
    <div className="template-list" onClick={() => template && load(null)}>
      <header onClick={(e) => e.stopPropagation()}>
        <span>Templates</span>
        <div className="header-actions">
          <button className="icon-btn ghost" title="Import an After Effects composition (Bodymovin / LottieFiles .json, .zip, .lottie)" onClick={() => fileRef.current?.click()} disabled={importing}>
            <FileUp size={14} />
          </button>
          <button className="icon-btn ghost" title="New template" onClick={() => create()}>
            <Plus size={14} />
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.zip,.lottie,.mogrt"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setImporting(true);
            try {
              const { template: t, warnings } = await importAfterEffects(project.id, f);
              load(t);
              toast(warnings.length ? `Imported “${t.name}” — not converted: ${warnings.join('; ')}` : `Imported “${t.name}”`, 'info');
            } catch (err) {
              toast(String(err instanceof Error ? err.message : err), 'error');
            } finally {
              setImporting(false);
            }
          }}
        />
      </header>
      {designTemplates(project).map((t) => {
        const { published, draft } = publishState(project, t.id);
        const unpublished = draft || !published;
        return (
          <div key={t.id} className={`template-item ${template?.id === t.id ? 'selected' : ''}`} onClick={(e) => (e.stopPropagation(), template?.id !== t.id && load(t))}>
            <img src={thumbnailUrl(project.id, t, format, true)} alt="" loading="lazy" />
            <span className="tpl-text">
              {renaming === t.id && template?.id === t.id ? (
                <input
                  className="tpl-rename"
                  autoFocus
                  defaultValue={template.name}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (renaming && v && v !== template.name) update((x) => void (x.name = v));
                    setRenaming(null);
                  }}
                />
              ) : (
                <span
                  className="tpl-name"
                  title={template?.id === t.id ? 'Click to rename' : undefined}
                  onClick={(e) => {
                    // The open template: rename it. Another one: open it first.
                    if (template?.id !== t.id) return;
                    e.stopPropagation();
                    setRenaming(t.id);
                  }}
                >
                  {t.name}
                </span>
              )}
              {(() => {
                const z = project.zones.find((z) => z.id === t.zone);
                return z ? (
                  <em className="tpl-zone" style={{ ['--zc' as string]: z.color }}>
                    {z.name}
                  </em>
                ) : null;
              })()}
            </span>
            {unpublished && <span className="tpl-draft" title={published ? 'Changes not in the Operator yet (publish from the properties on the right)' : 'New: not in the Operator yet'} />}
            <div className="item-actions">
              <button className="icon-btn ghost" title="Duplicate" onClick={(e) => (e.stopPropagation(), create(t))}>
                <Copy size={12} />
              </button>
              <button
                className="icon-btn ghost"
                title={designTemplates(project).length < 2 ? 'A project keeps at least one template' : 'Delete'}
                disabled={designTemplates(project).length < 2}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!(await confirmDialog({ title: `Delete the template “${t.name}”?`, message: 'Rundown items using it are removed too.', confirm: 'Delete', danger: true }))) return;
                  await deleteTemplate(t.id).catch((err) => toast(String(err), 'error'));
                  if (template?.id === t.id) load(designTemplates(project).find((x) => x.id !== t.id) ?? null);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MIN_LEFT = 320;

export function Designer() {
  const project = useApp((s) => s.project);
  const { template, load, update, undo, redo, past, future, selected, select, format } = useDesigner();
  const [zonesOpen, setZonesOpen] = useState(false);
  // The top bar's slot for undo, redo and the history.
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setTopSlot(document.getElementById('topbar-slot')), []);
  const [showZones, setShowZones] = useState(true);
  const [logicOpen, setLogicOpen] = useState(false);
  const logicCount = useDesigner((s) => s.template?.logic?.nodes.length ?? 0);
  // Panel sizes, adjustable with the splitters.
  const [layout, setLayout] = useLayout('pulse.designerLayout', {
    left: 320,
    right: 380,
    timeline: 300,
  });
  // Room for the timeline property values (two 5-digit fields).
  const left = Math.max(MIN_LEFT, layout.left);
  const [background, setBackground] = useState<'checker' | 'black' | 'studio'>('checker');
  const fps = project ? project.frameRate.num / project.frameRate.den : 50;
  usePlayback(fps);
  useShortcuts();
  const saveState = useAutosave();
  useLeaveUnpublished(project);
  const lock = useEditLock(project, template?.id);

  // Opening another project: start on its first template.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    if (openedFor.current !== project.id) {
      openedFor.current = project.id;
      // A project opens on the overview: every zone and template.
      const all = designTemplates(project);
      if (!template || !all.some((t) => t.id === template.id)) load(null);
    }
  }, [project, template, load]);

  if (!project) return <div className="loading">Connecting…</div>;

  const add = (type: LayerType, patch?: Record<string, unknown>, name?: string) => {
    const parent = selected.length === 1 && template && findLayer(template, selected[0])?.type === 'group' ? selected[0] : null;
    const size = formatById(project, useDesigner.getState().format);
    const l = {
      ...makeLayer(type, size.width, size.height, parent),
      ...patch,
    } as Layer;
    if (name) l.name = name;
    update((t) => {
      t.layers.push(l);
      // A table without a data set: the operator types its rows.
      if (type === 'table') exposeRows(t, findLayer(t, l.id)!);
    });
    select([l.id]);
  };

  return (
    <div
      className={`designer ${lock.state.status === 'held' ? 'locked' : ''}`}
      style={{
        ['--left-w' as string]: `${left}px`,
        ['--right-w' as string]: `${layout.right}px`,
        ['--tl-h' as string]: `${layout.timeline}px`,
      }}
    >
      <aside className="panel left">
        <Splitter axis="x" className="edge-right" value={left} min={MIN_LEFT} max={520} reset={320} onChange={(v) => setLayout('left', v)} />
        <ProjectPanel project={project} saveState={saveState} readOnly={lock.state.status === 'held'} />
        <TemplateList project={project} />
      </aside>
      <main className="center">
        <div className="toolbar">
          {topSlot &&
            createPortal(
              <>
                <button className="top-tool" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}>
                  <Undo2 size={15} />
                </button>
                <button className="top-tool" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}>
                  <Redo2 size={15} />
                </button>
                <ProjectHistory project={project} readOnly={lock.state.status === 'held'} />
              </>,
              topSlot,
            )}
          <FormatBar project={project} />
          <div className="spacer" />
          {template && (
            <>
              <button className={`btn small ${logicCount ? 'on' : ''}`} onClick={() => setLogicOpen(true)} title="Relations between values: a box that follows a text, conditions…">
                <Link2 size={13} /> Logic{logicCount ? ` · ${logicCount}` : ''}
              </button>
              <DataCanvasButton />
            </>
          )}
          <ZonesMenu project={project} show={showZones} onShow={setShowZones} onManage={() => setZonesOpen(true)} />
          <GuidesMenu />
          <SafeMenu project={project} />
          <button className="btn small bg-toggle" title={`Stage background: ${BG_LABELS[background]} (click to change)`} onClick={() => setBackground(background === 'checker' ? 'black' : background === 'black' ? 'studio' : 'checker')}>
            <span className={`bg-swatch stage-frame bg-${background}`} />
          </button>
        </div>
        <div className="stage-holder">
          <Stage project={project} size={formatById(project, format)} showZones={showZones} background={background} />
        </div>
      </main>
      <aside className="panel right">
        <Splitter axis="x" className="edge-left" sign={-1} value={layout.right} min={300} max={620} reset={380} onChange={(v) => setLayout('right', v)} />
        <Inspector />
      </aside>
      <div className="timeline-wrap">
        <Splitter axis="y" className="edge-top" sign={-1} value={layout.timeline} min={140} max={800} reset={300} onChange={(v) => setLayout('timeline', v)} />
        <Timeline fps={fps} leftW={left} onAdd={add} />
      </div>
      {lock.state.status === 'held' && <LockOverlay holder={lock.state.holder} template={template?.name ?? ''} onTakeOver={lock.takeOver} />}
      {zonesOpen && <ZonesDialog onClose={() => setZonesOpen(false)} />}
      {logicOpen && <LogicEditor onClose={() => setLogicOpen(false)} />}
      <DataCanvas />
      <TableEditor />
    </div>
  );
}
