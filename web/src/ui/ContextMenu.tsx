import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  icon: React.ReactNode;
  label: string;
  run: () => unknown;
  disabled?: boolean;
  danger?: boolean;
  /** A check mark: this choice is on. */
  on?: boolean;
}

/** A menu at the pointer (« … » or right-click), kept in the window; Esc or a click elsewhere closes it. */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: (ContextMenuItem | null)[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Where it fits, from its real size: under the click, else above it, always in the window.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const m = 8;
    const left = Math.max(m, Math.min(at.x, window.innerWidth - width - m));
    const below = at.y + height + m <= window.innerHeight;
    const top = below ? at.y : Math.max(m, Math.min(at.y - height, window.innerHeight - height - m));
    setPos({ left, top });
  }, [at.x, at.y, items.length]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), onClose());
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('keydown', esc);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', esc);
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="menu project-menu clip-menu opx-row-menu" style={{ position: 'fixed', left: pos?.left ?? at.x, top: pos?.top ?? at.y, right: 'auto', maxHeight: 'calc(100vh - 16px)', overflowY: 'auto', visibility: pos ? undefined : 'hidden' }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it ? (
          <button key={i} className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => (onClose(), void it.run())}>
            {it.icon} {it.label}
            {it.on && <i className="opx-row-menu-on" />}
          </button>
        ) : (
          <div key={i} className="menu-sep" />
        ),
      )}
    </div>,
    document.body,
  );
}
