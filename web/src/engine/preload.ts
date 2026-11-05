import type { Project } from './types';

/*
 * What a project shows, made ready before it goes on air (the HTML5 output):
 * its fonts loaded (a face is otherwise fetched on its first use, and its text
 * stays invisible meanwhile) and its pictures decoded (otherwise on the frame
 * they first appear).
 */

const PICTURE = /^\/assets\/.+\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i;

/** Pictures kept decoded for the project shown. */
const kept: HTMLImageElement[] = [];

export function preloadProject(project: Project) {
  const fonts = new Set<string>();
  const pictures = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.fontFamily === 'string' && o.fontFamily.trim()) {
        const w = typeof o.fontWeight === 'number' ? o.fontWeight : 400;
        fonts.add(`${o.italic === true ? 'italic ' : ''}${w} 32px "${o.fontFamily}"`);
      }
      Object.values(o).forEach(walk);
    } else if (typeof v === 'string' && PICTURE.test(v)) pictures.add(v);
  };
  walk(project);
  if (typeof document !== 'undefined' && document.fonts) for (const f of fonts) document.fonts.load(f).catch(() => {});
  const decoded = [...pictures].map((src) => {
    const img = new Image();
    img.src = src;
    img.decode().catch(() => {});
    return img;
  });
  kept.splice(0, kept.length, ...decoded);
}
