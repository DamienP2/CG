import { Plus, RectangleHorizontal, RectangleVertical, Square, Wand2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { adaptTemplate, projectFormats } from '../engine/formats';
import { MAIN_FORMAT, type Format, type Project } from '../engine/types';
import { api, useApp } from '../store';
import { useDesigner } from './designerStore';

const PRESETS = [
  { id: 'vertical', name: '9:16', width: 1080, height: 1920, hint: 'Stories, Reels, TikTok, Shorts' },
  { id: 'square', name: '1:1', width: 1080, height: 1080, hint: 'Feeds' },
  { id: 'portrait', name: '4:5', width: 1080, height: 1350, hint: 'Instagram / Facebook feed' },
  { id: 'landscape', name: '16:9', width: 1920, height: 1080, hint: 'TV, YouTube' },
];

const shapeIcon = (f: { width: number; height: number }) => (f.width > f.height * 1.1 ? RectangleHorizontal : f.height > f.width * 1.1 ? RectangleVertical : Square);

/** Lays every template of the project out in `format` (smart adaptation). */
async function adaptProject(project: Project, format: Format, only?: string) {
  for (const t of project.templates) {
    if (only && t.id !== only) continue;
    const adapted = adaptTemplate(t, project, format);
    await api('PUT', `/api/projects/${encodeURIComponent(project.id)}/templates/${encodeURIComponent(t.id)}`, adapted);
  }
}

function AddFormat({ project, onClose }: { project: Project; onClose: () => void }) {
  const { toast } = useApp();
  const existing = projectFormats(project);
  const free = PRESETS.filter((p) => !existing.some((f) => f.width * p.height === f.height * p.width));
  const [pick, setPick] = useState(free[0] ?? PRESETS[0]);
  const [name, setName] = useState(pick.name);
  const [w, setW] = useState(pick.width);
  const [h, setH] = useState(pick.height);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(pick.name);
    setW(pick.width);
    setH(pick.height);
  }, [pick]);
  const create = async () => {
    setBusy(true);
    let id = pick.id;
    for (let n = 2; existing.some((f) => f.id === id); n++) id = `${pick.id}-${n}`;
    const format: Format = { id, name: name.trim() || pick.name, width: w, height: h };
    try {
      // Save the designer's pending edits first, so the adaptation sees them.
      const st = useDesigner.getState();
      if (st.base) await api('PUT', `/api/projects/${encodeURIComponent(project.id)}/templates/${encodeURIComponent(st.base.id)}`, st.base);
      await api('PUT', `/api/projects/${encodeURIComponent(project.id)}/formats`, [...(project.formats ?? []), format]);
      const fresh = await api<Project>('GET', `/api/projects/${encodeURIComponent(project.id)}`);
      await adaptProject(fresh, format);
      const reloaded = await api<Project>('GET', `/api/projects/${encodeURIComponent(project.id)}`);
      const cur = reloaded.templates.find((t) => t.id === st.base?.id);
      st.setFormat(format.id);
      if (cur) st.load(cur);
      toast(`${format.name} added: every template has a first layout to refine`, 'info');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Add a format</h2>
          <button className="icon-btn ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="hint">
          Every template gets a first layout in the new format: elements keep their corner or edge, bars stretch with their content, sizes fit the safe area, animations are kept. Then refine each template:
          what you change in this format stays in this format.
        </p>
        <div className="role-pick">
          {PRESETS.map((p) => {
            const Icon = shapeIcon(p);
            return (
              <button type="button" key={p.id} className={pick.id === p.id ? 'on' : ''} onClick={() => setPick(p)}>
                <strong>
                  <Icon size={13} /> {p.name}
                </strong>
                <span>
                  {p.width}×{p.height} · {p.hint}
                </span>
              </button>
            );
          })}
        </div>
        <div className="set-grid">
          <label className="set-field">
            <span className="set-label">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="set-field">
            <span className="set-label">Width</span>
            <input type="number" value={w} onChange={(e) => setW(+e.target.value)} />
          </label>
          <label className="set-field">
            <span className="set-label">Height</span>
            <input type="number" value={h} onChange={(e) => setH(+e.target.value)} />
          </label>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || w < 16 || h < 16} onClick={create}>
            <Wand2 size={14} /> {busy ? 'Adapting the templates…' : 'Add and adapt'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Format tabs of the designer (Main 16:9 | 9:16 | +). */
export function FormatBar({ project }: { project: Project }) {
  const { format, setFormat, base, load } = useDesigner();
  const toast = useApp((s) => s.toast);
  const [adding, setAdding] = useState(false);
  const formats = projectFormats(project);
  const current = formats.find((f) => f.id === format) ?? formats[0];
  useEffect(() => {
    if (!formats.some((f) => f.id === format)) setFormat(MAIN_FORMAT);
  }, [formats.length, format]);
  const ratio = (f: Format) => {
    const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
    const d = g(f.width, f.height);
    return `${f.width / d}:${f.height / d}`;
  };
  return (
    <div className="format-bar">
      {formats.map((f) => {
        const Icon = shapeIcon(f);
        return (
          <button key={f.id} className={f.id === current.id ? 'on' : ''} onClick={() => setFormat(f.id)} title={`${f.width}×${f.height}`}>
            <Icon size={13} /> {f.id === MAIN_FORMAT ? `Main ${ratio(f)}` : f.name}
          </button>
        );
      })}
      <button className="add" title="Add a format (9:16, 1:1…)" onClick={() => setAdding(true)}>
        <Plus size={13} />
      </button>
      {current.id !== MAIN_FORMAT && base && (
        <>
          <button
            className="tool-link"
            title="Generate this template's layout again from the main format (replaces its changes in this format)"
            onClick={async () => {
              if (!confirm(`Re-adapt “${base.name}” to ${current.name}? Its changes in ${current.name} are replaced.`)) return;
              const adapted = adaptTemplate(base, project, current);
              load(adapted);
              await api('PUT', `/api/projects/${encodeURIComponent(project.id)}/templates/${encodeURIComponent(base.id)}`, adapted).catch((e) => toast((e as Error).message, 'error'));
            }}
          >
            <Wand2 size={13} /> Re-adapt
          </button>
          <button
            className="tool-link danger"
            title={`Remove the ${current.name} format from the project`}
            onClick={async () => {
              if (!confirm(`Remove the ${current.name} format? Its layouts in every template are deleted.`)) return;
              await api('PUT', `/api/projects/${encodeURIComponent(project.id)}/formats`, (project.formats ?? []).filter((f) => f.id !== current.id)).catch((e) => toast((e as Error).message, 'error'));
              setFormat(MAIN_FORMAT);
            }}
          >
            <X size={13} />
          </button>
        </>
      )}
      {adding && <AddFormat project={project} onClose={() => setAdding(false)} />}
    </div>
  );
}
