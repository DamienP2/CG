import { Check, ChevronRight, Copy, Download, File, FileAudio, Film, Folder, FolderOpen, FolderPlus, HardDrive, Image as ImageIcon, LayoutGrid, LayoutTemplate, Link2, Palette as PaletteIcon, Pause, Pencil, Play, Plus, Search, Trash2, Type, Upload, UploadCloud, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, can, mediaName, mediaUrl, uploadAsset, useApp, useChanged, type MediaFile } from '../store';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { ContextMenu } from '../ui/ContextMenu';
import { Empty } from '../ui/Empty';
import { Segmented } from '../ui/fields';
import { Dropdown } from '../ui/Dropdown';
import { loadFonts, useFonts } from '../engine/fonts';
import { locale, t, tn } from '../i18n';
import { NavItem, NavSection, PageHead, SidePage } from './SidePage';
import { addPalette, ColorsPanel } from './ColorsPanel';
import { useColors } from '../colors';
import { LogicFlowsPanel } from './LogicFlowsPanel';
import { LibraryGrid, useTemplateLibrary, type LibTemplate } from '../designer/templateLibrary';
import { useLogicFlows } from '../logicFlows';

type Kind = MediaFile['kind'];

const KINDS: { kind: Kind | 'all'; label: string; icon: typeof File }[] = [
  { kind: 'all', label: 'All files', icon: LayoutGrid },
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
      toast(t('Font {name} added', { name: file.name }), 'info');
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
  const groups: [string, typeof families][] = [
    [t('Uploaded'), families.filter((f) => f.source === 'uploaded')],
    [t('Built in'), families.filter((f) => f.source === 'bundled')],
    [t('Server'), families.filter((f) => f.source === 'system')],
  ];
  const remove = async (file: string, family: string) => {
    if (!(await confirmDialog({ title: t('Remove {family} ({file})?', { family, file }), message: t('Texts using it fall back to Inter.'), confirm: t('Remove'), danger: true }))) return;
    try {
      await api('DELETE', `/api/fonts/${encodeURIComponent(file)}`);
      await loadFonts();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="fonts-panel">
      {groups
        .filter(([, l]) => l.length)
        .map(([title, list]) => (
          <section key={title} className="fonts-group">
            <h3>{title}</h3>
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
                      <button key={file} className="icon-btn danger" title={t('Remove {file}', { file })} onClick={() => void remove(file, f.family)}>
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

/** "70 o", "49 Ko", "6,7 Mo" in French. */
export function formatSize(n: number) {
  const f = (v: number, digits: number) => v.toLocaleString(locale(), { maximumFractionDigits: digits });
  if (n < 1024) return t('{n} B', { n: f(n, 0) });
  if (n < 1024 ** 2) return t('{n} KB', { n: f(n / 1024, 0) });
  if (n < 1024 ** 3) return t('{n} MB', { n: f(n / 1024 ** 2, 1) });
  return t('{n} GB', { n: f(n / 1024 ** 3, 2) });
}

const formatDate = (ms: number) => new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });

type Upload = { name: string; progress: number; error?: string };

/** The folders of a library: by kind of file, one level; a file keeps its address in any of them. */
interface LibraryFolders {
  folders: { kind: string; name: string }[];
  /** File name → folder name (of the file's kind). */
  assign: Record<string, string>;
}

const NO_FOLDERS: LibraryFolders = { folders: [], assign: {} };

/** A file dragged onto a folder (not a file from the computer). */
const DRAG_MIME = 'application/x-strata-media';

/** What an empty kind says. */
const nothing = (k: Kind | 'all') => (k === 'image' ? t('No image') : k === 'video' ? t('No video') : k === 'audio' ? t('No sound') : k === 'other' ? t('No file') : t('No media yet'));

/**
 * A media library: the files of one project (`projectId`), or the files
 * shared by every project. Upload by button or by dropping files anywhere;
 * each kind of file sorted into folders.
 */
export function MediaLibrary({ projectId }: { projectId?: string }) {
  const { auth, toast } = useApp();
  const user = auth?.user;
  const canUpload = !!user && user.role !== 'viewer';
  const canDelete = can.design(user);
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const [lib, setLib] = useState<LibraryFolders>(NO_FOLDERS);
  const families = useFonts((s) => s.families);
  useEffect(() => {
    if (!families.length) void loadFonts();
  }, [families.length]);
  const [kind, setKindRaw] = useState<Kind | 'all' | 'colors' | 'logic' | 'templates'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const setKind = (k: typeof kind) => (setKindRaw(k), setOpen(null));
  const tlib = useTemplateLibrary(projectId);
  const sharedFlows = useLogicFlows((s) => s.shared.length);
  const flowsLoaded = useLogicFlows((s) => s.loaded);
  useEffect(() => {
    if (!flowsLoaded) void useLogicFlows.getState().load();
  }, [flowsLoaded]);
  const projectFlows = useApp((s) => (projectId ? (s.full[projectId]?.logicFlows?.length ?? 0) : 0));
  const palettes = useColors((s) => s.palettes);
  const loadColors = useColors((s) => s.load);
  const colorsLoaded = useColors((s) => s.loaded);
  useEffect(() => {
    if (!colorsLoaded) void loadColors();
  }, [colorsLoaded, loadColors]);
  const projectColors = useApp((s) => (projectId ? (s.full[projectId]?.colors?.length ?? 0) : 0));
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'date' | 'size'>('name');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; folder: string } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const depth = useRef(0);
  const url = mediaUrl(projectId);
  const foldersUrl = `${url}-folders`;

  const refresh = () =>
    Promise.all([api<MediaFile[]>('GET', url), api<LibraryFolders>('GET', foldersUrl)])
      .then(([list, f]) => {
        setFiles(list);
        setLib({ ...NO_FOLDERS, ...f });
        return list;
      })
      .catch((e) => (toast((e as Error).message, 'error'), null));
  // Uploads, deletions and folders changed by other users.
  useChanged(projectId ? `media:${projectId}` : 'media', () => void refresh());
  useEffect(() => {
    setFiles(null);
    setLib(NO_FOLDERS);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const saveLib = async (next: LibraryFolders) => {
    setLib(next);
    try {
      setLib({ ...NO_FOLDERS, ...(await api<LibraryFolders>('PUT', foldersUrl, next)) });
    } catch (e) {
      toast((e as Error).message, 'error');
      void refresh();
    }
  };

  const mediaKind = kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'other' ? kind : null;
  const foldersOf = (k: string) => lib.folders.filter((f) => f.kind === k).map((f) => f.name);
  const folderOf = (m: MediaFile) => {
    const f = lib.assign[m.name];
    return f && lib.folders.some((x) => x.kind === m.kind && x.name === f) ? f : null;
  };
  // A folder removed elsewhere.
  useEffect(() => {
    if (open && mediaKind && !foldersOf(mediaKind).includes(open)) setOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, open, mediaKind]);

  const moveTo = (names: string[], folder: string | null) => {
    const assign = { ...lib.assign };
    for (const n of names) {
      if (folder) assign[n] = folder;
      else delete assign[n];
    }
    void saveLib({ ...lib, assign });
  };

  const upload = async (list: FileList | File[]) => {
    // Fonts are global: they go to the server's fonts, never to a project.
    const fonts = [...list].filter((f) => FONT_FILE.test(f.name));
    if (fonts.length) await uploadFonts(fonts, toast);
    const todo = [...list].filter((f) => !FONT_FILE.test(f.name));
    if (!todo.length) return;
    const existing = new Set(files?.map((f) => f.name));
    const replaced = todo.filter((f) => existing.has(mediaName(f.name))).map((f) => mediaName(f.name));
    if (replaced.length && !(await confirmDialog({ title: t('Replace {names}?', { names: replaced.join(', ') }), message: tn(replaced.length, 'Templates using it show the new file.', 'Templates using them show the new files.'), confirm: t('Replace') }))) return;
    const into = mediaKind && open ? { kind: mediaKind, folder: open } : null;
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
    const now = await refresh();
    // Dropped in an open folder: the new files of its kind go in it.
    if (into && now) {
      const names = new Set(todo.map((f) => mediaName(f.name)));
      const mine = now.filter((m) => names.has(m.name) && m.kind === into.kind).map((m) => m.name);
      if (mine.length) {
        const f = await api<LibraryFolders>('GET', foldersUrl).catch(() => null);
        if (f) void saveLib({ ...NO_FOLDERS, ...f, assign: { ...f.assign, ...Object.fromEntries(mine.map((n) => [n, into.folder])) } });
      }
    }
  };

  const remove = async (m: MediaFile) => {
    if (!(await confirmDialog({ title: t('Delete “{name}”?', { name: m.name }), message: t('Templates that use it will show nothing in its place.'), confirm: t('Delete'), danger: true }))) return;
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

  const newFolder = async () => {
    if (!mediaKind) return;
    const name = (await promptDialog({ title: t('New folder'), label: t('Name'), confirm: t('Create') }))?.trim();
    if (!name) return;
    if (!foldersOf(mediaKind).includes(name)) await saveLib({ ...lib, folders: [...lib.folders, { kind: mediaKind, name }] });
    setOpen(name);
  };
  const renameFolder = async (old: string) => {
    if (!mediaKind) return;
    const name = (await promptDialog({ title: t('Rename the folder'), label: t('Name'), value: old, confirm: t('Rename') }))?.trim();
    if (!name || name === old) return;
    if (foldersOf(mediaKind).includes(name)) return toast(t('A folder “{name}” already exists', { name }), 'error');
    const assign = Object.fromEntries(Object.entries(lib.assign).map(([f, d]) => [f, d === old && (files ?? []).some((m) => m.name === f && m.kind === mediaKind) ? name : d]));
    void saveLib({ folders: lib.folders.map((f) => (f.kind === mediaKind && f.name === old ? { kind: f.kind, name } : f)), assign });
    if (open === old) setOpen(name);
  };
  const deleteFolder = async (name: string) => {
    if (!mediaKind) return;
    const n = (files ?? []).filter((m) => m.kind === mediaKind && folderOf(m) === name).length;
    if (
      !(await confirmDialog({
        title: t('Delete the folder “{name}”?', { name }),
        message: n ? tn(n, 'Its file goes back to the top (it is not deleted).', 'Its {n} files go back to the top (they are not deleted).') : undefined,
        confirm: t('Delete'),
        danger: true,
      }))
    )
      return;
    const assign = Object.fromEntries(Object.entries(lib.assign).filter(([f, d]) => !(d === name && (files ?? []).some((m) => m.name === f && m.kind === mediaKind))));
    void saveLib({ folders: lib.folders.filter((f) => !(f.kind === mediaKind && f.name === name)), assign });
    if (open === name) setOpen(null);
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: files?.length ?? 0 };
    for (const f of files ?? []) c[f.kind] = (c[f.kind] ?? 0) + 1;
    return c;
  }, [files]);
  const total = useMemo(() => (files ?? []).reduce((n, f) => n + f.size, 0), [files]);
  const q = query.trim().toLowerCase();
  const ofKind = (files ?? []).filter((f) => kind === 'all' || f.kind === kind);
  // Searching looks in every folder; otherwise a kind shows what is in the open folder (or at its top).
  const shown = ofKind
    .filter((f) => (q ? f.name.toLowerCase().includes(q) : !mediaKind || folderOf(f) === open))
    .sort((a, b) => (sort === 'date' ? b.modified - a.modified : sort === 'size' ? b.size - a.size : 0) || a.name.localeCompare(b.name));
  const folderList = mediaKind && !open && !q ? foldersOf(mediaKind).sort((a, b) => a.localeCompare(b, locale())) : [];
  const fonts = kind === 'font';
  const colourCount = palettes.reduce((n, p) => n + p.colors.length, projectColors);
  const colors = kind === 'colors';
  const logic = kind === 'logic';
  const tpls = kind === 'templates';
  const label = KINDS.find((k) => k.kind === kind)?.label ?? 'All files';
  const KindIcon = KINDS.find((k) => k.kind === kind)?.icon ?? LayoutGrid;

  const dropZone = canUpload && (
    <label className="lib-dropzone">
      <UploadCloud size={22} />
      {t('Drop files here or click to choose them')}
      <input type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
    </label>
  );
  /** Drop target of a file dragged from the grid (a folder, or the top of the kind). */
  const target = (folder: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      setDropOn(folder ?? '');
    },
    onDragLeave: () => setDropOn((d) => (d === (folder ?? '') ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const name = e.dataTransfer.getData(DRAG_MIME);
      if (!name) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOn(null);
      moveTo([name], folder);
    },
  });

  const nav = (
    <>
      <NavSection>{projectId ? t('Media of the project') : t('Media')}</NavSection>
      {KINDS.filter((k) => k.kind !== 'font').map(({ kind: k, label: l, icon: Icon }) => (
        <NavItem key={k} on={kind === k} icon={<Icon size={15} />} label={t(l)} count={counts[k] ?? 0} className={k !== 'all' && !counts[k] ? 'dim' : ''} onClick={() => setKind(k)} />
      ))}
      <NavSection>{t('Typography')}</NavSection>
      <NavItem on={kind === 'font'} icon={<Type size={15} />} label={t('Fonts')} count={families.length} onClick={() => setKind('font')} />
      <NavSection>{t('Colours')}</NavSection>
      <NavItem on={colors} icon={<PaletteIcon size={15} />} label={t('Colours')} count={colourCount} onClick={() => setKind('colors')} />
      <NavSection>{t('Templates')}</NavSection>
      <NavItem on={tpls} icon={<LayoutTemplate size={15} />} label={t('All templates')} count={tlib?.length ?? 0} onClick={() => setKind('templates')} />
      <NavSection>{t('Logic')}</NavSection>
      <NavItem on={logic} icon={<Link2 size={15} />} label={t('Flows of logic')} count={sharedFlows + projectFlows} onClick={() => setKind('logic')} />
      <div className="lib-nav-foot">
        <HardDrive size={13} /> {files ? `${tn(files.length, '{n} file', '{n} files')} · ${formatSize(total)}` : '…'}
      </div>
    </>
  );

  const mediaView = !fonts && !colors && !logic && !tpls;
  const emptyHere = files !== null && !q && !shown.length && !folderList.length;

  return (
    <SidePage
      nav={nav}
      className={`media-page ${dragging ? 'dragging' : ''}`}
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
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (canUpload) void upload(e.dataTransfer.files);
      }}
      after={
        <>
          {dragging && (
            <div className="drop-overlay">
              <UploadCloud size={42} />
              <strong>{projectId ? t('Drop to upload to this project') : t('Drop to upload to the shared assets')}</strong>
            </div>
          )}
          {menu && (
            <ContextMenu
              at={menu}
              onClose={() => setMenu(null)}
              items={[
                { icon: <Pencil size={13} />, label: t('Rename'), run: () => renameFolder(menu.folder) },
                { icon: <Trash2 size={13} />, label: t('Delete'), danger: true, run: () => deleteFolder(menu.folder) },
              ]}
            />
          )}
        </>
      }
    >
      <PageHead
        title={tpls ? t('Templates') : logic ? t('Flows of logic') : colors ? t('Colours') : fonts ? t('Fonts') : kind === 'all' ? (projectId ? t('Media of the project') : t('Shared media')) : t(label)}
        sub={tpls ? tn(tlib?.length ?? 0, '{n} template', '{n} templates') : logic ? tn(sharedFlows + projectFlows, '{n} flow', '{n} flows') : colors ? tn(colourCount, '{n} colour', '{n} colours') : fonts ? tn(families.length, '{n} font', '{n} fonts') : tn(ofKind.length, '{n} file', '{n} files')}
      >
        {colors && canDelete && (
          <button className="btn primary" onClick={addPalette}>
            <Plus size={14} /> {t('Palette')}
          </button>
        )}
        {mediaKind && canUpload && !open && (
          <button className="btn" onClick={() => void newFolder()}>
            <FolderPlus size={14} /> {t('Folder')}
          </button>
        )}
        {!colors && !logic && !tpls && canUpload && (!fonts || canDelete) && (
          <label className="btn primary">
            <Upload size={14} /> {fonts ? t('Add fonts') : t('Upload')}
            <input type="file" multiple hidden accept={fonts ? '.ttf,.otf,.woff,.woff2,.ttc' : undefined} onChange={(e) => e.target.files && void upload(e.target.files)} />
          </label>
        )}
      </PageHead>

      {mediaView && !(files && !files.length) && (
        <div className="media-toolbar">
          {mediaKind && (
            <div className="lib-crumb">
              {open ? (
                <>
                  <button className={`lib-crumb-root ${dropOn === '' ? 'drop' : ''}`} onClick={() => setOpen(null)} {...target(null)}>
                    {t(label)}
                  </button>
                  <ChevronRight size={14} />
                  <b>{open}</b>
                </>
              ) : (
                <b>{t(label)}</b>
              )}
            </div>
          )}
          <div className="spacer" />
          <label className="search">
            <Search size={14} />
            <input value={query} placeholder={t('Search files')} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label className="sort">
            {t('Sort')}
            <Dropdown
              value={sort}
              options={[
                { value: 'name', label: t('Name') },
                { value: 'date', label: t('Newest') },
                { value: 'size', label: t('Size') },
              ]}
              onChange={setSort}
            />
          </label>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="uploads">
          {uploads.map((u) => (
            <div key={u.name} className={`upload-row ${u.error ? 'error' : ''}`}>
              <span className="grow">{u.name}</span>
              {u.error ? (
                <>
                  <span className="small">{u.error}</span>
                  <button className="btn small" onClick={() => setUploads((l) => l.filter((x) => x.name !== u.name))}>
                    {t('Dismiss')}
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

      {tpls ? (
        <TemplatesPanel list={tlib} projectId={projectId} />
      ) : logic ? (
        <LogicFlowsPanel projectId={projectId} canEdit={canDelete} />
      ) : colors ? (
        <ColorsPanel projectId={projectId} canEdit={canDelete} />
      ) : fonts ? (
        <FontsPanel canEdit={canDelete} />
      ) : emptyHere ? (
        <div className="lib-void">
          <Empty icon={open ? FolderOpen : KindIcon} text={open ? t('Empty folder') : nothing(mediaKind ?? 'all')}>
            {dropZone}
          </Empty>
        </div>
      ) : (
        <>
          {folderList.length > 0 && (
            <div className="lib-folders">
              {folderList.map((f) => (
                <button
                  key={f}
                  className={`lib-folder ${dropOn === f ? 'drop' : ''}`}
                  onDoubleClick={() => setOpen(f)}
                  onContextMenu={(e) => canUpload && (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, folder: f }))}
                  {...target(f)}
                >
                  <Folder size={18} />
                  <span className="grow">{f}</span>
                  <span className="muted small">{ofKind.filter((m) => folderOf(m) === f).length}</span>
                </button>
              ))}
            </div>
          )}
          {files && !shown.length && q ? (
            <div className="lib-void">
              <Empty icon={Search} text={t('No file matches.')} />
            </div>
          ) : (
            <div className="media-grid">
              {shown.map((m) => {
                const Icon = ICON[m.kind];
                return (
                  <div
                    key={m.src}
                    className="media-tile"
                    title={m.src}
                    draggable={canUpload && !!mediaKind}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_MIME, m.name);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDropOn(null)}
                  >
                    <div className="media-preview">
                      {m.kind === 'image' ? (
                        <img src={`${m.src}?v=${m.modified}`} alt="" loading="lazy" draggable={false} />
                      ) : m.kind === 'video' || m.kind === 'audio' ? (
                        <MediaPlayer m={m} playing={playing === m.src} onPlaying={(on) => setPlaying((p) => (on ? m.src : p === m.src ? null : p))} />
                      ) : (
                        <Icon size={30} />
                      )}
                      <span className={`media-kind ${m.kind}`}>
                        <Icon size={11} /> {m.name.split('.').pop()?.toUpperCase()}
                      </span>
                      <div className="media-actions">
                        <button className="icon-btn" title={t('Copy the URL')} onClick={() => void copy(m)}>
                          {copied === m.src ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                        <a className="icon-btn" title={t('Download')} href={m.src} download={m.name}>
                          <Download size={14} />
                        </a>
                        {canDelete && (
                          <button className="icon-btn danger" title={t('Delete')} onClick={() => void remove(m)}>
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
            </div>
          )}
        </>
      )}
    </SidePage>
  );
}

/** "0:04", "12:30". */
const clock = (s: number) => {
  const v = Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

/** Sounds read once to draw their wave (the bigger ones show an icon). */
const WAVE_MAX_BYTES = 30 * 1024 * 1024;
const waves = new Map<string, Promise<number[] | null>>();
let waveQueue: Promise<unknown> = Promise.resolve();
let decoder: AudioContext | null = null;

/** The loudness of a sound in `bars` slices (0–1), one sound decoded at a time. */
function waveOf(src: string, bars: number): Promise<number[] | null> {
  let p = waves.get(src);
  if (!p) {
    p = waveQueue.then(async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        decoder ??= new AudioContext();
        const audio = await decoder.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / bars));
        const out: number[] = [];
        for (let i = 0; i < bars; i++) {
          let peak = 0;
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) peak = Math.max(peak, Math.abs(data[j]));
          out.push(peak);
        }
        const top = Math.max(...out, 0.0001);
        return out.map((v) => v / top);
      } catch {
        return null;
      }
    });
    waveQueue = p;
    waves.set(src, p);
  }
  return p;
}

const BARS = 48;

/** A sound or a video in its tile: ▶ plays it there (one at a time in the page), with pause, position and time. */
function MediaPlayer({ m, playing, onPlaying }: { m: MediaFile; playing: boolean; onPlaying: (on: boolean) => void }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(true);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [wave, setWave] = useState<number[] | null>(null);
  const video = m.kind === 'video';
  const src = `${m.src}?v=${m.modified}`;

  useEffect(() => {
    if (video || m.size > WAVE_MAX_BYTES) return;
    let live = true;
    void waveOf(src, BARS).then((w) => live && setWave(w));
    return () => void (live = false);
  }, [src, video, m.size]);
  // Another file started: this one stops.
  useEffect(() => {
    if (!playing) ref.current?.pause();
  }, [playing]);
  // The position, smooth while it plays.
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    const tick = () => {
      if (ref.current) setAt(ref.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused]);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      setStarted(true);
      void el.play().catch(() => {});
    } else el.pause();
  };
  const seek = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    el.currentTime = Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration));
    setAt(el.currentTime);
  };
  const events = {
    onPlay: () => (setPaused(false), onPlaying(true)),
    onPause: () => (setPaused(true), onPlaying(false)),
    onEnded: () => (setPaused(true), setAt(0), onPlaying(false)),
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => setDuration(e.currentTarget.duration),
  };
  const part = duration ? at / duration : 0;
  const Icon = ICON[m.kind];

  return (
    <>
      {video ? (
        <video ref={ref} src={`${src}#t=0.5`} preload="metadata" muted={muted} playsInline {...events} />
      ) : (
        <>
          <audio ref={ref} src={src} preload="metadata" {...events} />
          {wave ? (
            <div className="mp-wave">
              {wave.map((v, i) => (
                <b key={i} className={i / BARS < part ? 'on' : ''} style={{ height: `${Math.max(6, v * 100)}%` }} />
              ))}
            </div>
          ) : (
            <Icon size={30} />
          )}
        </>
      )}
      {started && !(paused && at === 0) ? (
        <div className="mp-bar" onClick={(e) => e.stopPropagation()}>
          <button className="mp-btn" title={paused ? t('Play') : t('Pause')} onClick={toggle}>
            {paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
          </button>
          <div className="mp-track" onPointerDown={seek}>
            <i style={{ width: `${part * 100}%` }} />
          </div>
          <span className="mp-time">
            {clock(at)} / {clock(duration)}
          </span>
          {video && (
            <button className="mp-btn" title={muted ? t('Sound on') : t('Mute')} onClick={() => setMuted((x) => !x)}>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
          )}
        </div>
      ) : (
        <button className="mp-play" title={t('Play')} onClick={toggle}>
          <Play size={18} fill="currentColor" />
        </button>
      )}
    </>
  );
}

/** Library › Templates: the shared ones, and those kept with the project (in a project's library). */
function TemplatesPanel({ list, projectId }: { list: LibTemplate[] | null; projectId?: string | null }) {
  const user = useApp((s) => s.auth?.user);
  const [tab, setTab] = useState<'shared' | 'project'>('shared');
  if (!list) return <div className="loading">{t('Loading…')}</div>;
  const shared = list.filter((e) => !e.project);
  const own = list.filter((e) => !!e.project);
  const shown = projectId && tab === 'project' ? own : shared;
  const canRemove = (e: LibTemplate) => !!user && (user.role === 'admin' || e.author === user.id || (!!e.project && can.design(user)));
  return (
    <>
      {projectId && (
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'shared', label: `${t('Shared')} · ${shared.length}` },
            { value: 'project', label: `${t('Of the project')} · ${own.length}` },
          ]}
        />
      )}
      {shown.length ? (
        <LibraryGrid list={shown} canRemove={canRemove} />
      ) : (
        <div className="lib-void">
          <Empty icon={LayoutTemplate} text={t('No template')} />
        </div>
      )}
    </>
  );
}
