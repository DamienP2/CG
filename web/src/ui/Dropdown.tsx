import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';

/*
 * A designed drop-down list (instead of the browser's <select>): a button
 * with the current choice, and a list in a layer over the page, so it stays
 * readable at any zoom of the node canvases. Options can be grouped.
 */

export interface DropOption<V extends string> {
  value: V;
  label: string;
  /** Options with the same group are listed under its title. */
  group?: string;
  /** Muted text after the label (a unit, a hint). */
  note?: string;
  /** Style of the label (a font shown in itself). */
  style?: React.CSSProperties;
}

export function Dropdown<V extends string>({ value, options, onChange, title, placeholder = '—', className = '' }: { value: V; options: readonly DropOption<V>[]; onChange: (v: V) => void; title?: string; placeholder?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const [hover, setHover] = useState(-1);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setAt({ left: r.left, top: below < 240 && r.top > below ? r.top : r.bottom, width: r.width, up: below < 240 && r.top > below });
    setHover(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) {
        setOpen(false);
        // A click elsewhere leaves the list for good (no focused look left behind).
        btn.current?.blur();
      }
    };
    // Scrolling the list keeps it open; scrolling anything else closes it.
    const away = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', away, { passive: true });
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', away);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector('.dd-opt.hover')?.scrollIntoView({ block: 'nearest' });
  }, [open, hover]);

  const pick = (v: V, keyboard = false) => {
    setOpen(false);
    if (v !== value) onChange(v);
    if (keyboard) btn.current?.focus();
    else btn.current?.blur();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      setOpen(false);
      btn.current?.focus();
    }
    else if (e.key === 'ArrowDown') setHover((h) => Math.min(options.length - 1, h + 1));
    else if (e.key === 'ArrowUp') setHover((h) => Math.max(0, h - 1));
    else if (e.key === 'Enter' && options[hover]) pick(options[hover].value, true);
    else return;
    e.preventDefault();
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`dd-btn ${open ? 'open' : ''} ${className}`}
        title={title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span className="dd-label" style={current?.style}>{current?.label ?? (value || placeholder)}</span>
        <ChevronDown size={12} />
      </button>
      {open &&
        at &&
        createPortal(
          <div
            ref={list}
            className={`dd-list ${at.up ? 'up' : ''}`}
            style={{ left: at.left, top: at.up ? undefined : at.top + 4, bottom: at.up ? window.innerHeight - at.top + 4 : undefined, minWidth: Math.max(160, at.width) }}
            role="listbox"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {options.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <div key={o.value}>
                  {head && <div className="dd-group">{head}</div>}
                  <div role="option" aria-selected={o.value === value} className={`dd-opt ${o.value === value ? 'on' : ''} ${i === hover ? 'hover' : ''}`} onPointerEnter={() => setHover(i)} onClick={() => pick(o.value)}>
                    <span className="dd-check">{o.value === value && <Check size={12} />}</span>
                    <span className="dd-text" style={o.style}>{o.label}</span>
                    {o.note && <span className="dd-note">{o.note}</span>}
                  </div>
                </div>
              );
            })}
            {!options.length && <div className="dd-empty">{t('Nothing to choose')}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
