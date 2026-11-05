/*
 * The layout of the main pages (Projects, Assets, Users, API, MOS,
 * Settings): a list on the left, the page on the right.
 */
import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * Inside the System page: where a page's own list goes (under its item in
 * the System list); the page itself fills the System page's right part.
 */
export const EmbeddedNav = createContext<HTMLElement | null | undefined>(undefined);

export function SidePage({ nav, children, className = '', after, ...rest }: { nav: React.ReactNode; children: React.ReactNode; className?: string; after?: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const slot = useContext(EmbeddedNav);
  if (slot !== undefined)
    return (
      <div className={`sys-embed ${className}`} {...rest}>
        {slot && nav ? createPortal(nav, slot) : null}
        <div className="library-inner wide">{children}</div>
        {after}
      </div>
    );
  return (
    <div className={`projects-page ${className}`} {...rest}>
      <aside className="lib-nav">{nav}</aside>
      <main className="library">
        <div className="library-inner wide">{children}</div>
      </main>
      {after}
    </div>
  );
}

export function NavSection({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="lib-nav-section">
      <span className="grow">{children}</span>
      {actions}
    </div>
  );
}

export function NavItem({
  on,
  icon,
  label,
  count,
  onClick,
  actions,
  status,
  className = '',
  ...rest
}: {
  on?: boolean;
  icon: React.ReactNode;
  label: React.ReactNode;
  count?: React.ReactNode;
  onClick?: () => void;
  actions?: React.ReactNode;
  /** A dot: ok, warn, off. */
  status?: 'ok' | 'warn' | 'off';
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onClick'>) {
  return (
    <div className={`lib-nav-item ${on ? 'on' : ''} ${className}`} onClick={onClick} {...rest}>
      {icon}
      <span className="grow">{label}</span>
      {actions}
      {status && <span className={`nav-dot ${status}`} />}
      {count !== undefined && <span className="count">{count}</span>}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="settings-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}

/** The pages of a section, as tabs under its title (System). */
export function SubTabs<T extends string>({ value, onChange, items, children }: { value: T; onChange: (v: T) => void; items: { id: T; icon?: React.ReactNode; label: React.ReactNode; count?: React.ReactNode; status?: 'ok' | 'warn' | 'off' }[]; /** The open page's actions, at the right. */ children?: React.ReactNode }) {
  return (
    <div className="sys-tabrow">
      <div className="tabs sys-tabs" role="tablist">
        {items.map((i) => (
          <button key={i.id} role="tab" aria-selected={value === i.id} className={value === i.id ? 'on' : ''} onClick={() => onChange(i.id)}>
            {i.icon}
            <span>{i.label}</span>
            {i.status && <span className={`nav-dot ${i.status}`} />}
            {i.count !== undefined && <span className="sys-tab-n">{i.count}</span>}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
