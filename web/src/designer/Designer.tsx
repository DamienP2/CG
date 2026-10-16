import { ChevronDown, LayoutGrid, Circle, Copy, FileUp, Folder, Grid3x3, Image, Link2, Plus, Settings2, Redo2, Sparkles, Square, Trash2, Type, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { newId, num, propValue } from '../engine/evaluate';
import type { Layer, LayerType, Project, Template } from '../engine/types';
import { importAfterEffects, thumbnailUrl, useApp } from '../store';
import { descendants, duplicateLayers, findLayer, makeLayer, newTemplate, setProp, useDesigner, WIDGET_PRESETS } from './designerStore';
import { Inspector } from './Inspector';
import { ICONS, LayersPanel } from './LayersPanel';
import { Stage } from './Stage';
import { Timeline } from './Timeline';
import { ZonesDialog } from './ZonesDialog';
import { LogicEditor } from './LogicEditor';
import { Splitter, useLayout } from '../ui/Splitter';
import { FormatBar } from './Formats';
import { formatById } from '../engine/formats';

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
      // Like on air: stop on the On air, pause and Out markers (Loop plays through).
      if (!st.loop) {
        const stop = t.markers.filter((m) => (m.kind === 'pause' || m.kind === 'out') && m.frame > st.frame + 1e-3 && m.frame <= next).sort((a, b) => a.frame - b.frame)[0];
        if (stop) {
          useDesigner.setState({ frame: stop.frame, playing: false });
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
  // The saved form (every format), not the view being edited.
  const template = useDesigner((s) => s.base);
  const saveTemplate = useApp((s) => s.saveTemplate);
  const first = useRef(true);
  const [state, setState] = useState<'saved' | 'pending'>('saved');
  useEffect(() => {
    if (!template) return;
    if (first.current) {
      first.current = false;
      return;
    }
    setState('pending');
    const h = setTimeout(async () => {
      await saveTemplate(template);
      setState('saved');
    }, 500);
    return () => clearTimeout(h);
  }, [template, saveTemplate]);
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
        const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key] ?? [0, 0];
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
          setOpen(open ? null : { left: Math.min(r.left, window.innerWidth - 260), top: r.bottom + 6 });
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

const BG_LABELS = { checker: 'transparent', black: 'black', studio: 'studio' } as const;

function TemplateList({ project }: { project: Project }) {
  const { template, load, format } = useDesigner();
  const { saveTemplate, deleteTemplate, toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const create = async (base?: Template) => {
    const t = base ? { ...structuredClone(base), id: newId(), name: `${base.name} copy` } : newTemplate(`Template ${project.templates.length + 1}`, project.zones[0]?.id);
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
      {project.templates.map((t) => (
        <div key={t.id} className={`template-item ${template?.id === t.id ? 'selected' : ''}`} onClick={() => template?.id !== t.id && load(t)}>
          <img src={thumbnailUrl(project.id, t, format)} alt="" loading="lazy" />
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
                if (template?.id === t.id) load(project.templates.find((x) => x.id !== t.id) ?? null);
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

function WidgetMenu({ onPick }: { onPick: (w: (typeof WIDGET_PRESETS)[number]) => void }) {
  // Fixed position: the toolbar scrolls sideways and would clip the menu.
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
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
      <button className={`tool wide ${open ? 'on' : ''}`} title="Prefab widgets"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { left: Math.max(8, Math.min(r.left, window.innerWidth - 650)), top: r.bottom + 6 });
        }}
      >
        <Sparkles size={15} /> Widgets <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu widget-menu" style={{ position: 'fixed', left: open.left, top: open.top }}>
          {WIDGET_PRESETS.map((w) => {
            const Icon = ICONS[w.type];
            return (
              <button
                key={w.key}
                onClick={() => {
                  setOpen(null);
                  onPick(w);
                }}
              >
                <Icon size={15} />
                <span>
                  <strong>{w.label}</strong>
                  <em>{w.hint}</em>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Designer() {
  const project = useApp((s) => s.project);
  const { template, load, update, undo, redo, past, future, selected, select, format } = useDesigner();
  const [showSafe, setShowSafe] = useState(true);
  const [zonesOpen, setZonesOpen] = useState(false);
  const [showZones, setShowZones] = useState(true);
  const [logicOpen, setLogicOpen] = useState(false);
  const logicCount = useDesigner((s) => s.template?.logic?.nodes.length ?? 0);
  // Panel sizes, adjustable with the splitters.
  const [layout, setLayout] = useLayout('pulse.designerLayout', { left: 250, right: 340, timeline: 300, templates: 260 });
  const [background, setBackground] = useState<'checker' | 'black' | 'studio'>('checker');
  const fps = project ? project.frameRate.num / project.frameRate.den : 50;
  usePlayback(fps);
  useShortcuts();
  const saveState = useAutosave();

  // Opening another project: start on its first template.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    if (openedFor.current !== project.id) {
      openedFor.current = project.id;
      if (!template || !project.templates.some((t) => t.id === template.id)) load(project.templates[0] ?? null);
    } else if (!template && project.templates.length) load(project.templates[0]);
  }, [project, template, load]);

  if (!project) return <div className="loading">Connecting…</div>;

  const add = (type: LayerType, patch?: Record<string, unknown>, name?: string) => {
    const parent = selected.length === 1 && template && findLayer(template, selected[0])?.type === 'group' ? selected[0] : null;
    const size = formatById(project, useDesigner.getState().format);
    const l = { ...makeLayer(type, size.width, size.height, parent), ...patch } as Layer;
    if (name) l.name = name;
    update((t) => void t.layers.push(l));
    select([l.id]);
  };

  return (
    <div
      className="designer"
      style={{ ['--left-w' as string]: `${layout.left}px`, ['--right-w' as string]: `${layout.right}px`, ['--tl-h' as string]: `${layout.timeline}px`, ['--tpl-h' as string]: `${layout.templates}px` }}
    >
      <aside className="panel left">
        <Splitter axis="x" className="edge-right" value={layout.left} min={180} max={520} reset={250} onChange={(v) => setLayout('left', v)} />
        <TemplateList project={project} />
        <Splitter axis="y" className="inline" value={layout.templates} min={60} max={800} reset={260} onChange={(v) => setLayout('templates', v)} />
        <div className="panel-title">Layers</div>
        <LayersPanel />
      </aside>
      <main className="center">
        <div className="toolbar">
          <div className="tool-group">
            <button className="tool" title="Rectangle" onClick={() => add('rect')}>
              <Square size={16} />
            </button>
            <button className="tool" title="Ellipse" onClick={() => add('ellipse')}>
              <Circle size={16} />
            </button>
            <button className="tool" title="Text" onClick={() => add('text')}>
              <Type size={16} />
            </button>
            <button className="tool" title="Image" onClick={() => add('image')}>
              <Image size={16} />
            </button>
            <button className="tool" title="Group" onClick={() => add('group')}>
              <Folder size={16} />
            </button>
            <WidgetMenu onPick={(w) => add(w.type, w.patch, w.label)} />
          </div>
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
          <button
            className="btn small bg-toggle"
            title={`Stage background: ${BG_LABELS[background]} (click to change)`}
            onClick={() => setBackground(background === 'checker' ? 'black' : background === 'black' ? 'studio' : 'checker')}
          >
            <span className={`bg-swatch stage-frame bg-${background}`} />
          </button>
          <span className={`save-state ${saveState}`}>{saveState === 'saved' ? 'Saved' : 'Saving…'}</span>
        </div>
        <Stage project={project} size={formatById(project, format)} showSafe={showSafe} showZones={showZones} background={background} />
        <div className="timeline-wrap">
          <Splitter axis="y" className="edge-top" sign={-1} value={layout.timeline} min={120} max={800} reset={300} onChange={(v) => setLayout('timeline', v)} />
          <Timeline fps={fps} />
        </div>
      </main>
      <aside className="panel right">
        <Splitter axis="x" className="edge-left" sign={-1} value={layout.right} min={260} max={620} reset={340} onChange={(v) => setLayout('right', v)} />
        <Inspector />
      </aside>
      {zonesOpen && <ZonesDialog onClose={() => setZonesOpen(false)} />}
      {logicOpen && <LogicEditor onClose={() => setLogicOpen(false)} />}
    </div>
  );
}
