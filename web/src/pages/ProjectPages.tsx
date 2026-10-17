import { Download, Save, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FrameRate } from '../engine/types';
import { navigate } from '../router';
import { api, useApp } from '../store';
import { FORMATS } from './Projects';

type ProjectMeta = {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  frameRate: FrameRate;
};

const fps = (r: FrameRate) => +(r.num / r.den).toFixed(2);
const formatIndex = (p: { width: number; height: number; frameRate: FrameRate }) => FORMATS.findIndex((f) => f.width === p.width && f.height === p.height && f.rate.num * p.frameRate.den === p.frameRate.num * f.rate.den);

/** Name, description and design format of a project. */
export function ProjectSettings({ project }: { project: ProjectMeta }) {
  const { toast, channels } = useApp();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [format, setFormat] = useState(formatIndex(project));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setFormat(formatIndex(project));
  }, [project.id, project.name, project.description, project.width, project.height, project.frameRate.num, project.frameRate.den]); // eslint-disable-line react-hooks/exhaustive-deps

  const f = format >= 0 ? FORMATS[format] : null;
  const dirty = name.trim() !== project.name || description !== project.description || format !== formatIndex(project);
  const url = `/api/projects/${encodeURIComponent(project.id)}`;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('PUT', url, {
        name: name.trim(),
        description,
        width: f?.width ?? project.width,
        height: f?.height ?? project.height,
        frameRate: f?.rate ?? project.frameRate,
      });
      toast('Project saved');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const used = channels.filter((c) => c.projectId === project.id).map((c) => c.name);
    const warn = used.length ? `\n\nIt is loaded on ${used.join(', ')} and will be unloaded.` : '';
    if (!confirm(`Delete the project “${project.name}”? This cannot be undone.${warn}`)) return;
    try {
      await api('DELETE', url);
      window.close();
      navigate('/projects', true);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="settings">
      <div className="settings-inner narrow">
        <div className="settings-head">
          <div>
            <h1>Project settings</h1>
            <p className="muted">Name, description and the format the templates are designed in.</p>
          </div>
        </div>
        <form className="set-card" onSubmit={save}>
          <header>
            <SettingsIcon size={16} />
            <h2>General</h2>
          </header>
          <div className="set-body">
            <label className="set-field">
              <span className="set-label">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="set-field">
              <span className="set-label">Description</span>
              <input value={description} placeholder="What this project is for" onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="set-field">
              <span className="set-label">Design format</span>
              <select value={format} onChange={(e) => setFormat(+e.target.value)}>
                {format < 0 && (
                  <option value={-1}>
                    {project.width}×{project.height} · {fps(project.frameRate)} fps
                  </option>
                )}
                {FORMATS.map((x, i) => (
                  <option key={x.label} value={i}>
                    {x.label}
                  </option>
                ))}
              </select>
              <span className="set-hint">The original format of the templates. Changing it does not move or rescale existing layers; channels in another format scale the graphics to fit.</span>
            </label>
            <div className="row end">
              <button className="btn primary" disabled={busy || !dirty || !name.trim()}>
                <Save size={14} /> Save
              </button>
            </div>
          </div>
        </form>
        <section className="set-card">
          <header>
            <Download size={16} />
            <h2>Export and delete</h2>
          </header>
          <div className="set-body">
            <div className="row">
              <a className="btn" href={`${url}/export`}>
                <Download size={14} /> Export (.pulsecg.json)
              </a>
              <div className="spacer" />
              <button type="button" className="btn danger" onClick={remove}>
                <Trash2 size={14} /> Delete project
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
