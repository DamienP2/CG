import { HYPHEN_LANGS } from '../engine/textFit';
import { Dropdown } from '../ui/Dropdown';
import { ChevronDown, History, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../engine/types';
import { api, useApp } from '../store';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { ProjectPublish } from './Collab';

/*
 * Left panel, above the templates: the project — its name, format,
 * autosave state and the Publish of its changes. The history of versions
 * (kept at each publish, or by hand) with restore is in the top bar
 * (ProjectHistory).
 */

interface Version {
  id: string;
  at: number;
  by: string;
  note: string;
  templates: number;
}

/** Picture sizes, shown by their shape. */
const SIZES = [
  { label: '720', title: 'HD 1280×720', width: 1280, height: 720 },
  { label: '1080', title: 'Full HD 1920×1080', width: 1920, height: 1080 },
  { label: '4K', title: 'UHD 3840×2160', width: 3840, height: 2160 },
  { label: '9:16', title: 'Vertical 1080×1920', width: 1080, height: 1920 },
  { label: '1:1', title: 'Square 1080×1080', width: 1080, height: 1080 },
];
const RATES: { label: string; rate: Project['frameRate'] }[] = [
  { label: '25', rate: { num: 25, den: 1 } },
  { label: '29.97', rate: { num: 30000, den: 1001 } },
  { label: '30', rate: { num: 30, den: 1 } },
  { label: '50', rate: { num: 50, den: 1 } },
  { label: '59.94', rate: { num: 60000, den: 1001 } },
  { label: '60', rate: { num: 60, den: 1 } },
];
const sameRate = (a: Project['frameRate'], b: Project['frameRate']) => a.num * b.den === b.num * a.den;

/** A picture's shape, fitted in 22×22. */
function Shape({ width, height }: { width: number; height: number }) {
  const k = 20 / Math.max(width, height);
  return <span className="pjp-shape" style={{ width: Math.round(width * k), height: Math.round(height * k) }} />;
}

/** The picture size, by its shape, and the frame rate, as buttons. */
export function FormatButtons({ width, height, rate, disabled, onSize, onRate }: { width: number; height: number; rate: Project['frameRate']; disabled?: boolean; onSize: (w: number, h: number) => void; onRate: (r: Project['frameRate']) => void }) {
  return (
    <div className="pjp-format">
      <div className="pjp-sizes">
        {SIZES.map((f) => (
          <button key={f.label} className={f.width === width && f.height === height ? 'on' : ''} title={f.title} disabled={disabled} type="button" onClick={() => onSize(f.width, f.height)}>
            <span className="pjp-shape-box">
              <Shape width={f.width} height={f.height} />
            </span>
            {f.label}
          </button>
        ))}
      </div>
      {!SIZES.some((f) => f.width === width && f.height === height) && (
        <span className="muted small">
          {width}×{height}
        </span>
      )}
      <div className="pjp-rates" title="Frames per second">
        {RATES.map((r) => (
          <button key={r.label} className={sameRate(r.rate, rate) ? 'on' : ''} disabled={disabled} type="button" onClick={() => onRate(r.rate)}>
            {r.label}
          </button>
        ))}
        <span className="pjp-fps">fps</span>
      </div>
      {!RATES.some((r) => sameRate(r.rate, rate)) && <span className="muted small">{+(rate.num / rate.den).toFixed(2)} fps</span>}
    </div>
  );
}

/** "3 min ago", "yesterday 18:02"… */
const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return when(ms);
};

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
};

export function ProjectPanel({ project, saveState, readOnly }: { project: Project; saveState: 'saved' | 'pending'; readOnly: boolean }) {
  const toast = useApp((s) => s.toast);
  const [savedAt, setSavedAt] = useState(Date.now());
  const [formatOpen, setFormatOpen] = useState(false);
  const url = `/api/projects/${encodeURIComponent(project.id)}`;
  const fps = +(project.frameRate.num / project.frameRate.den).toFixed(2);

  useEffect(() => {
    if (saveState === 'saved') setSavedAt(Date.now());
  }, [saveState]);

  const meta = (patch: Partial<{ name: string; width: number; height: number; frameRate: Project['frameRate']; language: string }>) =>
    api('PUT', url, { name: project.name, description: project.description ?? '', width: project.width, height: project.height, frameRate: project.frameRate, ...patch }).catch((e) => toast((e as Error).message, 'error'));

  const rename = async () => {
    const name = await promptDialog({ title: 'Rename the project', label: 'Name', value: project.name, confirm: 'Rename' });
    if (name?.trim()) await meta({ name: name.trim() });
  };
  const setSize = async (w: number, h: number) => {
    if (w === project.width && h === project.height) return;
    if (
      !(await confirmDialog({
        title: `Change the main format to ${w}×${h}?`,
        message: 'The templates keep their positions in pixels: check them afterwards. A version of the project is kept first.',
        confirm: 'Change',
      }))
    )
      return;
    await api('POST', `${url}/versions`, { note: `Before the change to ${w}×${h}` }).catch(() => {});
    await meta({ width: w, height: h });
  };
  const setRate = (rate: Project['frameRate']) => !sameRate(rate, project.frameRate) && meta({ frameRate: rate });

  return (
    <section className="project-panel">
      <header>
        <span>Project</span>
        <span className={`pp-save ${readOnly ? 'ro' : saveState}`} title="Changes are saved automatically">
          {readOnly ? 'Read only' : saveState === 'saved' ? `Saved · ${when(savedAt)}` : 'Saving…'}
        </span>
      </header>
      <div className="pjp-body">
        <div className="pjp-title">
          <button className="pjp-name" onClick={rename} disabled={readOnly} title="Rename">
            <span>{project.name}</span>
            <Pencil size={12} />
          </button>
          <button className={`pjp-format-sum ${formatOpen ? 'open' : ''}`} onClick={() => setFormatOpen(!formatOpen)} title="Format of the project">
            <span className="pjp-shape-box">
              <Shape width={project.width} height={project.height} />
            </span>
            {project.height > project.width ? `${project.width}×${project.height}` : `${project.height}p`} · {fps}
            <ChevronDown size={11} />
          </button>
        </div>
        {formatOpen && (
          <>
            <FormatButtons width={project.width} height={project.height} rate={project.frameRate} disabled={readOnly} onSize={(w, h) => void setSize(w, h)} onRate={(r) => void setRate(r)} />
            <label className="pjp-lang" title="Hyphenation rules and French spaces of every text of the project">
              <span>Language of the texts</span>
              <Dropdown value={project.language ?? 'fr'} options={HYPHEN_LANGS.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => !readOnly && void meta({ language: v })} />
            </label>
          </>
        )}
        <div className="pjp-publish">
          <ProjectPublish project={project} readOnly={readOnly} />
        </div>
      </div>
    </section>
  );
}

/** History of the project's versions, in the top bar: a button and its list. */
export function ProjectHistory({ project, readOnly }: { project: Project; readOnly: boolean }) {
  const toast = useApp((s) => s.toast);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const url = `/api/projects/${encodeURIComponent(project.id)}`;
  const loadVersions = () =>
    api<Version[]>('GET', `${url}/versions`)
      .then(setVersions)
      .catch(() => setVersions([]));
  // A publish (from here or elsewhere) adds a version.
  const revisions = project.templates.map((t) => t.revision ?? 0).join(',');
  useEffect(() => {
    void loadVersions();
  }, [revisions, project.id]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const keep = async () => {
    const note = await promptDialog({ title: 'Keep a version', label: 'Note', value: '', placeholder: 'What changed', confirm: 'Keep' });
    if (note === null) return;
    await api('POST', `${url}/versions`, { note }).catch((e) => toast((e as Error).message, 'error'));
    void loadVersions();
  };
  const restore = async (v: Version) => {
    if (!(await confirmDialog({ title: `Restore the version of ${when(v.at)}?`, message: `“${v.note}”. The project as it is now is kept as a version first, so you can come back to it.`, confirm: 'Restore', danger: true }))) return;
    await api('POST', `${url}/versions/${encodeURIComponent(v.id)}/restore`).catch((e) => toast((e as Error).message, 'error'));
    toast('Version restored', 'info');
    void loadVersions();
  };

  return (
    <div className="history-menu" ref={ref}>
      <button className={`top-tool ${open ? 'on' : ''}`} title="History of the versions" onClick={() => setOpen(!open)}>
        <History size={15} />
        {versions && versions.length > 0 && <span className="pjp-count">{versions.length}</span>}
      </button>
      {open && (
        <div className="history-pop">
          <header>
            <strong>History</strong>
            {!readOnly && (
              <button className="pjp-keep" title="Keep a version of the project now, with a note" onClick={keep}>
                <Plus size={12} /> Keep a version
              </button>
            )}
          </header>
          <ol className="pjp-timeline">
            <li className="now">
              <span className="pjp-dot" />
              <span className="pjp-v-main">
                <strong>Now</strong>
                <span className="pjp-v-sub">Saved automatically</span>
              </span>
            </li>
            {versions === null && <li className="pjp-v-empty">Loading…</li>}
            {versions?.length === 0 && <li className="pjp-v-empty">Each publish keeps a version here; Keep makes one now.</li>}
            {versions?.map((v) => (
              <li key={v.id} className={/^Publish/i.test(v.note) ? 'publish' : ''}>
                <span className="pjp-dot" />
                <span className="pjp-v-main">
                  <strong title={v.note}>{v.note || 'Version'}</strong>
                  <span className="pjp-v-sub" title={new Date(v.at).toLocaleString()}>
                    <span className="pjp-avatar">{(v.by || '?').slice(0, 1).toUpperCase()}</span>
                    {v.by} · {ago(v.at)}
                  </span>
                </span>
                {!readOnly && (
                  <button className="pjp-restore" title="Restore this version (the current state is kept first)" onClick={() => restore(v)}>
                    <RotateCcw size={12} /> Restore
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
