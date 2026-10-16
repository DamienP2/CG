import { ChevronDown, Circle, Copy, Folder, Grid3x3, Image, Plus, Redo2, Sparkles, Square, Trash2, Type, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { newId, num, propValue } from '../engine/evaluate';
import type { Layer, LayerType, Project, Template } from '../engine/types';
import { thumbnailUrl, useApp } from '../store';
import { descendants, findLayer, makeLayer, newTemplate, setProp, useDesigner, WIDGET_PRESETS } from './designerStore';
import { Inspector } from './Inspector';
import { ICONS, LayersPanel } from './LayersPanel';
import { Stage } from './Stage';
import { Timeline } from './Timeline';

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
      const dt = ((now - last) / 1000) * fps;
      last = now;
      let next = st.frame + dt;
      if (st.playoutPreview) {
        const stop = t.markers.filter((m) => (m.kind === 'pause' || m.kind === 'out') && m.frame > st.frame + 1e-3 && m.frame <= next).sort((a, b) => a.frame - b.frame)[0];
        if (stop) {
          useDesigner.setState({ frame: stop.frame, playing: false });
          return;
        }
      }
      if (next >= t.duration) {
        if (st.loop && !st.playoutPreview) next = 0;
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
  const template = useDesigner((s) => s.template);
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
        st.setPlaying(!st.playing);
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
  const st = useDesigner.getState();
  if (!st.template || !st.selected.length) return;
  const newIds: string[] = [];
  st.update((t) => {
    for (const id of st.selected) {
      const ids = [id, ...descendants(t, id)];
      const map = new Map(ids.map((x) => [x, newId()]));
      const clones = t.layers
        .filter((l) => ids.includes(l.id))
        .map((l) => ({ ...structuredClone(l), id: map.get(l.id)!, parent: l.id === id ? l.parent : map.get(l.parent!) ?? l.parent, name: l.id === id ? `${l.name} copy` : l.name }));
      t.layers.push(...clones);
      newIds.push(map.get(id)!);
    }
  });
  st.select(newIds);
}

function TemplateList({ project }: { project: Project }) {
  const { template, load } = useDesigner();
  const { saveTemplate, deleteTemplate, toast } = useApp();
  const create = async (base?: Template) => {
    const t = base ? { ...structuredClone(base), id: newId(), name: `${base.name} copy` } : newTemplate(`Template ${project.templates.length + 1}`);
    await saveTemplate(t);
    load(t);
  };
  return (
    <div className="template-list">
      <header>
        <span>Templates</span>
        <button className="icon-btn ghost" title="New template" onClick={() => create()}>
          <Plus size={14} />
        </button>
      </header>
      {project.templates.map((t) => (
        <div key={t.id} className={`template-item ${template?.id === t.id ? 'selected' : ''}`} onClick={() => template?.id !== t.id && load(t)}>
          <img src={thumbnailUrl(project.id, t)} alt="" loading="lazy" />
          <span>{t.name}</span>
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
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button className={`tool wide ${open ? 'on' : ''}`} title="Prefab widgets" onClick={() => setOpen(!open)}>
        <Sparkles size={15} /> Widgets <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu widget-menu">
          {WIDGET_PRESETS.map((w) => {
            const Icon = ICONS[w.type];
            return (
              <button
                key={w.key}
                onClick={() => {
                  setOpen(false);
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
  const { template, load, update, undo, redo, past, future, selected, select } = useDesigner();
  const [showSafe, setShowSafe] = useState(true);
  const [background, setBackground] = useState<'checker' | 'black' | 'studio'>('studio');
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
    const l = { ...makeLayer(type, project.width, project.height, parent), ...patch } as Layer;
    if (name) l.name = name;
    update((t) => void t.layers.push(l));
    select([l.id]);
  };

  return (
    <div className="designer">
      <aside className="panel left">
        <TemplateList project={project} />
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
          <div className="spacer" />
          <button className={`btn small ${showSafe ? 'on' : ''}`} onClick={() => setShowSafe(!showSafe)} title="Safe areas">
            <Grid3x3 size={13} /> Safe
          </button>
          <select value={background} onChange={(e) => setBackground(e.target.value as typeof background)} title="Stage background">
            <option value="studio">Studio</option>
            <option value="checker">Transparent</option>
            <option value="black">Black</option>
          </select>
          <span className={`save-state ${saveState}`}>{saveState === 'saved' ? 'Saved' : 'Saving…'}</span>
        </div>
        <Stage project={project} showSafe={showSafe} background={background} />
        <Timeline fps={fps} />
      </main>
      <aside className="panel right">
        <Inspector />
      </aside>
    </div>
  );
}
