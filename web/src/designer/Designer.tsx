import { ChevronDown, LayoutGrid, Copy, FileUp, Grid3x3, Link2, Plus, Settings2, Redo2, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { newId, num, propValue } from '../engine/evaluate';
import type { Layer, LayerType, Project, Template } from '../engine/types';
import { importAfterEffects, thumbnailUrl, useApp } from '../store';
import { descendants, duplicateLayers, findLayer, makeLayer, newTemplate, setProp, useDesigner } from './designerStore';
import { Inspector } from './Inspector';
import { LockBanner, PublishButton, useEditLock } from './Collab';
import { Stage } from './Stage';
import { Timeline } from './Timeline';
import { ZonesDialog } from './ZonesDialog';
import { LogicEditor } from './LogicEditor';
import { Splitter, useLayout } from '../ui/Splitter';
import { FormatBar } from './Formats';
import { formatById } from '../engine/formats';
import { designTemplates } from '../engine/drafts';

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

function useAutosave() {
  // Saves the draft after the user's edits (not when a template is opened).
  const edits = useDesigner((s) => s.edits);
  const saveTemplate = useApp((s) => s.saveTemplate);
  const [state, setState] = useState<'saved' | 'pending'>('saved');
  useEffect(() => {
    if (!edits) return;
    setState('pending');
    // The edited template, even if another one is opened meanwhile.
    const { base, readOnly } = useDesigner.getState();
    const h = setTimeout(async () => {
      if (base && !readOnly) await saveTemplate(base);
      setState('saved');
    }, 500);
    return () => clearTimeout(h);
  }, [edits, saveTemplate]);
  return state;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      const st = useDesigner.getState();
      const t = st.template;
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
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
  const current = useDesigner((s) => s.template?.zone);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <div className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button
        className={`btn small ${show ? 'on' : ''}`}
        title="Screen zones"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(
            open
              ? null
              : {
                  left: Math.min(r.left, window.innerWidth - 260),
                  top: r.bottom + 6,
                },
          );
        }}
      >
        <LayoutGrid size={13} /> Zones <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu zones-menu" style={{ position: 'fixed', left: open.left, top: open.top }}>
          <label className="zm-toggle">
            <input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} />
            Show on the stage
          </label>
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
          <button
            className="btn small"
            onClick={() => {
              setOpen(null);
              onManage();
            }}
          >
            <Settings2 size={13} /> Manage zones…
          </button>
        </div>
      )}
    </div>
  );
}

const BG_LABELS = {
  checker: 'transparent',
  black: 'black',
  studio: 'studio',
} as const;

function TemplateList({ project }: { project: Project }) {
  const { template, load, format } = useDesigner();
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
    <div className="template-list">
      <header>
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
      {designTemplates(project).map((t) => (
        <div key={t.id} className={`template-item ${template?.id === t.id ? 'selected' : ''}`} onClick={() => template?.id !== t.id && load(t)}>
          <img src={thumbnailUrl(project.id, t, format, true)} alt="" loading="lazy" />
          <span className="tpl-text">
            <span>{t.name}</span>
            {(() => {
              const z = project.zones.find((z) => z.id === t.zone);
              return z ? (
                <em className="tpl-zone" style={{ ['--zc' as string]: z.color }}>
                  {z.name}
                </em>
              ) : null;
            })()}
          </span>
          <div className="item-actions">
            <button className="icon-btn ghost" title="Duplicate" onClick={(e) => (e.stopPropagation(), create(t))}>
              <Copy size={12} />
            </button>
            <button
              className="icon-btn ghost"
              title="Delete"
              onClick={async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete template “${t.name}”? Rundown items using it are removed too.`)) return;
                await deleteTemplate(t.id).catch((err) => toast(String(err), 'error'));
                if (template?.id === t.id) load(designTemplates(project).find((x) => x.id !== t.id) ?? null);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const MIN_LEFT = 280;

export function Designer() {
  const project = useApp((s) => s.project);
  const { template, load, update, undo, redo, past, future, selected, select, format } = useDesigner();
  const [showSafe, setShowSafe] = useState(true);
  const [zonesOpen, setZonesOpen] = useState(false);
  const [showZones, setShowZones] = useState(true);
  const [logicOpen, setLogicOpen] = useState(false);
  const logicCount = useDesigner((s) => s.template?.logic?.nodes.length ?? 0);
  // Panel sizes, adjustable with the splitters.
  const [layout, setLayout] = useLayout('pulse.designerLayout', {
    left: 280,
    right: 340,
    timeline: 300,
    templates: 260,
  });
  // Room for the timeline property values (two 5-digit fields).
  const left = Math.max(MIN_LEFT, layout.left);
  const [background, setBackground] = useState<'checker' | 'black' | 'studio'>('checker');
  const fps = project ? project.frameRate.num / project.frameRate.den : 50;
  usePlayback(fps);
  useShortcuts();
  const saveState = useAutosave();
  const lock = useEditLock(project, template?.id);

  // Opening another project: start on its first template.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    if (openedFor.current !== project.id) {
      openedFor.current = project.id;
      const all = designTemplates(project);
      if (!template || !all.some((t) => t.id === template.id)) load(all[0] ?? null);
    } else if (!template && designTemplates(project).length) load(designTemplates(project)[0]);
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
    update((t) => void t.layers.push(l));
    select([l.id]);
  };

  return (
    <div
      className="designer"
      style={{
        ['--left-w' as string]: `${left}px`,
        ['--right-w' as string]: `${layout.right}px`,
        ['--tl-h' as string]: `${layout.timeline}px`,
        ['--tpl-h' as string]: `${layout.templates}px`,
      }}
    >
      <aside className="panel left">
        <Splitter axis="x" className="edge-right" value={left} min={MIN_LEFT} max={520} reset={280} onChange={(v) => setLayout('left', v)} />
        <TemplateList project={project} />
      </aside>
      <main className="center">
        <div className="toolbar">
          <div className="tool-group">
            <button className="tool" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}>
              <Undo2 size={16} />
            </button>
            <button className="tool" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}>
              <Redo2 size={16} />
            </button>
          </div>
          <FormatBar project={project} />
          <div className="spacer" />
          <ZonesMenu project={project} show={showZones} onShow={setShowZones} onManage={() => setZonesOpen(true)} />
          <button className={`btn small ${logicCount ? 'on' : ''}`} onClick={() => setLogicOpen(true)} title="Relations between values: a box that follows a text, conditions…">
            <Link2 size={13} /> Logic{logicCount ? ` · ${logicCount}` : ''}
          </button>
          <button className={`btn small ${showSafe ? 'on' : ''}`} onClick={() => setShowSafe(!showSafe)} title="Safe areas (action 5 %, title 10 %)">
            <Grid3x3 size={13} />
          </button>
          <button className="btn small bg-toggle" title={`Stage background: ${BG_LABELS[background]} (click to change)`} onClick={() => setBackground(background === 'checker' ? 'black' : background === 'black' ? 'studio' : 'checker')}>
            <span className={`bg-swatch stage-frame bg-${background}`} />
          </button>
          <PublishButton project={project} readOnly={lock.state.status === 'held'} />
          <span className={`save-state ${saveState}`}>{lock.state.status === 'held' ? 'Read only' : saveState === 'saved' ? 'Saved' : 'Saving…'}</span>
        </div>
        <div className="stage-holder">
          <Stage project={project} size={formatById(project, format)} showSafe={showSafe} showZones={showZones} background={background} />
          {lock.state.status === 'held' && <LockBanner holder={lock.state.holder} onTakeOver={lock.takeOver} />}
        </div>
      </main>
      <aside className="panel right">
        <Splitter axis="x" className="edge-left" sign={-1} value={layout.right} min={260} max={620} reset={340} onChange={(v) => setLayout('right', v)} />
        <Inspector />
      </aside>
      <div className="timeline-wrap">
        <Splitter axis="y" className="edge-top" sign={-1} value={layout.timeline} min={140} max={800} reset={300} onChange={(v) => setLayout('timeline', v)} />
        <Timeline fps={fps} leftW={left} onAdd={add} />
      </div>
      {zonesOpen && <ZonesDialog onClose={() => setZonesOpen(false)} />}
      {logicOpen && <LogicEditor onClose={() => setLogicOpen(false)} />}
    </div>
  );
}
