import type { LayerRow, LogicClip, LogicEdge, LogicNode, LogicNodeKind } from '../engine/types';

/*
 * Ready-made flows of the Logic canvas. Each one is a clip whose layers and fields are stand-ins
 * (« Texte », « Plaque »…): when it is inserted, they are matched to the template's (by the
 * insert dialog). Labels and tags are English keys (translated where shown).
 */

export interface Preset {
  key: string;
  name: string;
  tag: string;
  clip: LogicClip;
}

export const PRESET_TAGS = ['Layout', 'Text', 'Data', 'On air', 'Timing', 'Sport', 'Elections', 'Markets & weather'];

/** Builds a clip: nodes (laid out by depth), wires, stand-in layers. */
function build(fn: (b: Builder) => void): LogicClip {
  const b = new Builder();
  fn(b);
  return b.clip();
}

class Builder {
  nodes: LogicNode[] = [];
  edges: LogicEdge[] = [];
  layers: { id: string; name: string; type: string }[] = [];
  fields: string[] = [];
  private n = 0;
  layer(name: string, type: string) {
    const id = `L${this.layers.length + 1}`;
    this.layers.push({ id, name, type });
    return id;
  }
  node(kind: LogicNodeKind, title?: string) {
    const id = `n${++this.n}`;
    this.nodes.push({ ...kind, id, x: 0, y: 0, ...(title ? { title } : {}) } as LogicNode);
    if (kind.type === 'field' && kind.key && !this.fields.includes(kind.key)) this.fields.push(kind.key);
    return id;
  }
  rows(layer: string, keys: (string | LayerRow)[]) {
    return this.node({ type: 'layer', layer, rows: keys.map((k) => (typeof k === 'string' ? { key: k } : k)) });
  }
  field(key: string) {
    return this.node({ type: 'field', key });
  }
  calc(expr: string, inputs = ['a'], title?: string) {
    return this.node({ type: 'expr', expr, inputs }, title);
  }
  wire(from: string, fromPort: string, to: string, port: string) {
    this.edges.push({ from, ...(fromPort !== 'out' ? { fromPort } : {}), to, port });
  }
  clip(): LogicClip {
    // Laid out from left to right by depth.
    const depth = new Map<string, number>();
    const d = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const ins = this.edges.filter((e) => e.to === id).map((e) => d(e.from, seen) + 1);
      const v = ins.length ? Math.max(...ins) : 0;
      depth.set(id, v);
      return v;
    };
    const rows = new Map<number, number>();
    for (const n of this.nodes) {
      const k = d(n.id);
      const r = rows.get(k) ?? 0;
      rows.set(k, r + 1);
      n.x = 40 + k * 290;
      n.y = 60 + r * 190;
    }
    return { v: 1, nodes: this.nodes, edges: this.edges, frames: [], layers: this.layers, ...(this.fields.length ? { fields: this.fields } : {}) };
  }
}

const p = (key: string, name: string, tag: string, fn: (b: Builder) => void): Preset => ({ key, name, tag, clip: build(fn) });

export const PRESETS: Preset[] = [
  p('plate', 'Plate that follows the text', 'Layout', (b) => {
    const txt = b.layer('Text', 'text');
    const plate = b.layer('Plate', 'rect');
    const a = b.rows(txt, ['text.width']);
    const c = b.calc('limiter(a + 2 * 40, 300, 1600)', ['a'], 'Clamp');
    const w = b.rows(plate, ['width']);
    b.wire(a, 'text.width', c, 'a');
    b.wire(c, 'out', w, 'width');
  }),
  p('fit', 'Text too long: smaller size', 'Text', (b) => {
    const txt = b.layer('Text', 'text');
    const read = b.rows(txt, ['text.width', 'fontSize']);
    const i = b.node({ type: 'if', inputs: ['a', 'b'], branches: [{ when: 'a > 1200', value: 'b * 1200 / a' }], otherwise: 'b' });
    const set = b.rows(txt, ['fontSize']);
    b.wire(read, 'text.width', i, 'a');
    b.wire(read, 'fontSize', i, 'b');
    b.wire(i, 'out', set, 'fontSize');
  }),
  p('hide', 'Hide when the field is empty', 'Data', (b) => {
    const l = b.layer('Any layer', 'group');
    const f = b.field('name');
    const c = b.calc('si(vide(a), 0, 1)', ['a'], 'Is empty');
    const o = b.rows(l, [{ key: 'opacity', mode: 'multiply' }]);
    b.wire(f, 'out', c, 'a');
    b.wire(c, 'out', o, 'opacity');
  }),
  p('center', 'Centre a logo and a name together', 'Layout', (b) => {
    const logo = b.layer('Logo', 'image');
    const name = b.layer('Name', 'text');
    const lw = b.rows(logo, ['width']);
    const nw = b.rows(name, ['text.width']);
    const x0 = b.calc('(1920 - (a + 20 + b)) / 2', ['a', 'b'], 'Calculation');
    const x1 = b.calc('c + a + 20', ['a', 'c'], 'Calculation');
    const lx = b.rows(logo, ['x']);
    const nx = b.rows(name, ['x']);
    b.wire(lw, 'width', x0, 'a');
    b.wire(nw, 'text.width', x0, 'b');
    b.wire(x0, 'out', lx, 'x');
    b.wire(lw, 'width', x1, 'a');
    b.wire(x0, 'out', x1, 'c');
    b.wire(x1, 'out', nx, 'x');
  }),
  p('winner', 'Winner / loser / draw colour', 'Sport', (b) => {
    const bg = b.layer('Background', 'rect');
    const fa = b.field('score_home');
    const fb = b.field('score_away');
    const i = b.node({
      type: 'if',
      inputs: ['a', 'b'],
      branches: [
        { when: 'a > b', value: '"#16a34a"' },
        { when: 'a < b', value: '"#dc2626"' },
      ],
      otherwise: '"#64748b"',
    });
    const f = b.rows(bg, ['fill']);
    b.wire(fa, 'out', i, 'a');
    b.wire(fb, 'out', i, 'b');
    b.wire(i, 'out', f, 'fill');
  }),
  p('highlight', 'Highlight the winner', 'Sport', (b) => {
    const ta = b.layer('Team A', 'group');
    const tb = b.layer('Team B', 'group');
    const fa = b.field('score_home');
    const fb = b.field('score_away');
    const ca = b.calc('si(a > b, 1.12, 1)', ['a', 'b'], 'Compare');
    const cb = b.calc('si(b > a, 1.12, 1)', ['a', 'b'], 'Compare');
    const sa = b.rows(ta, [{ key: 'scaleX', mode: 'multiply' }, { key: 'scaleY', mode: 'multiply' }]);
    const sb = b.rows(tb, [{ key: 'scaleX', mode: 'multiply' }, { key: 'scaleY', mode: 'multiply' }]);
    for (const c of [ca, cb]) {
      b.wire(fa, 'out', c, 'a');
      b.wire(fb, 'out', c, 'b');
    }
    b.wire(ca, 'out', sa, 'scaleX');
    b.wire(ca, 'out', sa, 'scaleY');
    b.wire(cb, 'out', sb, 'scaleX');
    b.wire(cb, 'out', sb, 'scaleY');
  }),
  p('arrow', 'Up / down arrow and colour', 'Markets & weather', (b) => {
    const arrow = b.layer('Arrow', 'polygon');
    const f = b.field('change');
    const i = b.node({
      type: 'if',
      inputs: ['a'],
      branches: [
        { when: 'a > 0', value: '"#16a34a"' },
        { when: 'a < 0', value: '"#dc2626"' },
      ],
      otherwise: '"#94a3b8"',
    });
    const r = b.calc('si(a < 0, 180, 0)', ['a'], 'Compare');
    const l = b.rows(arrow, ['fill', 'rotation']);
    b.wire(f, 'out', i, 'a');
    b.wire(f, 'out', r, 'a');
    b.wire(i, 'out', l, 'fill');
    b.wire(r, 'out', l, 'rotation');
  }),
  p('alert', 'Alert threshold that blinks', 'Markets & weather', (b) => {
    const l = b.layer('Alert', 'group');
    const f = b.field('value');
    const c = b.calc('si(a > 80, 0.25 + 0.75 * clignoter(0.8), 1)', ['a'], 'Blink');
    const o = b.rows(l, [{ key: 'opacity', mode: 'multiply' }]);
    b.wire(f, 'out', c, 'a');
    b.wire(c, 'out', o, 'opacity');
  }),
  p('bar', 'Percentage bar within bounds', 'Data', (b) => {
    const bar = b.layer('Bar', 'rect');
    const f = b.field('percent');
    const c = b.calc('remapper(a, 0, 100, 0, 1200)', ['a'], 'Remap');
    const w = b.rows(bar, ['width']);
    b.wire(f, 'out', c, 'a');
    b.wire(c, 'out', w, 'width');
  }),
  p('short', 'Readable numbers (1,2 k · 3,4 M)', 'Text', (b) => {
    const txt = b.layer('Text', 'text');
    const f = b.field('viewers');
    const c = b.calc('compact(a)', ['a'], 'Short number (1,2 k)');
    const t = b.rows(txt, ['content.text']);
    b.wire(f, 'out', c, 'a');
    b.wire(c, 'out', t, 'content.text');
  }),
  p('plural', 'Plural on its own', 'Text', (b) => {
    const txt = b.layer('Text', 'text');
    const f = b.field('points');
    const c = b.calc('a & " " & pluriel(a, "point", "points")', ['a'], 'Plural');
    const t = b.rows(txt, ['content.text']);
    b.wire(f, 'out', c, 'a');
    b.wire(c, 'out', t, 'content.text');
  }),
  p('logo', 'Logo from the name (table)', 'Data', (b) => {
    const img = b.layer('Logo', 'image');
    const f = b.field('team');
    const lk = b.node({
      type: 'lookup',
      rows: [
        { key: 'PSG', value: '/assets/psg.png' },
        { key: 'OM', value: '/assets/om.png' },
        { key: 'OL', value: '/assets/ol.png' },
      ],
      otherwise: '/assets/ligue.png',
    });
    const s = b.rows(img, ['content.src']);
    b.wire(f, 'out', lk, 'in');
    b.wire(lk, 'out', s, 'content.src');
  }),
  p('party', 'Bar in the colour of the party', 'Elections', (b) => {
    const bar = b.layer('Bar', 'rect');
    const f = b.field('party');
    const lk = b.node({
      type: 'lookup',
      rows: [
        { key: 'PS', value: '#e11d48' },
        { key: 'LR', value: '#2563eb' },
        { key: 'RN', value: '#1e3a8a' },
        { key: 'EELV', value: '#16a34a' },
        { key: 'LFI', value: '#b91c1c' },
      ],
      otherwise: '#94a3b8',
    });
    const fill = b.rows(bar, ['fill']);
    b.wire(f, 'out', lk, 'in');
    b.wire(lk, 'out', fill, 'fill');
  }),
  p('lang', 'French / English every 6 s', 'Timing', (b) => {
    const txt = b.layer('Text', 'text');
    const every = b.node({ type: 'every', seconds: 6 });
    const cnt = b.node({ type: 'counter', start: 0, step: 1 });
    const fr = b.field('text_fr');
    const en = b.field('text_en');
    const c = b.calc('si(n % 2 = 1, en, fr)', ['n', 'fr', 'en'], 'Calculation');
    const t = b.rows(txt, ['content.text']);
    b.wire(every, 'out', cnt, 'run');
    b.wire(cnt, 'out', c, 'n');
    b.wire(fr, 'out', c, 'fr');
    b.wire(en, 'out', c, 'en');
    b.wire(c, 'out', t, 'content.text');
  }),
  p('autoOut', 'Take out after N seconds', 'On air', (b) => {
    const s = b.node({ type: 'start' });
    const w = b.node({ type: 'wait', seconds: 8 });
    const o = b.node({ type: 'out' });
    b.wire(s, 'out', w, 'run');
    b.wire(w, 'next', o, 'run');
  }),
  p('rows', 'Go through the rows, then out', 'On air', (b) => {
    const every = b.node({ type: 'every', seconds: 5 });
    const last = b.node({ type: 'event', on: { kind: 'lastRow', dataset: '' } });
    const i = b.node({ type: 'if', inputs: ['last'], branches: [{ when: 'last = 1', value: '' }], otherwise: '' });
    const o = b.node({ type: 'out' });
    const n = b.node({ type: 'nextRow', dataset: '' });
    b.wire(every, 'out', i, 'run');
    b.wire(last, 'out', i, 'last');
    b.wire(i, 'b0', o, 'run');
    b.wire(i, 'else', n, 'run');
  }),
  p('f2', 'F2: next row, out at the end', 'On air', (b) => {
    const f2 = b.node({ type: 'continue' });
    const last = b.node({ type: 'event', on: { kind: 'lastRow', dataset: '' } });
    const i = b.node({ type: 'if', inputs: ['last'], branches: [{ when: 'last = 1', value: '' }], otherwise: '' });
    const o = b.node({ type: 'out' });
    const n = b.node({ type: 'nextRow', dataset: '' });
    b.wire(f2, 'out', i, 'run');
    b.wire(last, 'out', i, 'last');
    b.wire(i, 'b0', o, 'run');
    b.wire(i, 'else', n, 'run');
  }),
  p('moveUp', 'Move up when another graphic comes in', 'On air', (b) => {
    const l = b.layer('Graphic', 'group');
    const air = b.node({ type: 'onAir', template: '', transition: 0.4 });
    const c = b.calc('a * -120', ['a'], 'Calculation');
    const y = b.rows(l, [{ key: 'y', mode: 'add' }]);
    b.wire(air, 'out', c, 'a');
    b.wire(c, 'out', y, 'y');
  }),
  p('timerEnd', 'End of the timer: trigger, then out', 'Timing', (b) => {
    const ev = b.node({ type: 'event', on: { kind: 'timerZero', layer: '' } });
    const fire = b.node({ type: 'fire', name: 'end' });
    const w = b.node({ type: 'wait', seconds: 3 });
    const o = b.node({ type: 'out' });
    b.wire(ev, 'out', fire, 'run');
    b.wire(fire, 'next', w, 'run');
    b.wire(w, 'next', o, 'run');
  }),
  p('apiGlide', 'Trigger from the API: a value that glides', 'Data', (b) => {
    const l = b.layer('Graphic', 'group');
    const up = b.node({ type: 'triggerIn', name: 'up' });
    const down = b.node({ type: 'triggerIn', name: 'down' });
    const s1 = b.node({ type: 'setVar', name: 'pos', value: '1', transition: 0.5 });
    const s0 = b.node({ type: 'setVar', name: 'pos', value: '0', transition: 0.5 });
    const v = b.node({ type: 'var', name: 'pos', test: 0 });
    const c = b.calc('a * -150', ['a'], 'Calculation');
    const y = b.rows(l, [{ key: 'y', mode: 'add' }]);
    b.wire(up, 'out', s1, 'run');
    b.wire(down, 'out', s0, 'run');
    b.wire(v, 'out', c, 'a');
    b.wire(c, 'out', y, 'y');
  }),
  p('greeting', 'Morning / afternoon / evening from the hour', 'Timing', (b) => {
    const txt = b.layer('Text', 'text');
    const i = b.node({
      type: 'if',
      inputs: [],
      branches: [
        { when: 'heure() < 12', value: '"Bonjour"' },
        { when: 'heure() < 18', value: '"Bon après-midi"' },
      ],
      otherwise: '"Bonsoir"',
    });
    const t = b.rows(txt, ['content.text']);
    b.wire(i, 'out', t, 'content.text');
  }),
  p('live', '« LIVE » that pulses while true', 'On air', (b) => {
    const l = b.layer('LIVE', 'group');
    const v = b.node({ type: 'var', name: 'live', test: 1 });
    const c = b.calc('si(a, 0.6 + 0.4 * osciller(1.2), 0)', ['a'], 'Oscillate');
    const o = b.rows(l, [{ key: 'opacity', mode: 'multiply' }]);
    b.wire(v, 'out', c, 'a');
    b.wire(c, 'out', o, 'opacity');
  }),
];
