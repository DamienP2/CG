import { Check, Copy, Download, File, FileAudio, Film, Image as ImageIcon, Search, Trash2, Type, Upload, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, can, mediaName, mediaUrl, uploadAsset, useApp, useChanged, type MediaFile } from '../store';

type Kind = MediaFile['kind'];

const KINDS: { kind: Kind | 'all'; label: string; icon: typeof File }[] = [
  { kind: 'all', label: 'All', icon: File },
  { kind: 'image', label: 'Images', icon: ImageIcon },
  { kind: 'video', label: 'Videos', icon: Film },
  { kind: 'audio', label: 'Audio', icon: FileAudio },
  { kind: 'font', label: 'Fonts', icon: Type },
  { kind: 'other', label: 'Other', icon: File },
];

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
    const todo = [...list];
    if (!todo.length) return;
    const existing = new Set(files?.map((f) => f.name));
    const replaced = todo.filter((f) => existing.has(mediaName(f.name))).map((f) => mediaName(f.name));
    if (replaced.length && !confirm(`Replace ${replaced.join(', ')}? Templates using ${replaced.length > 1 ? 'them' : 'it'} show the new file.`)) return;
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
    if (!confirm(`Delete “${m.name}”? Templates that use it will show nothing in its place.`)) return;
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
            <h1>{projectId ? 'Media' : 'Shared media'}</h1>
            <p className="muted">
              {projectId ? 'Images, videos and files of this project.' : 'Images, videos and files every project can use.'} {files ? `${files.length} file${files.length === 1 ? '' : 's'} · ${formatSize(total)}` : ''}
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
            {KINDS.filter((k) => k.kind === 'all' || counts[k.kind]).map(({ kind: k, label, icon: Icon }) => (
              <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                <Icon size={13} /> {label} <span className="count">{counts[k] ?? 0}</span>
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

        {files && files.length === 0 ? (
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
          <strong>Drop to upload to {projectId ? 'this project' : 'the shared media'}</strong>
        </div>
      )}
    </div>
  );
}
