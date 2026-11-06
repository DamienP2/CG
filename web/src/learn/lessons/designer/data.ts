import type { Lesson } from '../../types';
import { rowKey, type DataFlow, type FlowNode, type Layer } from '../../../engine/types';
import { designer, hasLayer, layers, shown, template, withText } from '../../probe';
import { closeButton, dd, dragTo, logic, logicButton, logicOpen, nodeEl, nodesOf, openWhenReady, portEl } from './logic';

/*
 * The Data canvas (the Données part of the Logic): variables, a source (one the
 * example brings: Le Grand Défi · scores, from ex-16-quiz-tv), the steps on the
 * way, data sets, and a Calculation.
 */

/** The example and its template « Vainqueur » (6th), « Fiche joueur » of ex-17 (2nd). */
const QUIZ = 'ex-16-quiz-tv';
const WINNER = 5;
const SOURCE = 'grand-defi-scores';
const SOURCE_NAME = 'Le Grand Défi · scores';

const flow = (): DataFlow => template()?.dataflow ?? { nodes: [], edges: [] };
const flowOf = <T extends FlowNode['type']>(type: T) => flow().nodes.filter((n) => n.type === type) as (FlowNode & { type: T })[];
/** The source node of the lesson (with its rows: `players`). */
const source = (list?: string) => flowOf('source').find((n) => n.source === SOURCE && (list === undefined || n.list === list));
/** The flow node feeding `id`. */
const from = (id: string) => flow().edges.find((e) => e.to === id)?.from;
/** A variable fed by the data (its key). */
const fedField = () => flow().edges.find((e) => e.to.startsWith('field:'))?.to.slice(6);
/** The nodes from `id` back to the source, the source last. */
const chainTo = (id: string): FlowNode[] => {
  const out: FlowNode[] = [];
  for (let at: string | undefined = id, k = 0; at && k < 20; at = from(at), k++) {
    const n = flow().nodes.find((x) => x.id === at);
    if (n) out.push(n);
  }
  return out;
};
/** The steps between the source and a variable fed by it. */
const stepsToField = () => {
  const key = fedField();
  return key ? chainTo(`field:${key}`) : [];
};
/** A text layer shows `{{key}}` (a key starting so). */
const shows = (key: string, l: Layer[] = layers()) => l.some((x) => typeof (x as { text?: unknown }).text === 'string' && (x as { text: string }).text.includes(`{{${key}`));

/** The palette's element when in sight, else the palette (to scroll to it). */
function inPalette(sel: string | Element | null): Element | null {
  const pal = shown('.lx-pal');
  const el = typeof sel === 'string' ? shown(sel) : sel;
  if (!pal || !el) return el ?? pal;
  const a = pal.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.top >= a.top && r.bottom <= a.bottom ? el : pal;
}
const sourceButton = () => inPalette(withText('.lx-datapal .kind-source', SOURCE_NAME));
/** A data node (flow node or variable). */
const dcNode = (id?: string) => (id ? shown(`.dc-node[data-node-id="${id}"]`) : null);
const outDot = (id?: string) => dcNode(id)?.querySelector('.ln-head .port.out') ?? null;
/** The Nom layer of « Vainqueur ». */
const nameLayer = () => layers().find((l) => l.type === 'text' && /nom|name/i.test(l.name));
/** Its node on the canvas (a Layer node of the Logic). */
const layerNode = (l?: Layer) => (l ? nodeEl(logic().nodes.find((n) => n.type === 'layer' && (n as { layer: string }).layer === l.id)) : null);
const textDot = (l?: Layer) => layerNode(l)?.querySelector('.lx-port.in') ?? null;

const first: Lesson['steps'][number] = {
  say: { fr: 'Le modèle Vainqueur est ouvert. Ouvrez Logique.', en: 'The template Vainqueur is open. Open Logic.' },
  before: openWhenReady(WINNER),
  at: logicButton,
  done: logicOpen,
};
const pickSource: Lesson['steps'][number] = {
  say: { fr: 'Cliquez la source Le Grand Défi · scores, puis Lignes : players.', en: 'Click the source Le Grand Défi · scores, then Rows: players.' },
  at: () => (source() ? dd(dcNode(source()!.id)?.querySelector('.dd-btn')) : sourceButton()),
  done: () => !!source('players'),
};
const toVariable: Lesson['steps'][number] = {
  say: { fr: 'Tirez son point dans le vide : une variable reçoit les lignes.', en: 'Drag its dot into the void: a variable gets the rows.' },
  at: () => outDot(source('players')?.id),
  done: () => !!fedField(),
};

/** designer › data. */
export const lessons: Lesson[] = [
  {
    id: 'designer.data.variables',
    cat: 'designer',
    chapter: 'data',
    title: { fr: 'Variables à remplir', en: 'Variables to fill in' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Ajoutez un texte : cliquez T.', en: 'Add a text: click T.' },
        at: () => shown('.tl-insert .tool:has(.lucide-type)'),
        done: () => hasLayer('text'),
      },
      {
        say: { fr: 'Ouvrez Logique.', en: 'Open Logic.' },
        at: logicButton,
        done: logicOpen,
      },
      {
        say: { fr: 'Cliquez Variable : une valeur que l’Opérateur remplit.', en: 'Click Variable: a value the Operator fills in.' },
        at: '.lx-datapal .kind-field',
        done: () => (template()?.fields.length ?? 0) > 0,
      },
      {
        say: { fr: 'Tapez sa valeur par défaut : Bonjour.', en: 'Type its default value: Hello.' },
        at: () => shown('.dc-node.kind-field .ln-body input, .dc-node.kind-field .ln-body textarea'),
        done: () => !!template()?.fields.some((f) => (f.default ?? '').trim()),
      },
      {
        say: { fr: 'Tirez son point droit dans le vide et cliquez le calque Texte.', en: 'Drag its right dot into the void and click the layer Text.' },
        at: () => (shown('.lx-quick') ? shown('.lx-quick .lx-qlist .fam-layer') : shown('.dc-node.kind-field .ln-head .port.out')),
        done: () => !!template()?.fields.some((f) => shows(f.key)),
      },
    ],
  },
  {
    id: 'designer.data.source',
    cat: 'designer',
    chapter: 'data',
    title: { fr: 'Relier une source', en: 'Link a source' },
    setup: { kind: 'designer', example: QUIZ },
    steps: [
      first,
      {
        say: { fr: 'Cliquez la source Le Grand Défi · scores.', en: 'Click the source Le Grand Défi · scores.' },
        at: sourceButton,
        done: () => !!source(),
      },
      {
        say: { fr: 'Lignes : choisissez players.', en: 'Rows: choose players.' },
        at: () => dd(dcNode(source()?.id)?.querySelector('.dd-btn')),
        done: () => !!source('players'),
      },
      toVariable,
      {
        say: { fr: 'Tirez le point droit de la variable sur Texte du calque Nom.', en: 'Drag the variable’s right dot onto Text of the layer Nom.' },
        at: () => {
          const key = fedField();
          const dot = key ? shown(`.dc-node[data-node-id="f:${key}"] .ln-head .port.out`) : null;
          return document.querySelector('.wire.live') ? textDot(nameLayer()) : dot;
        },
        done: () => {
          const key = fedField();
          return !!key && shows(key);
        },
      },
    ],
  },
  {
    id: 'designer.data.filter-sort',
    cat: 'designer',
    chapter: 'data',
    title: { fr: 'Filtrer et trier', en: 'Filter and sort' },
    setup: { kind: 'designer', example: QUIZ },
    steps: [
      first,
      pickSource,
      toVariable,
      {
        say: { fr: 'Glissez Trier (palette, En chemin) sur ce fil. + Colonne : score, Plus petit d’abord.', en: 'Drag Sort (palette, On the way) onto this wire. + Column: score, Smallest first.' },
        at: () => {
          const s = stepsToField().find((n) => n.type === 'sort');
          return s ? dd(dcNode(s.id)) : inPalette('.lx-datapal .kind-sort');
        },
        done: () => stepsToField().some((n) => n.type === 'sort' && n.keys.some((k) => k.column === 'score' && !k.descending)),
      },
      {
        say: { fr: 'Glissez Filtrer sur le fil. + Condition : score > 200.', en: 'Drag Filter onto the wire. + Condition: score > 200.' },
        at: () => {
          const f = stepsToField().find((n) => n.type === 'filter');
          return f ? dd(dcNode(f.id)) : inPalette('.lx-datapal .kind-filter');
        },
        done: () => stepsToField().some((n) => n.type === 'filter' && n.where.some((w) => w.column === 'score' && (w.op === 'gt' || w.op === 'ge') && String(w.value ?? '').trim() !== '')),
      },
    ],
  },
  {
    id: 'designer.data.datasets',
    cat: 'designer',
    chapter: 'data',
    title: { fr: 'Jeux de données', en: 'Data sets' },
    setup: { kind: 'designer', example: QUIZ },
    steps: [
      first,
      pickSource,
      {
        say: { fr: 'Cliquez Jeu de données (Vers le graphique), puis tirez la source sur son point gauche.', en: 'Click Data set (Into the graphic), then drag the source onto its left dot.' },
        at: () => {
          const ds = flowOf('dataset')[0];
          return ds ? (document.querySelector('.wire.live') ? dcNode(ds.id)?.querySelector('.port.in') : outDot(source('players')?.id)) : inPalette('.lx-datapal .kind-dataset');
        },
        done: () => flowOf('dataset').some((d) => from(d.id) === source('players')?.id),
      },
      {
        say: { fr: 'Tirez la colonne name sur Texte du calque Nom.', en: 'Drag the column name onto Text of the layer Nom.' },
        at: () => {
          const ds = flowOf('dataset')[0];
          if (document.querySelector('.wire.live')) return textDot(nameLayer());
          return ds ? withText(`.dc-node[data-node-id="${ds.id}"] .ds-col`, /^.*name/) : null;
        },
        done: () => flowOf('dataset').some((d) => shows(`${d.key}_`)),
      },
      {
        say: { fr: '→ : ligne suivante. À l’antenne, l’Opérateur passe d’une ligne à l’autre.', en: '→: next row. On air, the Operator goes from row to row.' },
        at: () => {
          const ds = flowOf('dataset')[0];
          return ds ? shown(`.dc-node[data-node-id="${ds.id}"] .ds-cursor .icon-btn:last-child`) : null;
        },
        done: () => flowOf('dataset').some((d) => +(designer().previewData[rowKey(d.key)] ?? 1) > 1),
      },
    ],
  },
  {
    id: 'designer.data.calc',
    cat: 'designer',
    chapter: 'data',
    title: { fr: 'Calculs', en: 'Calculations' },
    setup: { kind: 'designer', example: 'ex-17-basket' },
    steps: [
      {
        say: { fr: 'La fiche joueur est ouverte. Ouvrez Logique.', en: 'The player card is open. Open Logic.' },
        before: openWhenReady(1),
        at: logicButton,
        done: logicOpen,
      },
      {
        say: { fr: 'Tirez le point droit de Points dans le vide, tapez « calcul », cliquez Calcul.', en: 'Drag the right dot of Points into the void, type “calc”, click Calculation.' },
        at: dragTo(() => shown('.dc-node[data-node-id="f:pts"] .ln-head .port.out'), 'Calculation'),
        done: () => nodesOf('expr').some((n) => logic().edges.some((e) => e.to === n.id && e.port === 'a')),
      },
      {
        say: { fr: 'Tirez le point de Rebonds sur l’entrée b : a + b.', en: 'Drag the dot of Rebounds onto input b: a + b.' },
        at: () => (document.querySelector('.wire.live') ? portEl(nodesOf('expr')[0], 'b', 'in') : shown('.dc-node[data-node-id="f:reb"] .ln-head .port.out')),
        done: () => nodesOf('expr').some((n) => logic().edges.some((e) => e.to === n.id && e.port === 'b')),
      },
      {
        say: { fr: 'Tirez Résultat sur le point Texte du calque Infos.', en: 'Drag Result onto the Text dot of the layer Infos.' },
        at: () => (document.querySelector('.wire.live') ? textDot(layers().find((l) => l.name === 'Infos')) : portEl(nodesOf('expr')[0])),
        done: () => nodesOf('expr').some((n) => shows(`calc_${n.id}`)),
      },
      {
        say: { fr: 'Infos montre Points + Rebonds, à jour avec les données. Fermez.', en: 'Infos shows Points + Rebounds, up to date with the data. Close.' },
        at: closeButton,
        done: () => !logicOpen(),
      },
    ],
  },
];
