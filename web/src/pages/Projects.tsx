import { Copy, Database, Download, Folder, FolderOpen, FolderPlus, Images, Inbox, Layers, LayoutGrid, MonitorPlay, MoreHorizontal, PenTool, Pencil, Plus, Radio, Search, Settings as SettingsIcon, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FrameRate, ProjectSummary } from '../engine/types';
import { api, can, useApp } from '../store';
import { projectPath, projectTab, type ProjectPage } from '../router';
import { confirmDialog, promptDialog } from '../ui/dialogs';

export const FORMATS: {
  label: string;
  width: number;
  height: number;
  rate: FrameRate;
}[] = [
  { label: '1080p 50', width: 1920, height: 1080, rate: { num: 50, den: 1 } },
  { label: '1080p 25', width: 1920, height: 1080, rate: { num: 25, den: 1 } },
  {
    label: '1080p 59.94',
    width: 1920,
    height: 1080,
    rate: { num: 60000, den: 1001 },
  },
  {
    label: '1080p 29.97',
    width: 1920,
    height: 1080,
    rate: { num: 30000, den: 1001 },
  },
  { label: '720p 50', width: 1280, height: 720, rate: { num: 50, den: 1 } },
  {
    label: '2160p 50 (UHD)',
    width: 3840,
    height: 2160,
    rate: { num: 50, den: 1 },
  },
  {
    label: 'Vertical 1080×1920 30',
    width: 1080,
    height: 1920,
    rate: { num: 30, den: 1 },
  },
  {
    label: 'Square 1080×1080 30',
    width: 1080,
    height: 1080,
    rate: { num: 30, den: 1 },
  },
];

const fps = (r: FrameRate) => +(r.num / r.den).toFixed(2);

function NewProject({ from, folder, onClose }: { from?: ProjectSummary; folder?: string; onClose: () => void }) {
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
      // Opened now: a tab opened after the request would be blocked as a popup.
      const tab = from ? null : window.open('about:blank');
      const p = await api<ProjectSummary>(
        'POST',
        '/api/projects',
        from
          ? { name, description, from: from.id }
          : {
              name,
              description,
              width: f.width,
              height: f.height,
              frameRate: f.rate,
            },
      ).catch((e) => {
        tab?.close();
        throw e;
      });
      onClose();
      if (folder) {
        const f = useApp.getState().folders;
        await useApp.getState().saveFolders({ ...f, assign: { ...f.assign, [p.id]: folder } });
      }
      if (tab) {
        tab.name = projectTab(p.id);
        tab.location.href = projectPath(p.id);
      }
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

type View = { kind: 'all' } | { kind: 'unfiled' } | { kind: 'folder'; name: string };
type Sort = 'name' | 'templates';

export function Projects() {
  const { projects, channels, auth, toast, folders, saveFolders } = useApp();
  const user = auth?.user;
  const design = can.design(user);
  const [dialog, setDialog] = useState<{ from?: ProjectSummary } | null>(null);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('name');
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  // A folder deleted elsewhere.
  useEffect(() => {
    if (view.kind === 'folder' && !folders.folders.includes(view.name)) setView({ kind: 'all' });
  }, [folders, view]);

  const folderOf = (id: string) => (folders.folders.includes(folders.assign[id]) ? folders.assign[id] : null);
  const inView = (p: ProjectSummary) => (view.kind === 'all' ? true : view.kind === 'unfiled' ? !folderOf(p.id) : folderOf(p.id) === view.name);
  const q = query.trim().toLowerCase();
  const shown = projects
    .filter((p) => inView(p) && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)))
    .sort((a, b) => (sort === 'templates' ? b.templates - a.templates : 0) || a.name.localeCompare(b.name));
  const count = (f: string | null) => projects.filter((p) => folderOf(p.id) === f).length;

  const moveTo = (id: string, folder: string | null) => {
    const assign = { ...folders.assign };
    if (folder) assign[id] = folder;
    else delete assign[id];
    void saveFolders({ ...folders, assign });
  };
  const newFolder = async () => {
    const name = await promptDialog({ title: 'New folder', label: 'Name', placeholder: 'Sport, News, Elections…', confirm: 'Create' });
    if (!name) return;
    if (folders.folders.includes(name)) return setView({ kind: 'folder', name });
    void saveFolders({ ...folders, folders: [...folders.folders, name].sort((a, b) => a.localeCompare(b)) });
    setView({ kind: 'folder', name });
  };
  const renameFolder = async (old: string) => {
    const name = await promptDialog({ title: 'Rename the folder', label: 'Name', value: old, confirm: 'Rename' });
    if (!name || name === old) return;
    if (folders.folders.includes(name)) return toast(`A folder “${name}” already exists`, 'error');
    const assign = Object.fromEntries(Object.entries(folders.assign).map(([p, f]) => [p, f === old ? name : f]));
    void saveFolders({ folders: folders.folders.map((f) => (f === old ? name : f)).sort((a, b) => a.localeCompare(b)), assign });
    setView({ kind: 'folder', name });
  };
  const deleteFolder = async (name: string) => {
    const n = count(name);
    if (!(await confirmDialog({ title: `Delete the folder “${name}”?`, message: n ? `Its ${n} project${n > 1 ? 's go' : ' goes'} back to the top level (they are not deleted).` : undefined, confirm: 'Delete', danger: true }))) return;
    const assign = Object.fromEntries(Object.entries(folders.assign).filter(([, f]) => f !== name));
    void saveFolders({ folders: folders.folders.filter((f) => f !== name), assign });
    setView({ kind: 'all' });
  };

  const importFile = async (file: File) => {
    try {
      const p = await api<ProjectSummary>('POST', '/api/projects/import', JSON.parse(await file.text()));
      if (view.kind === 'folder') moveTo(p.id, view.name);
      toast(`Imported “${p.name}”`);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, 'error');
    }
  };
  const remove = async (p: ProjectSummary) => {
    const used = channels.filter((c) => c.projectId === p.id).map((c) => c.name);
    const warn = used.length ? ` It is loaded on ${used.join(', ')} and will be unloaded.` : '';
    if (!(await confirmDialog({ title: `Delete the project “${p.name}”?`, message: `Its ${p.templates} templates and its media are deleted. This cannot be undone.${warn}`, confirm: 'Delete', danger: true }))) return;
    await api('DELETE', `/api/projects/${encodeURIComponent(p.id)}`).catch((e) => toast((e as Error).message, 'error'));
  };

  // Drop target: a folder (name), or the top level (null).
  const drop = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!design || !e.dataTransfer.types.includes('application/x-pulse-project')) return;
      e.preventDefault();
      setDropOn(target ?? '');
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData('application/x-pulse-project');
      setDropOn(null);
      if (id) moveTo(id, target);
    },
  });

  const title = view.kind === 'all' ? 'All projects' : view.kind === 'unfiled' ? 'Not in a folder' : view.name;
  const navItem = (key: string, v: View, icon: React.ReactNode, label: string, n: number, target?: string | null, actions?: React.ReactNode) => {
    const on = view.kind === v.kind && (v.kind !== 'folder' || (view.kind === 'folder' && view.name === v.name));
    return (
      <div key={key} className={`lib-nav-item ${on ? 'on' : ''} ${target !== undefined && dropOn === (target ?? '') ? 'drop' : ''}`} onClick={() => setView(v)} {...(target !== undefined ? drop(target) : {})}>
        {icon}
        <span className="grow">{label}</span>
        {actions}
        <span className="count">{n}</span>
      </div>
    );
  };

  return (
    <div className="projects-page">
      <aside className="lib-nav">
        <div className="lib-nav-section">Library</div>
        {navItem('all', { kind: 'all' }, <LayoutGrid size={15} />, 'All projects', projects.length)}
        {navItem('unfiled', { kind: 'unfiled' }, <Inbox size={15} />, 'Not in a folder', count(null), null)}
        <div className="lib-nav-section">
          <span className="grow">Folders</span>
          {design && (
            <button className="icon-btn ghost" title="New folder" onClick={newFolder}>
              <FolderPlus size={14} />
            </button>
          )}
        </div>
        {folders.folders.map((f) =>
          navItem(
            `f-${f}`,
            { kind: 'folder', name: f },
            view.kind === 'folder' && view.name === f ? <FolderOpen size={15} /> : <Folder size={15} />,
            f,
            count(f),
            f,
            design && (
              <span className="lib-nav-actions">
                <button className="icon-btn ghost" title="Rename" onClick={(e) => (e.stopPropagation(), renameFolder(f))}>
                  <Pencil size={12} />
                </button>
                <button className="icon-btn ghost" title="Delete the folder" onClick={(e) => (e.stopPropagation(), deleteFolder(f))}>
                  <Trash2 size={12} />
                </button>
              </span>
            ),
          ),
        )}
        {!folders.folders.length && <p className="lib-nav-hint">{design ? 'Create folders to sort your shows, then drag projects onto them.' : 'No folder.'}</p>}
      </aside>

      <main className="library">
        <div className="library-inner wide">
          <div className="settings-head">
            <div>
              <h1>{title}</h1>
              <p className="muted">
                {shown.length} project{shown.length === 1 ? '' : 's'} · each one opens in its own browser tab
              </p>
            </div>
            <div className="spacer" />
            {design && (
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

          <div className="media-toolbar">
            <label className="search">
              <Search size={14} />
              <input value={query} placeholder="Search projects" onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="spacer" />
            <label className="sort">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="name">Name</option>
                <option value="templates">Templates</option>
              </select>
            </label>
          </div>

          <div className="project-grid">
            {shown.map((p) => {
              const on = channels.filter((c) => c.projectId === p.id);
              const folder = folderOf(p.id);
              const link = (sub: ProjectPage, icon: React.ReactNode, label: string, show = true) =>
                show && (
                  <a className="project-link" href={projectPath(p.id, sub)} target={projectTab(p.id)} title={`Open the ${label.toLowerCase()} in the project's tab`}>
                    {icon}
                    <span>{label}</span>
                  </a>
                );
              const ratio = p.width / p.height;
              return (
                <div
                  key={p.id}
                  className="project-card"
                  draggable={design}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-pulse-project', p.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                >
                  <a className="project-cover" href={projectPath(p.id, design ? 'designer' : 'operator')} target={projectTab(p.id)} draggable={false} style={{ aspectRatio: String(Math.max(16 / 9, ratio)) }}>
                    {p.cover ? <img src={`/api/projects/${encodeURIComponent(p.id)}/templates/${encodeURIComponent(p.cover)}/thumbnail.png?v=${p.templates}-${p.rundown}`} alt="" loading="lazy" draggable={false} style={{ aspectRatio: String(ratio) }} /> : <span className="project-cover-empty">No template yet</span>}
                    <span className="project-badge">
                      <span className="ratio" style={ratio >= 1 ? { width: 14, height: 14 / ratio } : { width: 14 * ratio, height: 14 }} />
                      {p.width}×{p.height} · {fps(p.frameRate)}p
                    </span>
                    {on.length > 0 && (
                      <span className="project-channel" title="Loaded on">
                        <MonitorPlay size={11} /> {on.map((c) => c.name).join(', ')}
                      </span>
                    )}
                  </a>
                  <div className="project-body">
                    <div className="project-head">
                      <strong>{p.name}</strong>
                      <div className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
                        <button className="icon-btn ghost" title="More" onClick={() => setMenu(menu === p.id ? null : p.id)}>
                          <MoreHorizontal size={16} />
                        </button>
                        {menu === p.id && (
                          <div className="menu project-menu">
                            {design && (
                              <>
                                <div className="menu-label">Move to</div>
                                <button disabled={!folder} onClick={() => (moveTo(p.id, null), setMenu(null))}>
                                  <Inbox size={13} /> Top level
                                </button>
                                {folders.folders.map((f) => (
                                  <button key={f} disabled={folder === f} onClick={() => (moveTo(p.id, f), setMenu(null))}>
                                    <Folder size={13} /> {f}
                                  </button>
                                ))}
                                <div className="menu-sep" />
                                <button onClick={() => (setDialog({ from: p }), setMenu(null))}>
                                  <Copy size={13} /> Duplicate
                                </button>
                              </>
                            )}
                            <a href={`/api/projects/${encodeURIComponent(p.id)}/export`} onClick={() => setMenu(null)}>
                              <Download size={13} /> Export
                            </a>
                            {design && (
                              <button className="danger" onClick={() => (remove(p), setMenu(null))}>
                                <Trash2 size={13} /> Delete
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="project-desc">{p.description || <span className="muted">No description</span>}</p>
                    <div className="project-meta">
                      <span>
                        <Layers size={12} /> {p.templates} template{p.templates === 1 ? '' : 's'}
                      </span>
                      {folder && view.kind !== 'folder' && (
                        <span>
                          <Folder size={12} /> {folder}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="project-links">
                    {link('designer', <PenTool size={15} />, 'Designer', design)}
                    {link('operator', <Radio size={15} />, 'Operator', can.operate(user))}
                    {link('data', <Database size={15} />, 'Data', design)}
                    {link('media', <Images size={15} />, 'Media', can.operate(user))}
                    {link('settings', <SettingsIcon size={15} />, 'Settings', design)}
                  </div>
                </div>
              );
            })}
            {design && view.kind !== 'unfiled' && !q && (
              <button className="project-new" onClick={() => setDialog({})}>
                <Plus size={22} />
                <span>New project{view.kind === 'folder' ? ` in ${view.name}` : ''}</span>
              </button>
            )}
            {shown.length === 0 && (q || !design) && (
              <div className="empty big">
                <Radio size={22} />
                <p>{q ? 'No project matches.' : 'No project here.'}</p>
              </div>
            )}
          </div>
        </div>
      </main>
      {dialog && <NewProject from={dialog.from} folder={view.kind === 'folder' ? view.name : undefined} onClose={() => setDialog(null)} />}
    </div>
  );
}
