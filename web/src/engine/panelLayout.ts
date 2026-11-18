// The Operator's panel of a built widget: its controls on a grid of 12 columns. A control placed in
// the Builder keeps its cell; one made before the grid is laid out from its old place (the buttons
// first, then the rows of buttons, the settings, the lists).
import type { BuiltControl, WidgetDef } from './types';

export const PANEL_COLS = 12;

/** The name of a row of buttons made before the grid, shown as a title (an id of its own). */
export const ROW_TITLE = '__row:';

export type Cell = { x: number; y: number; w: number; h: number };
export type Placed = { c: BuiltControl; at: Cell };

/** The usual size of a control of each kind. */
export function defaultSize(c: Pick<BuiltControl, 'kind' | 'items'>): { w: number; h: number } {
  switch (c.kind ?? 'button') {
    case 'title':
      return { w: 12, h: 1 };
    case 'buttons':
      return { w: Math.min(12, Math.max(4, (c.items?.length ?? 3) * 2)), h: 1 };
    case 'list':
      return { w: 12, h: 3 };
    case 'dropdown':
    case 'field':
    case 'slider':
      return { w: 6, h: 1 };
    case 'number':
    case 'toggle':
      return { w: 4, h: 1 };
    default:
      return { w: 3, h: 1 };
  }
}

/** A control's kind once read: a button by default. */
export const kindOf = (c: BuiltControl) => c.kind ?? 'button';

/** The controls laid out on the grid: their own cells, else from their old places. */
export function panelOf(def: Pick<WidgetDef, 'controls'>): Placed[] {
  const placed: Placed[] = [];
  let y = 0;
  let x = 0;
  const put = (c: BuiltControl, w: number, h = 1) => {
    if (x + w > PANEL_COLS) {
      x = 0;
      y++;
    }
    placed.push({ c, at: { x, y, w, h } });
    x += w;
    if (h > 1) {
      y += h;
      x = 0;
    }
  };
  const next = () => {
    if (x > 0) {
      x = 0;
      y++;
    }
  };
  const loose = def.controls.filter((c) => !c.grid);
  // Old places: the buttons line, each row of buttons (its name first), the settings, the lists.
  for (const c of loose.filter((c) => (c.place ?? 'actions') === 'actions' && c.kind !== 'list')) put(c, 3);
  next();
  const grouped = (place: 'row' | 'settings', w: number) => {
    const rows = new Map<string, BuiltControl[]>();
    for (const c of loose.filter((c) => c.place === place && c.kind !== 'list')) rows.set(c.row ?? '', [...(rows.get(c.row ?? '') ?? []), c]);
    for (const [name, cs] of rows) {
      if (name) put({ id: `${ROW_TITLE}${place}:${name}`, label: name, kind: 'title', actions: [] }, w);
      for (const c of cs) put(c, kindOf(c) === 'field' ? 2 * w : w);
      next();
    }
  };
  grouped('row', 2);
  grouped('settings', 3);
  for (const c of loose.filter((c) => c.kind === 'list')) put(c, 12, 3);
  next();
  // Placed in the Builder: under what was laid out.
  const base = placed.length ? y : 0;
  for (const c of def.controls.filter((c) => c.grid)) placed.push({ c, at: { ...c.grid!, y: c.grid!.y + base } });
  return placed;
}

/** Each control with its cell written (the Builder places them from then on); the names of old rows become titles. */
export const withCells = (controls: BuiltControl[]): BuiltControl[] => {
  if (controls.every((c) => c.grid)) return controls;
  const placed = panelOf({ controls });
  const at = new Map(placed.map((p) => [p.c.id, p.at]));
  // The row names keep their ids: a title placed in the Builder is the same one.
  const titles = placed.filter((p) => p.c.id.startsWith(ROW_TITLE)).map((p) => ({ ...p.c, grid: p.at }));
  // Where the panel shows them now (those placed already: under the ones laid out).
  return [...controls.map((c) => ({ ...c, grid: at.get(c.id) ?? c.grid ?? { x: 0, y: 0, ...defaultSize(c) } })), ...titles];
};

/** The control shows in this state of the widget (the Builder sees them all). */
export const shownIn = (c: BuiltControl, mode: 'pvw' | 'air' | 'all') => mode === 'all' || !c.visible || c.visible === 'both' || c.visible === mode;

/** The rows used, packed: rows with nothing shown leave no gap. */
export function packed(list: Placed[]): Placed[] {
  const used = [...new Set(list.flatMap((p) => Array.from({ length: p.at.h }, (_, i) => p.at.y + i)))].sort((a, b) => a - b);
  const map = new Map(used.map((r, i) => [r, i]));
  return list.map((p) => ({ ...p, at: { ...p.at, y: map.get(p.at.y) ?? p.at.y } }));
}

/** The first free row under the panel. */
export const bottomOf = (list: Placed[]) => list.reduce((m, p) => Math.max(m, p.at.y + p.at.h), 0);

/** A number written back as the Operator typed it (a « − » is a minus). */
export const numberOf = (s: string) => Number(String(s).replace('−', '-').replace(',', '.').trim());
