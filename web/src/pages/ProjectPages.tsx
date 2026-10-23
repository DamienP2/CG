import { Download, Save, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FrameRate } from '../engine/types';
import { navigate } from '../router';
import { api, useApp } from '../store';
import { FormatButtons } from '../designer/ProjectPanel';
import { confirmDialog } from '../ui/dialogs';
import { t } from '../i18n';

type ProjectMeta = {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  frameRate: FrameRate;
};


/** Name, description and design format of a project. */
export function ProjectSettings({ project }: { project: ProjectMeta }) {
  const { toast, channels } = useApp();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [format, setFormat] = useState({ width: project.width, height: project.height, rate: project.frameRate });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setFormat({ width: project.width, height: project.height, rate: project.frameRate });
  }, [project.id, project.name, project.description, project.width, project.height, project.frameRate.num, project.frameRate.den]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = name.trim() !== project.name || description !== project.description || format.width !== project.width || format.height !== project.height || format.rate.num * project.frameRate.den !== project.frameRate.num * format.rate.den;
  const url = `/api/projects/${encodeURIComponent(project.id)}`;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('PUT', url, {
        name: name.trim(),
        description,
        width: format.width,
        height: format.height,
        frameRate: format.rate,
      });
      toast(t('Project saved'));
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const used = channels.filter((c) => c.projectId === project.id).map((c) => c.name);
    const message = used.length ? t('This cannot be undone. It is loaded on {channels} and will be unloaded.', { channels: used.join(', ') }) : t('This cannot be undone.');
    if (!(await confirmDialog({ title: t('Delete the project “{name}”?', { name: project.name }), message, confirm: t('Delete'), danger: true }))) return;
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
            <h1>{t('Project settings')}</h1>
            <p className="muted">{t('Name, description and the format the templates are designed in.')}</p>
          </div>
        </div>
        <form className="set-card" onSubmit={save}>
          <header>
            <SettingsIcon size={16} />
            <h2>{t('General')}</h2>
          </header>
          <div className="set-body">
            <label className="set-field">
              <span className="set-label">{t('Name')}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="set-field">
              <span className="set-label">{t('Description')}</span>
              <input value={description} placeholder={t('What this project is for')} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="set-field">
              <span className="set-label">{t('Design format')}</span>
              <FormatButtons width={format.width} height={format.height} rate={format.rate} onSize={(width, height) => setFormat({ ...format, width, height })} onRate={(rate) => setFormat({ ...format, rate })} />
              <span className="set-hint">{t('The original format of the templates. Changing it does not move or rescale existing layers; channels in another format scale the graphics to fit.')}</span>
            </div>
            <div className="row end">
              <button className="btn primary" disabled={busy || !dirty || !name.trim()}>
                <Save size={14} /> {t('Save')}
              </button>
            </div>
          </div>
        </form>
        <section className="set-card">
          <header>
            <Download size={16} />
            <h2>{t('Export and delete')}</h2>
          </header>
          <div className="set-body">
            <div className="row">
              <a className="btn" href={`${url}/export`}>
                <Download size={14} /> {t('Export (.strata.json)')}
              </a>
              <div className="spacer" />
              <button type="button" className="btn danger" onClick={remove}>
                <Trash2 size={14} /> {t('Delete project')}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
