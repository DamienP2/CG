import { Check, Copy, Download, File, FileAudio, Film, Image as ImageIcon, Search, Trash2, Type, Upload, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, can, mediaName, mediaUrl, uploadAsset, useApp, useChanged, type MediaFile } from '../store';
import { confirmDialog } from '../ui/dialogs';
import { loadFonts, useFonts } from '../engine/fonts';

type Kind = MediaFile['kind'];

const KINDS: { kind: Kind | 'all'; label: string; icon: typeof File }[] = [
  { kind: 'all', label: 'All', icon: File },
  { kind: 'image', label: 'Images', icon: ImageIcon },
  { kind: 'video', label: 'Videos', icon: Film },
  { kind: 'audio', label: 'Audio', icon: FileAudio },
  { kind: 'font', label: 'Fonts', icon: Type },
  { kind: 'other', label: 'Other', icon: File },
];

const FONT_FILE = /\.(ttf|otf|woff2?|ttc)$/i;

/** Adds fonts to the server (shared by every project). */
async function uploadFonts(files: File[], toast: (m: string, k?: 'info' | 'error') => void) {
  for (const file of files) {
    const name = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    try {
      const res = await fetch(`/api/fonts/${encodeURIComponent(name)}`, { method: 'PUT', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error(await res.text());
      toast(`Font ${file.name} added`, 'info');
    } catch (e) {
      toast(`${file.name}: ${(e as Error).message}`, 'error');
    }
  }
  await loadFonts();
}

/** The fonts of the server: uploaded ones (removable), built in, installed on the machine. */
function FontsPanel({ canEdit }: { canEdit: boolean }) {
  const families = useFonts((s) => s.families);
  const toast = useApp((s) => s.toast);
  const groups: [string, string, typeof families][] = [
    ['Uploaded', 'Added here, for every project', families.filter((f) => f.source === 'uploaded')],
    ['Built in', 'Shipped with Strata', families.filter((f) => f.source === 'bundled')],
    ['Server', 'Installed on the machine', families.filter((f) => f.source === 'system')],
  ];
  const remove = async (file: string, family: string) => {
    if (!(await confirmDialog({ title: `Remove ${family} (${file})?`, message: 'Texts using it fall back to Inter.', confirm: 'Remove', danger: true }))) return;
    try {
      await api('DELETE', `/api/fonts/${encodeURIComponent(file)}`);
      await loadFonts();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="fonts-panel">
      {canEdit && (
        <label className="btn small fonts-add">
          <Upload size={13} /> Add fonts (.ttf, .otf, .woff)
          <input type="file" multiple hidden accept=".ttf,.otf,.woff,.woff2,.ttc" onChange={(e) => e.target.files && void uploadFonts([...e.target.files], toast)} />
        </label>
      )}
      {groups
        .filter(([, , l]) => l.length)
        .map(([title, hint, list]) => (
          <section key={title} className="fonts-group">
            <h3>
              {title} <span className="muted small">{hint}</span>
            </h3>
            <div className="fonts-list">
              {list.map((f) => (
                <div key={f.family} className="font-row">
                  <span className="font-sample" style={{ fontFamily: `"${f.family}"` }}>
                    {f.family}
                  </span>
                  <span className="muted small">{f.weights.join(' · ')}</span>
                  <span className="spacer" />
                  {canEdit &&
                    (f.files ?? []).map((file) => (
                      <button key={file} className="icon-btn danger" title={`Remove ${file}`} onClick={() => void remove(file, f.family)}>
                        <Trash2 size={13} />
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

const ICON: Record<Kind, typeof File> = { image: ImageIcon, video: Film, audio: FileAudio, font: Type, other: File };

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

type Upload = { name: string; progress: number; error?: string };

/**
 * A media library: the files of one project (`projectId`), or the files
 * shared by every project. Upload by button or by dropping files anywhere.
 */
export function MediaLibrary({ projectId }: { projectId?: string }) {
  const { auth, toast } = useApp();
  const user = auth?.user;
  const canUpload = !!user && user.role !== 'viewer';
  const canDelete = can.design(user);
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const families = useFonts((s) => s.families);
  useEffect(() => {
    if (!families.length) void loadFonts();
  }, [families.length]);
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const depth = useRef(0);
  const url = mediaUrl(projectId);

  const refresh = () =>
    api<MediaFile[]>('GET', url)
      .then(setFiles)
      .catch((e) => toast((e as Error).message, 'error'));
  // Uploads and deletions by other users.
  useChanged(projectId ? `media:${projectId}` : 'media', () => void refresh());
  useEffect(() => {
    setFiles(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const upload = async (list: FileList | File[]) => {
    // Fonts are global: they go to the server's fonts, never to a project.
    const fonts = [...list].filter((f) => FONT_FILE.test(f.name));
    if (fonts.length) {
      if (projectId) toast('Fonts are shared by every project: add them in Assets (top bar).', 'error');
      else await uploadFonts(fonts, toast);
    }
    const todo = [...list].filter((f) => !FONT_FILE.test(f.name));
    if (!todo.length) return;
    const existing = new Set(files?.map((f) => f.name));
    const replaced = todo.filter((f) => existing.has(mediaName(f.name))).map((f) => mediaName(f.name));
    if (replaced.length && !(await confirmDialog({ title: `Replace ${replaced.join(', ')}?`, message: `Templates using ${replaced.length > 1 ? 'them' : 'it'} show the new file.`, confirm: 'Replace' }))) return;
    setUploads((u) => [...u, ...todo.map((f) => ({ name: f.name, progress: 0 }))]);
    await Promise.all(
      todo.map(async (f) => {
        const set = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, ...patch } : x)));
        try {
          await uploadAsset(f, projectId, (progress) => set({ progress }));
          setUploads((u) => u.filter((x) => x.name !== f.name));
        } catch (e) {
          set({ error: (e as Error).message });
        }
      }),
    );
    void refresh();
  };

  const remove = async (m: MediaFile) => {
    if (!(await confirmDialog({ title: `Delete “${m.name}”?`, message: 'Templates that use it will show nothing in its place.', confirm: 'Delete', danger: true }))) return;
    try {
      await api('DELETE', `${url}/${encodeURIComponent(m.name)}`);
      setFiles((l) => l?.filter((x) => x.src !== m.src) ?? null);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const copy = async (m: MediaFile) => {
    try {
      await navigator.clipboard.writeText(m.src);
      setCopied(m.src);
      setTimeout(() => setCopied((c) => (c === m.src ? null : c)), 1500);
    } catch {
      toast(m.src);
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: files?.length ?? 0 };
    for (const f of files ?? []) c[f.kind] = (c[f.kind] ?? 0) + 1;
    return c;
  }, [files]);
  const total = useMemo(() => (files ?? []).reduce((n, f) => n + f.size, 0), [files]);
  const shown = (files ?? []).filter((f) => (kind === 'all' || f.kind === kind) && f.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div
      className={`library media-page ${dragging ? 'dragging' : ''}`}
      onDragEnter={(e) => {
        if (!canUpload || !e.dataTransfer.types.includes('Files')) return;
        depth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        if (--depth.current <= 0) {
          depth.current = 0;
          setDragging(false);
        }
      }}
      onDragOver={(e) => canUpload && e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (canUpload) void upload(e.dataTransfer.files);
      }}
    >
      <div className="library-inner">
        <div className="settings-head">
          <div>
            <h1>{projectId ? 'Assets' : 'Shared assets'}</h1>
            <p className="muted">
              {projectId ? 'Images, videos and files of this project. Fonts are shared: see Assets in the top bar.' : 'Images, videos, files and fonts every project can use.'} {files ? `${files.length} file${files.length === 1 ? '' : 's'} · ${formatSize(total)}` : ''}
            </p>
          </div>
          <div className="spacer" />
          {canUpload && (
            <label className="btn primary">
              <Upload size={14} /> Upload
              <input type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
            </label>
          )}
        </div>

        <div className="media-toolbar">
          <div className="seg">
            {KINDS.filter((k) => k.kind === 'all' || (k.kind === 'font' ? !projectId : counts[k.kind])).map(({ kind: k, label, icon: Icon }) => (
              <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                <Icon size={13} /> {label} <span className="count">{k === 'font' ? families.length : (counts[k] ?? 0)}</span>
              </button>
            ))}
          </div>
          <div className="spacer" />
          <label className="search">
            <Search size={14} />
            <input value={query} placeholder="Search files" onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>

        {uploads.length > 0 && (
          <div className="uploads">
            {uploads.map((u) => (
              <div key={u.name} className={`upload-row ${u.error ? 'error' : ''}`}>
                <span className="grow">{u.name}</span>
                {u.error ? (
                  <>
                    <span className="small">{u.error}</span>
                    <button className="btn small" onClick={() => setUploads((l) => l.filter((x) => x.name !== u.name))}>
                      Dismiss
                    </button>
                  </>
                ) : (
                  <div className="bar">
                    <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {kind === 'font' && !projectId ? (
          <FontsPanel canEdit={canDelete} />
        ) : files && files.length === 0 ? (
          <label className={`media-empty ${canUpload ? '' : 'static'}`}>
            <UploadCloud size={36} />
            <strong>No media yet</strong>
            <span className="muted">{canUpload ? 'Drop files here or click to upload: images, videos, audio, fonts…' : 'Nothing has been uploaded.'}</span>
            {canUpload && <input type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />}
          </label>
        ) : (
          <div className="media-grid">
            {shown.map((m) => {
              const Icon = ICON[m.kind];
              return (
                <div key={m.src} className="media-tile" title={m.src}>
                  <div className="media-preview">
                    {m.kind === 'image' ? (
                      <img src={`${m.src}?v=${m.modified}`} alt="" loading="lazy" />
                    ) : m.kind === 'video' ? (
                      <>
                        <Icon size={30} />
                        <video src={`${m.src}?v=${m.modified}#t=0.5`} muted preload="metadata" onError={(e) => (e.currentTarget.style.display = 'none')} onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
                      </>
                    ) : (
                      <Icon size={30} />
                    )}
                    <span className={`media-kind ${m.kind}`}>
                      <Icon size={11} /> {m.name.split('.').pop()?.toUpperCase()}
                    </span>
                    <div className="media-actions">
                      <button className="icon-btn" title="Copy the URL" onClick={() => void copy(m)}>
                        {copied === m.src ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <a className="icon-btn" title="Download" href={m.src} download={m.name}>
                        <Download size={14} />
                      </a>
                      {canDelete && (
                        <button className="icon-btn danger" title="Delete" onClick={() => void remove(m)}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="media-info">
                    <strong>{m.name}</strong>
                    <span className="muted small">
                      {formatSize(m.size)} · {formatDate(m.modified)}
                    </span>
                  </div>
                </div>
              );
            })}
            {files && !shown.length && <p className="muted">No file matches.</p>}
          </div>
        )}
      </div>
      {dragging && (
        <div className="drop-overlay">
          <UploadCloud size={42} />
          <strong>Drop to upload to {projectId ? 'this project' : 'the shared assets'}</strong>
        </div>
      )}
    </div>
  );
}
