// The pre-built widgets: definitions made with the Builder's own pieces (shapes, texts, counters,
// Temps, a Repeater), copied into a project when added to a template, then edited as any widget.
import { t } from '../i18n';
import type { BuiltControl, Layer, LayerType, WidgetDef } from '../engine/types';
import { WIDGET_LIST } from '.';

const hex = (h: string, a = 1): [number, number, number, number] => {
  const p = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [p(1), p(3), p(5), a];
};

/** An element of a widget: the widget's own defaults (`made` by its module), then ours. */
function el(module: string, type: LayerType, id: string, name: string, parent: string | null, props: Record<string, unknown>, extra: Record<string, unknown> = {}): Layer {
  const made = (WIDGET_LIST.find((w) => w.id === module)?.create() ?? {}) as { props?: Record<string, unknown> };
  const { props: own = {}, ...rest } = made;
  return { id, name, type, parent, visible: true, locked: false, tracks: {}, bindings: {}, ...rest, ...extra, props: { ...own, ...props } } as unknown as Layer;
}

/** The scoreboard: two teams (colour, name, score, fouls), the period, the clock and the shot clock. */
function scoreboard(): WidgetDef {
  const font = { fontFamily: 'Barlow Condensed' };
  const layers: Layer[] = [el('quad', 'rect', 'fond', t('Background'), null, { x: 0, y: 0, width: 1240, height: 100, fill: hex('#0a0a0e', 0.96) })];
  const teams: [number, string, string, string][] = [
    [0, '#1b2f73', '#ff6a13', 'PARIS'],
    [450, '#c8102e', '#ffffff', 'MONACO'],
  ];
  teams.forEach(([x, c, accent, name], i) => {
    const n = i + 1;
    const g = `eq${n}`;
    layers.push(
      el('group', 'group', g, t('Team {n}', { n }), null, { x, y: 0, width: 450, height: 100 }, { clip: false }),
      el('quad', 'rect', `couleur${n}`, t('Colour {n}', { n }), g, { x: 0, y: 0, width: 450, height: 100, fill: hex(c) }),
      el('quad', 'rect', `liseré${n}`, t('Accent {n}', { n }), g, { x: 0, y: 94, width: 450, height: 6, fill: hex(accent) }),
      el('text', 'text', `nom${n}`, t('Name {n}', { n }), g, { x: 28, y: 6, width: 280, height: 76, fontSize: 56, fill: hex('#ffffff') }, { text: name, ...font, fontWeight: 800, align: 'left', verticalAlign: 'middle' }),
      el('counter', 'counter', `score${n}`, t('Score {n}', { n }), g, { x: 300, y: 4, width: 124, height: 80, fontSize: 70, fill: hex('#ffffff') }, { to: `{{score_${n}}}`, from: '0', ...font, fontWeight: 800, align: 'right', grouping: false, transition: 'roll' }),
      el('group', 'group', `fautes${n}`, t('Fouls {n}', { n }), g, { x: 30, y: 80, width: 90, height: 10 }, { clip: false, repeat: { count: 5, lit: `fautes_${n}`, layout: 'row', gap: 7, off: 0.22 } }),
      el('ellipse', 'ellipse', `pastille${n}`, t('Pip'), `fautes${n}`, { x: 0, y: 0, width: 10, height: 10, fill: hex(accent), strokeWidth: 0 }),
    );
  });
  layers.push(
    el('text', 'text', 'periode', t('Period'), null, { x: 905, y: 10, width: 80, height: 80, fontSize: 46, fill: hex('#ff6a13') }, { text: '{{periode}}', ...font, fontWeight: 700, align: 'center', verticalAlign: 'middle' }),
    el('time', 'clock', 'chrono', t('Game clock'), null, { x: 985, y: 0, width: 160, height: 100, fontSize: 64, fill: hex('#ffffff') }, { ...font, fontWeight: 700, format: 'mm:ss', timerMode: 'countdown', cdDuration: 600000, manualStart: true }),
    el('time', 'clock', 'tirs', t('Shot clock'), null, { x: 1150, y: 10, width: 80, height: 80, fontSize: 48, fill: hex('#ffd200') }, { ...font, fontWeight: 700, format: 'ss', timerMode: 'countdown', cdDuration: 24000, manualStart: true }),
  );
  const team = (n: number, row: string): BuiltControl[] => [
    { id: `moins${n}`, label: '−1', place: 'row', row, actions: [{ op: 'add', var: `score_${n}`, value: '-1' }] },
    { id: `p3_${n}`, label: '+3', place: 'row', row, key: n === 1 ? 'Q' : 'M', actions: [{ op: 'add', var: `score_${n}`, value: '3' }] },
    { id: `p2_${n}`, label: '+2', place: 'row', row, actions: [{ op: 'add', var: `score_${n}`, value: '2' }] },
    { id: `p1_${n}`, label: '+1', place: 'row', row, actions: [{ op: 'add', var: `score_${n}`, value: '1' }] },
  ];
  return {
    id: 'scoreboard',
    name: t('Scoreboard'),
    icon: 'trophy',
    width: 1240,
    height: 100,
    layers,
    vars: [
      { name: 'score_1', kind: 'number', initial: '0' },
      { name: 'score_2', kind: 'number', initial: '0' },
      { name: 'fautes_1', kind: 'number', initial: '0' },
      { name: 'fautes_2', kind: 'number', initial: '0' },
      { name: 'periode', kind: 'list', initial: 'Q1', list: ['Q1', 'Q2', 'Q3', 'Q4', 'Prol.'] },
    ],
    options: [
      { id: 'nom1', name: t('Name'), group: t('Team {n}', { n: 1 }), kind: 'text', default: 'PARIS', targets: [{ layer: 'nom1', path: 'text' }] },
      { id: 'couleur1', name: t('Colour'), group: t('Team {n}', { n: 1 }), kind: 'color', default: '#1b2f73', targets: [{ layer: 'couleur1', path: 'props.fill' }] },
      { id: 'liseré1', name: t('Accent'), group: t('Team {n}', { n: 1 }), kind: 'color', default: '#ff6a13', targets: [{ layer: 'liseré1', path: 'props.fill' }, { layer: 'pastille1', path: 'props.fill' }] },
      { id: 'nom2', name: t('Name'), group: t('Team {n}', { n: 2 }), kind: 'text', default: 'MONACO', targets: [{ layer: 'nom2', path: 'text' }] },
      { id: 'couleur2', name: t('Colour'), group: t('Team {n}', { n: 2 }), kind: 'color', default: '#c8102e', targets: [{ layer: 'couleur2', path: 'props.fill' }] },
      { id: 'liseré2', name: t('Accent'), group: t('Team {n}', { n: 2 }), kind: 'color', default: '#ffffff', targets: [{ layer: 'liseré2', path: 'props.fill' }, { layer: 'pastille2', path: 'props.fill' }] },
      {
        id: 'police',
        name: t('Font'),
        group: t('Style'),
        kind: 'font',
        default: 'Barlow Condensed',
        targets: ['nom1', 'nom2', 'score1', 'score2', 'periode', 'chrono', 'tirs'].map((layer) => ({ layer, path: 'fontFamily' })),
      },
      { id: 'fond', name: t('Background'), group: t('Style'), kind: 'color', default: '#0a0a0e', targets: [{ layer: 'fond', path: 'props.fill' }] },
    ],
    controls: [
      { id: 'lire', label: t('Play / Pause'), icon: 'play', key: 'P', main: true, actions: [{ op: 'timer', layer: 'chrono', value: 'toggle' }] },
      { id: 'annuler', label: t('Undo'), icon: 'undo', key: 'Z', actions: [{ op: 'undo' }] },
      { id: 'precedente', label: t('Previous period'), icon: 'prev', actions: [{ op: 'prev', var: 'periode' }] },
      { id: 'suivante', label: t('Next period'), icon: 'next', actions: [{ op: 'next', var: 'periode' }, { op: 'reset', var: 'fautes_1' }, { op: 'reset', var: 'fautes_2' }, { op: 'timer', layer: 'chrono', value: 'reset' }] },
      { id: 'zero', label: t('Reset the match'), icon: 'reset', tone: 'red', confirm: true, actions: [{ op: 'reset' }, { op: 'timer', layer: 'chrono', value: 'reset' }, { op: 'timer', layer: 'tirs', value: 'reset' }] },
      ...team(1, 'PAR'),
      ...team(2, 'MON'),
      { id: 'chrono', label: t('Game clock'), kind: 'field', place: 'settings', row: t('Game clock'), choose: true, actions: [{ op: 'timer', layer: 'chrono', value: 'set', arg: '$value' }] },
      { id: 'faute1', label: 'PAR', place: 'settings', row: t('Fouls'), choose: true, actions: [{ op: 'add', var: 'fautes_1', value: '1' }] },
      { id: 'faute2', label: 'MON', place: 'settings', row: t('Fouls'), choose: true, actions: [{ op: 'add', var: 'fautes_2', value: '1' }] },
      { id: 'tirs24', label: '24', place: 'settings', row: t('Shot clock'), choose: true, actions: [{ op: 'timer', layer: 'tirs', value: 'restart' }] },
      { id: 'tirs14', label: '14', place: 'settings', row: t('Shot clock'), choose: true, actions: [{ op: 'timer', layer: 'tirs', value: 'set', arg: '0:14' }, { op: 'timer', layer: 'tirs', value: 'start' }] },
    ],
  };
}

/** The pre-built widgets, by id: a fresh copy each time (its texts in the interface's language). */
export const PREBUILT: { id: string; make: () => WidgetDef }[] = [{ id: 'scoreboard', make: scoreboard }];
