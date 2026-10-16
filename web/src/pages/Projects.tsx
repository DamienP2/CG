import { Copy, Download, FolderOpen, Layers, MonitorPlay, PenTool, Plus, Radio, Trash2, Upload, X } from 'lucide-react';
import { useState } from 'react';
import type { FrameRate, ProjectSummary } from '../engine/types';
import { api, can, useApp } from '../store';
import { navigate } from '../router';

export const FORMATS: { label: string; width: number; height: number; rate: FrameRate }[] = [
  { label: '1080p 50', width: 1920, height: 1080, rate: { num: 50, den: 1 } },
  { label: '1080p 25', width: 1920, height: 1080, rate: { num: 25, den: 1 } },
  { label: '1080p 59.94', width: 1920, height: 1080, rate: { num: 60000, den: 1001 } },
  { label: '1080p 29.97', width: 1920, height: 1080, rate: { num: 30000, den: 1001 } },
  { label: '720p 50', width: 1280, height: 720, rate: { num: 50, den: 1 } },
  { label: '2160p 50 (UHD)', width: 3840, height: 2160, rate: { num: 50, den: 1 } },
  { label: 'Vertical 1080×1920 30', width: 1080, height: 1920, rate: { num: 30, den: 1 } },
  { label: 'Square 1080×1080 30', width: 1080, height: 1080, rate: { num: 30, den: 1 } },
];

const fps = (r: FrameRate) => +(r.num / r.den).toFixed(2);

function NewProject({ from, onClose }: { from?: ProjectSummary; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState(from ? `${from.name} copy` : '');
  const [description, setDescription] = useState(from?.description ?? '');
  const [format, setFormat] = useState(0);
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const f = FORMATS[format];
    try {
      const p = await api<ProjectSummary>('POST', '/api/projects', from ? { name, description, from: from.id } : { name, description, width: f.width, height: f.height, frameRate: f.rate });
      onClose();
      if (!from) navigate(`/designer/${p.id}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <form className="modal" onSubmit={create} onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{from ? `Duplicate “${from.name}”` : 'New project'}</h2>
          <button type="button" className="icon-btn ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <label className="set-field">
          <span className="set-label">Name</span>
          <input autoFocus value={name} placeholder="Evening news, Match day…" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="set-field">
          <span className="set-label">Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {!from && (
          <label className="set-field">
            <span className="set-label">Design format</span>
            <select value={format} onChange={(e) => setFormat(+e.target.value)}>
              {FORMATS.map((f, i) => (
                <option key={f.label} value={i}>
                  {f.label}
                </option>
              ))}
            </select>
            <span className="set-hint">Channels in another format scale the graphics to fit.</span>
          </label>
        )}
        <footer>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            <Plus size={14} /> {from ? 'Duplicate' : 'Create'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function Projects() {
  const { projects, channels, auth, toast } = useApp();
  const user = auth?.user;
  const [dialog, setDialog] = useState<{ from?: ProjectSummary } | null>(null);

  const importFile = async (file: File) => {
    try {
      const p = await api<ProjectSummary>('POST', '/api/projects/import', JSON.parse(await file.text()));
      toast(`Imported “${p.name}”`);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error');
    }
  };
  const remove = async (p: ProjectSummary) => {
    const used = channels.filter((c) => c.projectId === p.id).map((c) => c.name);
    const warn = used.length ? `\n\nIt is loaded on ${used.join(', ')} and will be unloaded.` : '';
    if (!confirm(`Delete the project “${p.name}” with its ${p.templates} templates? This cannot be undone.${warn}`)) return;
    await api('DELETE', `/api/projects/${encodeURIComponent(p.id)}`).catch((e) => toast((e as Error).message, 'error'));
  };

  return (
    <div className="library">
      <div className="library-inner">
        <div className="settings-head">
          <div>
            <h1>Projects</h1>
            <p className="muted">One project per show: its templates, widgets and rundown. Load a project on an output channel to play it.</p>
          </div>
          <div className="spacer" />
          {can.design(user) && (
            <>
              <label className="btn" title="Import a .pulsecg.json file">
                <Upload size={14} /> Import
                <input type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
              </label>
              <button className="btn primary" onClick={() => setDialog({})}>
                <Plus size={14} /> New project
              </button>
            </>
          )}
        </div>

        <div className="project-grid">
          {projects.map((p) => {
            const on = channels.filter((c) => c.projectId === p.id);
            return (
              <div key={p.id} className="project-card">
                <div className="project-top" onClick={() => navigate(can.design(user) ? `/designer/${p.id}` : on[0] ? `/operator/${on[0].id}` : `/designer/${p.id}`)}>
                  <div className="project-icon">
                    <FolderOpen size={22} />
                  </div>
                  <div className="project-text">
                    <strong>{p.name}</strong>
                    <span className="muted">{p.description || 'No description'}</span>
                  </div>
                </div>
                <div className="project-meta">
                  <span>
                    <Layers size={12} /> {p.templates} templates
                  </span>
                  <span>
                    {p.width}×{p.height} · {fps(p.frameRate)} fps
                  </span>
                </div>
                <div className="project-channels">
                  {on.length ? (
                    on.map((c) => (
                      <button key={c.id} className="chip live" onClick={() => navigate(`/operator/${c.id}`)} title="Open the operator on this channel">
                        <MonitorPlay size={11} /> {c.name}
                      </button>
                    ))
                  ) : (
                    <span className="muted small">Not loaded on any channel</span>
                  )}
                </div>
                <div className="project-actions">
                  {can.design(user) && (
                    <button className="btn small" onClick={() => navigate(`/designer/${p.id}`)}>
                      <PenTool size={13} /> Design
                    </button>
                  )}
                  {can.operate(user) && channels.length > 0 && (
                    <select
                      className="small"
                      value=""
                      title="Load on a channel"
                      onChange={async (e) => {
                        const cid = e.target.value;
                        if (!cid) return;
                        await useApp.getState().loadOnChannel(cid, p.id);
                        navigate(`/operator/${cid}`);
                      }}
                    >
                      <option value="">Load on…</option>
                      {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="spacer" />
                  <a className="icon-btn ghost" title="Export" href={`/api/projects/${encodeURIComponent(p.id)}/export`}>
                    <Download size={14} />
                  </a>
                  {can.design(user) && (
                    <>
                      <button className="icon-btn ghost" title="Duplicate" onClick={() => setDialog({ from: p })}>
                        <Copy size={14} />
                      </button>
                      <button className="icon-btn ghost" title="Delete" onClick={() => remove(p)}>
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {projects.length === 0 && (
            <div className="empty big">
              <Radio size={22} />
              <p>No project you can access yet.</p>
            </div>
          )}
        </div>
      </div>
      {dialog && <NewProject from={dialog.from} onClose={() => setDialog(null)} />}
    </div>
  );
}
