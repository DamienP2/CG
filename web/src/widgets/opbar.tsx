// The one control bar of a widget (validated grammar §1): the same row serves the
// Operator's compact contexts (preview bar, On air panel) and the Designer's
// « Operator » section. Helpers shared by the widgets; the primitives (PlayToggle,
// Transport, Sep, Readout, Btns) live in kit.tsx.
import { useContext, useState, type ReactNode, type Ref } from 'react';
import { Ellipsis, RefreshCw } from 'lucide-react';
import { MoreButton, MoreToggle } from './kit';
import { useApp } from '../store';
import { t } from '../i18n';

/**
 * One row of controls, the ⋯ last. In the Operator the shell provides the ⋯
 * (MoreToggle) and draws the More row itself; alone (the Designer's Operator
 * section) the bar holds its own ⋯ and unfolds `more` under the row.
 */
export function OpBar({ children, more }: { children: ReactNode; more?: ReactNode }) {
  const ctx = useContext(MoreToggle);
  const [open, setOpen] = useState(false);
  if (ctx !== null || !more) {
    return (
      <div className="wk-oprow">
        {children}
        <MoreButton />
      </div>
    );
  }
  return (
    <>
      <div className="wk-oprow">
        {children}
        <button className={`opx-sq ${open ? 'on' : ''}`} title={t('More')} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Ellipsis size={14} />
        </button>
      </div>
      {open && <div className="wk-oprow">{more}</div>}
    </>
  );
}

/**
 * The grammar's « field + Set » (§1.4): an EMPTY mono field (placeholder only,
 * never the current value twice) and its violet pill. `onSet` returns an error
 * text to refuse the value (a toast; nothing changes on air).
 */
export function SetField({ placeholder, title, onSet, width = 76, label, inputRef }: { placeholder: string; title: string; onSet: (v: string) => string | void; width?: number; label?: string; inputRef?: Ref<HTMLInputElement> }) {
  const toast = useApp((s) => s.toast);
  const [v, setV] = useState('');
  const send = () => {
    const s = v.trim();
    if (!s) return;
    const err = onSet(s);
    if (typeof err === 'string') return void toast(t('{error} — nothing changed on air.', { error: err }), 'error');
    setV('');
  };
  return (
    <>
      <input
        ref={inputRef}
        className="mono"
        style={{ width, height: 28, textAlign: 'center' }}
        title={title}
        placeholder={placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') send();
          if (e.key === 'Escape') setV('');
        }}
      />
      <button className="opx-btn wk-btn violet" disabled={!v.trim()} title={title} onClick={send}>
        <span>{label ?? t('Set')}</span>
      </button>
    </>
  );
}

/** The RELOAD pill of a linked source (picture, data, web page): violet outline, same height as the bar. */
export function ReloadBtn({ title, onClick }: { title?: string; onClick: () => void }) {
  return (
    <button className="opx-btn wk-btn violet" title={title} onClick={onClick}>
      <RefreshCw size={13} />
      <span>{t('Reload')}</span>
    </button>
  );
}
