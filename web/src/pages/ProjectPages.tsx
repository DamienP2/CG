import { Download, MonitorPlay, Save, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChannelInfo, FrameRate } from '../engine/types';
import { navigate, projectPath } from '../router';
import { api, can, useApp } from '../store';
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

/** Operator of a project that no channel plays: load it on one. */
export function ChannelPicker({ projectId, channel }: { projectId: string; channel: ChannelInfo | null }) {
  const { channels, projects, live, auth, loadOnChannel } = useApp();
  const operate = can.operate(auth?.user);
  const name = projects.find((p) => p.id === projectId)?.name ?? 'This project';
  const projectName = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.name ?? 'another project') : null);
  const load = async (c: ChannelInfo) => {
    const onAir = Object.keys(live[c.id]?.state.layers ?? {}).length;
    if (onAir && !confirm(`${c.name} has ${onAir} graphics on air. Loading “${name}” clears them. Continue?`)) return;
    await loadOnChannel(c.id, projectId);
    navigate(projectPath(projectId, 'operator', c.id), true);
  };
  const list = channel ? [channel] : channels;
  return (
    <div className="library">
      <div className="library-inner narrow">
        <div className="settings-head">
          <div>
            <h1>{channel ? `${channel.name} plays ${projectName(channel.projectId) ? `“${projectName(channel.projectId)}”` : 'nothing'}` : `${name} is not on air`}</h1>
            <p className="muted">Load the project on an output channel to operate it.</p>
          </div>
        </div>
        <div className="channel-pick">
          {list.map((c) => (
            <div key={c.id} className="channel-pick-row">
              <MonitorPlay size={16} />
              <div className="grow">
                <strong>{c.name}</strong>
                <span className="muted small">
                  {c.width}×{c.height} · {fps(c.frameRate)} fps · {projectName(c.projectId) ? `plays “${projectName(c.projectId)}”` : 'free'}
                </span>
              </div>
              <button className="btn small primary" disabled={!operate} onClick={() => load(c)}>
                Load here
              </button>
            </div>
          ))}
          {!list.length && <p className="muted">No output channel you can access.</p>}
        </div>
      </div>
    </div>
  );
}

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
