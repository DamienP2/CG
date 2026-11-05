import type { LucideIcon } from 'lucide-react';

/** An empty area: a small icon and a word, in its middle (what can be done there below). */
export function Empty({ icon: Icon, text, children }: { icon: LucideIcon; text: string; children?: React.ReactNode }) {
  return (
    <div className="opx-void">
      <span className="opx-void-ic">
        <Icon size={18} />
      </span>
      <span className="opx-void-t">{text}</span>
      {children}
    </div>
  );
}
