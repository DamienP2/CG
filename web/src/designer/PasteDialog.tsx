import { ClipboardPaste, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { PROP_LABELS } from './Inspector';
import { findLayer, useDesigner } from './designerStore';
import { pasteAll, pasteChoices, useClipboard } from './clipboard';

/** « Paste… » after « Copy all »: what to take from the copied layer — values by group, its animation, its span. */
export function PasteDialog() {
  const targets = useClipboard((c) => c.pasting);
  const clip = useClipboard((c) => c.all);
  const template = useDesigner((s) => s.template);
  const [groups, setGroups] = useState<string[]>([]);
  const [animation, setAnimation] = useState(true);
  const [span, setSpan] = useState(false);
  const layers = (targets ?? []).map((id) => template && findLayer(template, id)).filter((l) => !!l);
  const choices = clip && layers.length ? pasteChoices(clip, layers) : null;
  // The animation ticked to begin with (values would move the layer onto the copied one: chosen by hand).
  useEffect(() => {
    if (!choices) return;
    setGroups([]);
    setAnimation(choices.animated.length > 0);
    setSpan(false);
  }, [targets]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!targets || !clip || !choices) return null;
  const close = () => useClipboard.setState({ pasting: null });
  const toggle = (id: string) => setGroups((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));
  const none = !groups.length && !animation && !span;
  return createPortal(
    <div className="modal-back" onPointerDown={close}>
      <form
        className="modal paste-dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          pasteAll(targets, { groups, animation, span });
          close();
        }}
      >
        <header>
          <h2>{t('Paste from “{name}”', { name: clip.label })}</h2>
          <button type="button" className="icon-btn ghost" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <div className="paste-list">
          {choices.groups.length > 0 && <span className="set-label">{t('Values')}</span>}
          {choices.groups.map((g) => (
            <label key={g.id} className="check">
              <input type="checkbox" checked={groups.includes(g.id)} onChange={() => toggle(g.id)} />
              {t(g.label)}
            </label>
          ))}
          {(choices.animated.length > 0 || choices.span) && <span className="set-label">{t('Animation')}</span>}
          {choices.animated.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={animation} onChange={(e) => setAnimation(e.target.checked)} />
              {t('Keyframes')}
              <span className="muted small">{choices.animated.map((p) => t(PROP_LABELS[p] ?? p)).join(', ')}</span>
            </label>
          )}
          {choices.span && (
            <label className="check">
              <input type="checkbox" checked={span} onChange={(e) => setSpan(e.target.checked)} />
              {t('When it is shown (timeline bar)')}
            </label>
          )}
        </div>
        <footer>
          <button type="button" className="btn" onClick={close}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={none}>
            <ClipboardPaste size={14} /> {t('Paste')}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
