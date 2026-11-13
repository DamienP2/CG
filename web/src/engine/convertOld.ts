// The Ticker and Credits widgets of before, made into the Builder's bricks: a folder repeated once per
// row of its list (its items, its entries), going by in its box (engine/lists.ts). The folder keeps the
// widget's id (its Logic, its operator clock still find it). What the bricks cannot do is dropped:
// scrolling right or down, transitions other than a slide, a number of passes, an empty-list message,
// QR code lines, space styles. Pure: no browser (also run on the example projects).
import type { Layer, ListRepeat, Prop, Roll, Template } from './types';

type Any = Record<string, unknown>;
type Rows = Record<string, string>[];

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

/** `#rrggbb[aa]` as the colour a prop holds (0..1). */
function color(hex: string | undefined, fallback: number[]): number[] {
  const h = (hex ?? '').trim().replace(/^#/, '');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return fallback;
  const p = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [p(0), p(2), p(4), h.length === 8 ? p(6) : 1];
}

const layer = (id: string, name: string, type: string, parent: string | null, props: Any, more: Any = {}): Layer =>
  ({ id, name, type, parent, visible: true, locked: false, props, tracks: {}, bindings: {}, ...more }) as unknown as Layer;

const textLayer = (id: string, name: string, parent: string | null, text: string, props: Any, style: Any, more: Any = {}) =>
  layer(id, name, 'text', parent, props, { text, align: 'left', verticalAlign: 'middle', uppercase: false, ...style, ...more });

/** What the folder of a converted widget keeps of it: its place in the timeline, its start. */
function folderOf(old: Any, props: Any, list: ListRepeat, roll: Roll): Layer {
  const keep = Object.fromEntries(['span', 'motion', 'manualStart', 'startOn', 'startTrigger', 'liveChanges', 'timeline'].filter((k) => old[k] !== undefined).map((k) => [k, old[k]]));
  return layer(str(old.id), str(old.name), 'group', (old.parent as string | null) ?? null, props, {
    ...keep,
    visible: old.visible !== false,
    locked: !!old.locked,
    tracks: old.tracks ?? {},
    clip: true,
    list,
    roll,
  });
}

/** A ticker: its items (a field's lines, or its own with their categories) going by. */
function ticker(old: Any): Layer[] {
  const id = str(old.id);
  const p = (old.props ?? {}) as Any;
  const [x, y, w, h] = [num(p.x, 0), num(p.y, 0), num(p.width, 1920), num(p.height, 64)];
  const size = num(p.fontSize, 32);
  const fill = (p.fill as number[] | undefined) ?? [1, 1, 1, 1];
  const style = { fontFamily: str(old.fontFamily, 'Inter'), fontWeight: num(old.fontWeight, 600), uppercase: !!old.uppercase };
  const crawl = (old.mode ?? 'crawl') === 'crawl';
  const out: Layer[] = [];
  // The band and the title block: drawn beside the folder (they do not go by).
  if (old.barBg) out.push(layer(`${id}-bar`, 'Fond', 'rect', (old.parent as string) ?? null, { x, y, width: w, height: h, fill: color(str(old.barBg), [0, 0, 0, 0.8]) }));
  const title = (old.title ?? {}) as Any;
  const tw = title.on ? num(title.w, 160) : 0;
  if (title.on) {
    out.push(layer(`${id}-tbg`, 'Bloc du titre', 'rect', (old.parent as string) ?? null, { x, y, width: tw, height: h, fill: color(str(title.bg), [0.88, 0.11, 0.28, 1]) }));
    out.push(textLayer(`${id}-ttl`, 'Titre', (old.parent as string) ?? null, str(title.text), { x, y, width: tw, height: h, fontSize: size * 0.8, fill: color(str(title.color), [1, 1, 1, 1]) }, { ...style, fontWeight: 800, align: 'center' }));
  }
  // Its rows: a field ({{items}}: one per line), else its own items, else its text's lines.
  const field = /^\s*\{\{\s*([^{}\s]+)\s*\}\}\s*$/.exec(str(old.text));
  const items = (old.items as Any[] | undefined) ?? [];
  const cats = (old.cats as Any[] | undefined) ?? [];
  const bound = (old.settingBindings ?? {}) as Record<string, string>;
  let rows: Rows = [];
  if (!field && items.length)
    rows = items.map((it, i) => ({ texte: str(it.text), catégorie: bound[`items.${i}.cat`] ? `{{${bound[`items.${i}.cat`]}}}` : str(it.cat), ...(it.on === false ? { on: 'false' } : {}) }));
  else if (!field) rows = str(old.text).split('\n').map((t) => t.trim()).filter(Boolean).map((t) => ({ texte: t }));
  const list: ListRepeat = { key: field?.[1] ?? '', layout: crawl ? 'row' : 'column', gap: crawl ? num(old.spacing, 28) : 0, ...(rows.length ? { rows } : {}) };
  const roll: Roll = crawl
    ? { mode: 'continuous', dir: 'left', by: 'speed', speed: num(old.speed, 120), duration: 30, pause: 4, fade: old.fade ? num(old.fadeW, 60) : 0 }
    : { mode: 'one', dir: 'up', by: 'speed', speed: 120, duration: 30, pause: num(old.itemDur, 4), fade: 0 };
  out.push(folderOf(old, { x: x + tw, y, width: w - tw, height: h }, list, roll));
  // Inside: the separator, the category, the item.
  let at = 0;
  const sep = str(old.sepType, 'symbol');
  if (crawl && (sep === 'symbol' || sep === 'text')) {
    const glyph = sep === 'symbol' ? str(old.sepSymbol, '•') : str(old.separator).trim() || '•';
    out.push(textLayer(`${id}-sep`, 'Séparateur', id, glyph, { x: 0, y: 0, width: size, height: h, fontSize: size * 0.6, fill: color(str(old.sepColor), fill) }, { ...style, align: 'center', overflow: 'visible' }));
    at = size + 12;
  } else if (crawl && sep === 'image' && old.sepImage) {
    out.push(layer(`${id}-sep`, 'Séparateur', 'image', id, { x: 0, y: h * 0.2, width: h * 0.6, height: h * 0.6 }, { src: str(old.sepImage), fit: 'contain' }));
    at = h * 0.6 + 12;
  }
  if (cats.length) {
    const cw = Math.max(size * 1.2, ...cats.map((c) => str(c.name).length * size * 0.62 + 24));
    const by = (k: string, d: string) => Object.fromEntries(cats.map((c) => [str(c.name), str(c[k], d)]));
    const filled = { col: 'catégorie', test: 'filled' as const };
    out.push(layer(`${id}-cat`, 'Catégorie', 'rect', id, { x: at, y: h * 0.18, width: cw, height: h * 0.64, cornerRadius: 4, fill: color(str(cats[0].bg), [0.15, 0.39, 0.92, 1]) }, { inList: { when: filled, colors: [{ prop: 'fill' as Prop, col: 'catégorie', map: by('bg', '#2563eb') }] } }));
    out.push(
      textLayer(`${id}-catt`, 'Texte de la catégorie', id, '{{catégorie}}', { x: at, y: h * 0.18, width: cw, height: h * 0.64, fontSize: size * 0.7, fill: color(str(cats[0].color), [1, 1, 1, 1]) }, { ...style, fontWeight: 700, align: 'center' }, {
        inList: { when: filled, colors: [{ prop: 'fill' as Prop, col: 'catégorie', map: by('color', '#ffffff') }] },
      }),
    );
    at += cw + 12;
  }
  out.push(textLayer(`${id}-txt`, 'Texte', id, '{{texte}}', { x: at, y: 0, width: Math.max(200, w - tw - at), height: h, fontSize: size, fill }, { ...style, overflow: crawl ? 'visible' : 'fit' }));
  return out;
}

/** Credits: their entries (sections, roles and names, logos, spaces) going up, or by pages. */
function credits(old: Any): Layer[] {
  const id = str(old.id);
  const p = (old.props ?? {}) as Any;
  const [x, y, w, h] = [num(p.x, 0), num(p.y, 0), num(p.width, 1200), num(p.height, 700)];
  const st = (old.st ?? {}) as Record<string, Any>;
  const font = str(old.font, 'Inter');
  const look = (k: string, size: number, col: string, weight: number) => {
    const s = st[k] ?? {};
    return { size: num(s.size, size), fill: color(str(s.color, col), [1, 1, 1, 1]), style: { fontFamily: font, fontWeight: num(s.weight, weight), uppercase: !!s.upper } };
  };
  const sec = look('section', 24, '#8fa3ff', 700);
  const role = look('role', 22, '#c7cbe0', 500);
  const name = look('name', 30, '#ffffff', 700);
  const mode = str(old.mode, 'roll');
  const rows: Rows = ((old.entries as Any[] | undefined) ?? []).map((e) => ({ type: str(e.kind, 'line'), a: str(e.a), b: str(e.b) }));
  const list: ListRepeat = { key: '', rows, layout: mode === 'crawl' ? 'row' : mode === 'pages' ? 'grid' : 'column', ...(mode === 'pages' ? { cols: 1 } : {}), gap: num(old.lineGap, 14) };
  const roll: Roll =
    mode === 'pages'
      ? { mode: 'one', dir: 'up', by: 'speed', speed: 120, duration: 30, pause: num(old.cardDur, 4), fade: 0 }
      : mode === 'crawl'
        ? { mode: 'continuous', dir: 'left', by: 'speed', speed: num(old.pxs, 120), duration: 30, pause: 4, fade: old.fade ? 80 : 0 }
        : old.speedMode === 'pxs'
          ? { mode: 'continuous', dir: 'up', by: 'speed', speed: num(old.pxs, 60), duration: 30, pause: 4, fade: old.fade ? 120 : 0 }
          : { mode: 'continuous', dir: 'up', by: 'duration', speed: 60, duration: num(old.duration, 30), pause: 4, fade: old.fade ? 120 : 0 };
  const is = (v: string) => ({ when: { col: 'type', test: 'is' as const, value: v } });
  const gutter = num(old.gutter, 48);
  const half = (w - gutter) / 2;
  const lineH = Math.max(role.size, name.size) * 1.5;
  return [
    folderOf(old, { x, y, width: w, height: h }, list, roll),
    textLayer(`${id}-sec`, 'Section', id, '{{a}}', { x: 0, y: 0, width: w, height: sec.size * 1.8, fontSize: sec.size, fill: sec.fill }, { ...sec.style, align: 'center', verticalAlign: 'bottom' }, { inList: is('section') }),
    textLayer(`${id}-role`, 'Rôle', id, '{{a}}', { x: 0, y: 0, width: half, height: lineH, fontSize: role.size, fill: role.fill }, { ...role.style, align: 'right' }, { inList: is('line') }),
    textLayer(`${id}-name`, 'Nom', id, '{{b}}', { x: half + gutter, y: 0, width: half, height: lineH, fontSize: name.size, fill: name.fill }, { ...name.style }, { inList: is('line') }),
    layer(`${id}-logo`, 'Logo', 'image', id, { x: (w - w * 0.3) / 2, y: 0, width: w * 0.3, height: num(old.logoH, 120) }, { src: '{{a}}', fit: 'contain', inList: is('logo') }),
    layer(`${id}-space`, 'Espace', 'rect', id, { x: 0, y: 0, width: w, height: num(old.spaceH, 40), fill: [0, 0, 0, 0] }, { inList: is('space') }),
  ];
}

/** The template with its old Ticker and Credits made into list folders; null when it has none. */
export function convertOldWidgets(tpl: Template): Template | null {
  if (!tpl.layers.some((l) => l.type === 'ticker' || l.type === 'credits')) return null;
  const layers = tpl.layers.flatMap((l) => (l.type === 'ticker' ? ticker(l as unknown as Any) : l.type === 'credits' ? credits(l as unknown as Any) : [l]));
  return { ...tpl, layers };
}
