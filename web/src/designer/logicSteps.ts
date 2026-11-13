// The steps of the Logic: Source → When → If… → actions. What a When can watch on its source, what an
// If… line can test, and the making over of older graphs (moments on the source node, event nodes).
import type { CheckRow, Layer, Logic, LogicEdge, LogicNode, Template } from '../engine/types';
import { fromPortOf } from '../engine/logic';
import { newId } from '../engine/evaluate';
import { useApp } from '../store';
import { isProjectLogic, scrollLayer, timerLayer, videoLayer } from './logicNodes';

export interface Opt {
  value: string;
  label: string;
  group?: string;
  note?: string;
}

/** The node wired into the source of a When. */
export const sourceOf = (logic: Logic, id: string): LogicNode | undefined => {
  const e = logic.edges.find((x) => x.to === id && x.port === 'src');
  return e && logic.nodes.find((n) => n.id === e.from);
};

/** The moments a When can watch, for its source (none: the graphic's, or the channel's). */
export function momentsOf(src: LogicNode | undefined, tpl: Template): Opt[] {
  const proj = isProjectLogic(tpl);
  // The Logic of a widget (Builder): its buttons first.
  if (!src && tpl.builder)
    return [
      { value: 'control', label: 'A button is pressed' },
      { value: 'start', label: 'The graphic is taken' },
      { value: 'trigger', label: 'A trigger is received' },
      { value: 'every', label: 'Every N seconds' },
    ];
  if (!src) {
    return [
      ...(proj ? [{ value: 'start', label: 'The project is loaded' }] : [{ value: 'start', label: 'The graphic is taken' }, { value: 'continue', label: 'Continue (F2) is pressed' }]),
      { value: 'trigger', label: 'A trigger is received' },
      { value: 'every', label: 'Every N seconds' },
      ...(!proj && (tpl.datasets?.length ?? 0) > 0 ? [{ value: 'lastRow', label: 'A data set shows its last row' }] : []),
    ];
  }
  switch (src.type) {
    case 'template':
    case 'onAir':
      return [
        { value: 'in', label: 'goes on air' },
        { value: 'out', label: 'goes off air' },
      ];
    case 'playlist':
      return [
        { value: 'taken', label: 'a row is taken' },
        { value: 'end', label: 'is over' },
        { value: 'interrupted', label: 'is interrupted' },
      ];
    case 'layer': {
      const l = tpl.layers.find((x) => x.id === src.layer);
      if (!l) return [];
      return [
        ...(scrollLayer(l) ? [{ value: 'scrollEnd', label: 'has scrolled to its end' }] : []),
        ...(timerLayer(l) ? [{ value: 'timerZero', label: 'reaches zero' }, { value: 'timerAt', label: 'shows a time' }] : []),
        ...(videoLayer(l) ? [{ value: 'videoEnd', label: 'the video ends' }] : []),
      ];
    }
    case 'field': {
      const ds = (tpl.datasets ?? []).find((d) => src.key.startsWith(`${d.key}_`));
      return [{ value: 'change', label: 'changes' }, ...(ds ? [{ value: 'lastRow', label: 'is on the last row' }] : [])];
    }
    default:
      return [{ value: 'change', label: 'changes' }];
  }
}

/** The subjects an If… line can test. */
export function subjectsOf(tpl: Template): Opt[] {
  const p = useApp.getState().project;
  const graphics = (p?.templates ?? []).filter((x) => x.id !== tpl.id).map((x) => ({ value: `tpl:${x.id}`, label: x.name, group: 'Templates' }));
  if (isProjectLogic(tpl)) return [...graphics, ...(p?.playlists ?? []).filter((l) => !l.owner).map((l) => ({ value: `pl:${l.id}`, label: l.name, group: 'Playlists' }))];
  const names = [...new Set((tpl.logic?.nodes ?? []).flatMap((n) => (n.type === 'setVar' && n.name.trim() ? [n.name.trim()] : [])))];
  return [
    ...tpl.fields.map((f) => ({ value: `field:${f.key}`, label: f.label || f.key, group: 'Data' })),
    ...names.map((x) => ({ value: `var:${x}`, label: x, group: 'Variables' })),
    ...graphics,
    { value: 'in', label: 'The value wired in', group: 'Other' },
  ];
}

const STATE = (on: string, off: string): Opt[] => [
  { value: on, label: on === 'onAir' ? 'is on air' : on === 'interrupted' ? 'is interrupted' : 'is over' },
  { value: off, label: off === 'notOnAir' ? 'is not on air' : off === 'notInterrupted' ? 'is not interrupted' : 'is not over' },
];

/** The tests of an If… line, for its subject. */
export function testsOf(what: string): Opt[] {
  if (what.startsWith('tpl:')) return STATE('onAir', 'notOnAir');
  if (what.startsWith('pl:')) return [...STATE('onAir', 'notOnAir'), ...STATE('interrupted', 'notInterrupted'), ...STATE('ended', 'notEnded')];
  return [
    { value: 'gt', label: '>' },
    { value: 'ge', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'le', label: '≤' },
    { value: 'eq', label: '=' },
    { value: 'ne', label: '≠' },
    { value: 'contains', label: 'contains' },
    { value: 'empty', label: 'is empty' },
    { value: 'notEmpty', label: 'is not empty' },
    { value: 'yes', label: 'is true' },
    { value: 'no', label: 'is false' },
  ];
}

/** A test compares with a value. */
export const needsValue = (test: string) => ['gt', 'ge', 'lt', 'le', 'eq', 'ne', 'contains'].includes(test);

/** A new line for a subject. */
export const lineFor = (what: string): CheckRow => ({ what, test: testsOf(what)[what.startsWith('tpl:') || what.startsWith('pl:') ? 0 : 4].value, value: '' });

// ── Older graphs ──────────────────────────────────────────────────────────

/** The graph has moments on its source nodes, or event nodes: made over into steps by [`toSteps`]. */
export function needsSteps(logic: Logic | undefined): boolean {
  if (!logic) return false;
  const kinds = new Map(logic.nodes.map((n) => [n.id, n.type]));
  return (
    logic.nodes.some((n) => ['event', 'start', 'continue', 'triggerIn', 'every'].includes(n.type)) ||
    logic.edges.some((e) => (kinds.get(e.from) === 'template' || kinds.get(e.from) === 'playlist') && fromPortOf(e) !== 'src')
  );
}

const OPS: Record<string, string> = { '=': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', '>=': 'ge', '<=': 'le', contains: 'contains' };

/**
 * Makes an older graph over into steps, doing the same on air: a graphic's or a playlist's moments
 * (its flow outputs) become When steps on it, its states (« on air », « interrupted ») its source
 * or an If…; event nodes (keeping their id) become When steps, on the layer or field they watch.
 */
export function toSteps(logic: Logic) {
  const added: LogicNode[] = [];
  const edges: LogicEdge[] = [];
  /** A source node for a layer or a field: the one in the graph, or a new one beside `near`. */
  const source = (match: (n: LogicNode) => boolean, make: () => LogicNode): LogicNode => {
    const have = [...logic.nodes, ...added].find(match);
    if (have) return have;
    const n = make();
    added.push(n);
    return n;
  };
  const at = (n: LogicNode, dx: number, dy = 0) => ({ id: newId(), x: n.x + dx, y: n.y + dy });

  for (const n of [...logic.nodes]) {
    // A graphic or a playlist: each moment wired becomes a When.
    if (n.type === 'template' || n.type === 'playlist') {
      const moments = n.type === 'template' ? ['in', 'out'] : ['taken', 'end'];
      moments.forEach((m, i) => {
        const outs = logic.edges.filter((e) => e.from === n.id && fromPortOf(e) === m);
        if (!outs.length) return;
        const w: LogicNode = { ...at(n, 280, i * 110), type: 'when', on: m };
        added.push(w);
        edges.push({ from: n.id, fromPort: 'src', to: w.id, port: 'src' });
        for (const e of outs) {
          e.from = w.id;
          delete e.fromPort;
        }
      });
      for (const e of logic.edges) {
        if (e.from !== n.id) continue;
        const p = fromPortOf(e);
        if (p === 'onAir') e.fromPort = 'src';
        // « Interrupted » as a value: an If… on it.
        if (p === 'interrupted' && n.type === 'playlist') {
          const c: LogicNode = { ...at(n, 280, 230), type: 'check', rows: [{ what: `pl:${n.playlist}`, test: 'interrupted' }] };
          added.push(c);
          e.from = c.id;
          e.fromPort = 'out';
        }
      }
      continue;
    }
    // Event nodes: a When in their place (same id: the wires and what the server saw stay).
    const m = n as LogicNode & Record<string, unknown>;
    const become = (on: string, extra: Partial<Record<'name' | 'seconds' | 'dataset', string | number>> = {}, src?: LogicNode) => {
      for (const k of Object.keys(m)) if (!['id', 'x', 'y', 'frame', 'title'].includes(k)) delete m[k];
      Object.assign(m, { type: 'when', on, ...extra });
      delete m.title;
      if (src) edges.push({ from: src.id, fromPort: ['layer', 'template', 'playlist'].includes(src.type) ? 'src' : 'out', to: n.id, port: 'src' });
    };
    const layerSrc = (id: string) => source((x) => x.type === 'layer' && x.layer === id, () => ({ ...at(n, -280), type: 'layer', layer: id, rows: [] }));
    const fieldSrc = (key: string) => source((x) => x.type === 'field' && x.key === key, () => ({ ...at(n, -280), type: 'field', key }));
    switch (n.type) {
      case 'start':
        become('start');
        break;
      case 'continue':
        become('continue');
        break;
      case 'triggerIn':
        become('trigger', { name: n.name });
        break;
      case 'every':
        become('every', { seconds: n.seconds });
        break;
      case 'event': {
        const on = n.on;
        switch (on.kind) {
          case 'scrollEnd':
          case 'timerZero':
          case 'videoEnd':
            become(on.kind, {}, layerSrc(on.layer));
            break;
          case 'timerAt':
            become('timerAt', { seconds: on.seconds }, layerSrc(on.layer));
            break;
          case 'lastRow':
            become('lastRow', { dataset: on.dataset });
            break;
          case 'dataChange':
            become('change', {}, fieldSrc(on.key));
            break;
          case 'graphic': {
            const g = source((x) => x.type === 'template' && x.template === on.template, () => ({ ...at(n, -280), type: 'template', template: on.template }));
            become(on.out ? 'out' : 'in', {}, g);
            break;
          }
          case 'dataIs': {
            // A value meeting a condition: an If… run by nothing (it goes when it becomes true).
            for (const k of Object.keys(m)) if (!['id', 'x', 'y', 'frame'].includes(k)) delete m[k];
            Object.assign(m, { type: 'check', rows: [{ what: `field:${on.key}`, test: OPS[on.op] ?? 'eq', value: on.value }] });
            for (const e of logic.edges) if (e.from === n.id && fromPortOf(e) === 'out') e.fromPort = 'yes';
            break;
          }
        }
        break;
      }
    }
  }
  logic.nodes.push(...added);
  logic.edges.push(...edges);
  return logic;
}

/** A layer can be the source of a When (it has moments). */
export const hasMoments = (l: Layer) => scrollLayer(l) || timerLayer(l) || videoLayer(l);
