// The Logic of a widget built with the Builder (`WidgetDef.logic`): « When a button is pressed »
// starts its flows, « Widget variable » changes its variables, « Animated element » drives its Temps.
// Placed in a template (`placedLogic`), its ids go under the folder's, its buttons become triggers
// (built::control_trigger) and its variables the graphic's values: the server runs it with the
// template's on air, and the same way for the previews (/api/widgets/press).
import { elementId, startValue, varKey } from './built';
import type { CtlAction, Layer, Logic, LogicEdge, LogicFrame, LogicNode, WidgetDef } from './types';

/** The trigger a button of the widget placed as `widget` starts (mirror of built::control_trigger). */
export const controlTrigger = (widget: string, control: string) => `__w:${widget}:${control}`;

const FRAME_COLORS = ['#8fa3ff', '#a78bfa', '#22d3ee', '#f59e0b', '#f472b6', '#4ade80', '#fb7185', '#facc15'];
const NODE_GAP = 250;
const ROW_H = 250;

/** One action of a control (older widgets) as a node. */
function actionNode(a: CtlAction, id: string, x: number, y: number, frame: string): LogicNode {
  const base = { id, x, y, frame };
  switch (a.op) {
    case 'undo':
      return { ...base, type: 'wundo' };
    case 'timer':
      return { ...base, type: 'widget', layer: a.layer ?? '', control: a.value || 'toggle', ...(a.arg ? { arg: a.arg } : {}) };
    default:
      return { ...base, type: 'wvar', var: a.var ?? '', op: a.op, value: a.value ?? '' };
  }
}

/** The Logic of a widget made before it had one: each control's actions as a flow from its button, in a frame. */
export function actionsLogic(def: Pick<WidgetDef, 'controls'>): Logic {
  const nodes: LogicNode[] = [];
  const edges: LogicEdge[] = [];
  const frames: LogicFrame[] = [];
  def.controls.forEach((c, i) => {
    const y = i * ROW_H;
    const frame = `f-${c.id}`;
    const when = `when-${c.id}`;
    nodes.push({ id: when, x: 0, y, frame, type: 'when', on: 'control', name: c.id });
    let prev = when;
    c.actions.forEach((a, j) => {
      const id = `a-${c.id}-${j}`;
      nodes.push(actionNode(a, id, NODE_GAP * (j + 1), y, frame));
      edges.push(prev === when ? { from: when, to: id, port: 'run' } : { from: prev, fromPort: 'next', to: id, port: 'run' });
      prev = id;
    });
    frames.push({ id: frame, name: c.row ? `${c.row} · ${c.label}` : c.label, color: FRAME_COLORS[i % FRAME_COLORS.length], x: -30, y: y - 40, w: NODE_GAP * (c.actions.length + 1) + 20, h: ROW_H - 50 });
  });
  return { nodes, edges, frames };
}

/** The widget's Logic as the Builder edits it (older widgets: made from their controls' actions). */
export const logicOf = (def: Pick<WidgetDef, 'controls' | 'logic'>): Logic => def.logic ?? actionsLogic(def);

/** The When of a button of the widget: the node its flow starts from. */
export const isControlWhen = (n: LogicNode, control?: string): boolean => n.type === 'when' && n.on === 'control' && (control === undefined || n.name === control);

/** The nodes a button runs (after its When, following the flows). */
export function controlSteps(logic: Logic, control: string): number {
  const seen = new Set<string>();
  const todo = logic.nodes.filter((n) => isControlWhen(n, control)).map((n) => n.id);
  while (todo.length) {
    const id = todo.pop()!;
    for (const e of logic.edges) {
      if (e.from === id && !seen.has(e.to)) {
        seen.add(e.to);
        todo.push(e.to);
      }
    }
  }
  return seen.size;
}

/**
 * The Logic of the widget `def` placed as `group` in a template: node ids under the folder's, its
 * buttons as triggers, its elements and variables as the template's (data keys), the start values
 * its resets go back to. None when it does nothing.
 */
export function placedLogic(def: WidgetDef, group: Layer): Logic | undefined {
  const src = logicOf(def);
  if (!src.nodes.length) return undefined;
  const W = group.id;
  const id = (x: string) => `${W}/${x}`;
  const isVar = (name: string) => def.vars.some((v) => v.name === name);
  const key = (name: string) => (isVar(name) ? varKey(W, name) : name);
  const nodes = src.nodes.map((n0): LogicNode => {
    const n = structuredClone(n0);
    n.id = id(n.id);
    if (n.frame) n.frame = id(n.frame);
    switch (n.type) {
      case 'when':
        if (n.on === 'control') return { id: n.id, x: n.x, y: n.y, ...(n.frame ? { frame: n.frame } : {}), type: 'triggerIn', name: controlTrigger(W, n.name ?? '') };
        break;
      case 'field':
        n.key = key(n.key);
        break;
      case 'layer':
      case 'widget':
      case 'animate':
        n.layer = elementId(W, n.layer);
        break;
      case 'check':
        for (const r of n.rows) if (r.what.startsWith('field:')) r.what = `field:${key(r.what.slice(6))}`;
        break;
      case 'wvar': {
        if (n.var) {
          const v = def.vars.find((x) => x.name === n.var);
          if (v?.list?.length) n.list = v.list;
          n.start = startValue(def, group, n.var);
          n.var = key(n.var);
        } else n.all = Object.fromEntries(def.vars.map((v) => [varKey(W, v.name), startValue(def, group, v.name)]));
        n.widget = W;
        break;
      }
      case 'wundo':
        n.widget = W;
        break;
    }
    return n;
  });
  return {
    nodes,
    edges: src.edges.map((e) => ({ ...e, from: id(e.from), to: id(e.to) })),
    frames: (src.frames ?? []).map((f) => ({ ...f, id: id(f.id) })),
  };
}
