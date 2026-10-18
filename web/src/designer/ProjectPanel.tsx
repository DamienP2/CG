import { ChevronDown, Clock3, History, Pencil, RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Project } from '../engine/types';
import { FORMATS } from '../pages/Projects';
import { api, useApp } from '../store';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { PublishButton } from './Collab';

/*
 * Left panel, above the templates: the project — its name, format,
 * autosave state, the Publish of the open template and the history of
 * versions (kept at each publish, or by hand) with restore.
 */

interface Version {
  id: string;
  at: number;
  by: string;
  note: string;
  templates: number;
}

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function ProjectPanel({ project, saveState, readOnly }: { project: Project; saveState: 'saved' | 'pending'; readOnly: boolean }) {
  const toast = useApp((s) => s.toast);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedAt, setSavedAt] = useState(Date.now());
  const url = `/api/projects/${encodeURIComponent(project.id)}`;
  const fps = +(project.frameRate.num / project.frameRate.den).toFixed(2);

  useEffect(() => {
    if (saveState === 'saved') setSavedAt(Date.now());
  }, [saveState]);
  const loadVersions = () =>
    api<Version[]>('GET', `${url}/versions`)
      .then(setVersions)
      .catch(() => setVersions([]));
  // A publish (from here or elsewhere) adds a version.
  const revisions = project.templates.map((t) => t.revision ?? 0).join(',');
  useEffect(() => {
    if (historyOpen) void loadVersions();
  }, [historyOpen, revisions, project.id]);

  const meta = (patch: Partial<{ name: string; width: number; height: number; frameRate: Project['frameRate'] }>) =>
    api('PUT', url, { name: project.name, description: project.description ?? '', width: project.width, height: project.height, frameRate: project.frameRate, ...patch }).catch((e) => toast((e as Error).message, 'error'));

  const rename = async () => {
    const name = await promptDialog({ title: 'Rename the project', label: 'Name', value: project.name, confirm: 'Rename' });
    if (name?.trim()) await meta({ name: name.trim() });
  };
  const setFormat = async (label: string) => {
    const f = FORMATS.find((x) => x.label === label);
    if (!f) return;
    const sizeChanges = f.width !== project.width || f.height !== project.height;
    if (
      sizeChanges &&
      !(await confirmDialog({
        title: `Change the main format to ${f.width}×${f.height}?`,
        message: 'The templates keep their positions in pixels: check them afterwards. A version of the project is kept first.',
        confirm: 'Change',
      }))
    )
      return;
    if (sizeChanges) await api('POST', `${url}/versions`, { note: `Before the format change to ${f.label}` }).catch(() => {});
    await meta({ width: f.width, height: f.height, frameRate: f.rate });
  };
  const keep = async () => {
    const note = await promptDialog({ title: 'Keep a version', label: 'Note', value: '', placeholder: 'What changed', confirm: 'Keep' });
    if (note === null) return;
    await api('POST', `${url}/versions`, { note }).catch((e) => toast((e as Error).message, 'error'));
    setHistoryOpen(true);
    void loadVersions();
  };
  const restore = async (v: Version) => {
    if (!(await confirmDialog({ title: `Restore the version of ${when(v.at)}?`, message: `“${v.note}”. The project as it is now is kept as a version first, so you can come back to it.`, confirm: 'Restore', danger: true }))) return;
    await api('POST', `${url}/versions/${encodeURIComponent(v.id)}/restore`).catch((e) => toast((e as Error).message, 'error'));
    toast('Version restored', 'info');
    void loadVersions();
  };

  const current = FORMATS.find((f) => f.width === project.width && f.height === project.height && f.rate.num * project.frameRate.den === project.frameRate.num * f.rate.den);
  return (
    <section className="project-panel">
      <header>
        <span>Project</span>
        <span className={`pp-save ${readOnly ? 'ro' : saveState}`} title="Changes are saved automatically">
          {readOnly ? 'Read only' : saveState === 'saved' ? `Saved · ${when(savedAt)}` : 'Saving…'}
        </span>
      </header>
      <div className="pjp-body">
        <button className="pjp-name" onClick={rename} disabled={readOnly} title="Rename">
          <span>{project.name}</span>
          <Pencil size={12} />
        </button>
        <div className="pjp-row">
          <span className="pjp-label">Format</span>
          <select value={current?.label ?? ''} disabled={readOnly} onChange={(e) => void setFormat(e.target.value)}>
            {!current && (
              <option value="">
                {project.width}×{project.height} · {fps} fps
              </option>
            )}
            {FORMATS.map((f) => (
              <option key={f.label} value={f.label}>
                {f.label} · {f.width}×{f.height}
              </option>
            ))}
          </select>
        </div>
        <div className="pjp-publish">
          <PublishButton project={project} readOnly={readOnly} />
        </div>
        <div className="pjp-history">
          <button className="pjp-hist-toggle" onClick={() => setHistoryOpen(!historyOpen)}>
            <History size={13} /> Versions
            <ChevronDown size={12} className={historyOpen ? 'open' : ''} />
          </button>
          {!readOnly && (
            <button className="icon-btn ghost" title="Keep a version now" onClick={keep}>
              <Save size={13} />
            </button>
          )}
        </div>
        {historyOpen && (
          <div className="pjp-versions">
            {versions === null && <span className="muted small">Loading…</span>}
            {versions?.length === 0 && <span className="muted small">No version yet: each publish keeps one.</span>}
            {versions?.map((v) => (
              <div key={v.id} className="pjp-version">
                <Clock3 size={12} />
                <span className="pjp-v-main">
                  <strong>{v.note}</strong>
                  <span className="muted small">
                    {when(v.at)} · {v.by}
                  </span>
                </span>
                {!readOnly && (
                  <button className="icon-btn ghost" title="Restore this version" onClick={() => restore(v)}>
                    <RotateCcw size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
