import type { Lesson } from '../../types';
import type { LogicNode, Logic } from '../../../engine/types';
import { t } from '../../../i18n';
import { designTemplates } from '../../../engine/drafts';
import { openTemplate, project, shown, template, withText } from '../../probe';
import { useLearn } from '../../store';

/*
 * Helpers shared by the Data, Logic and On-air lessons (data.ts and air.ts use them too).
 */

/** The Logic canvas is open. */
export const logicOpen = () => !!shown('.logic-editor');
/** The toolbar's Logique button (the graphic's Logic). */
export const logicButton = () => withText('.toolbar .btn', t('Logic'));
/** The Logic canvas's Close. */
export const closeButton = () => shown('.logic-editor .cv-head > .icon-btn');
/** The Logic of the open template, or of the project when its Logic is open. */
export const logic = (): Logic => template()?.logic ?? { nodes: [], edges: [] };
export const nodesOf = (type: string, l: Logic = logic()) => l.nodes.filter((n) => n.type === type);
/** A node of the canvas (its element). */
export const nodeEl = (n?: { id: string }) => (n ? shown(`[data-node-id="${n.id}"]`) : null);
/** A port of a Logic node. */
export const portEl = (n: { id: string } | undefined, port = 'out', dir: 'in' | 'out' = 'out') => (n ? shown(`.lx-port.${dir}[data-node="${n.id}"][data-port="${port}"]`) : null);
/** Wires leaving `n` (by its output port, `out` when none). */
export const wiresFrom = (n: { id: string }, port?: string, l: Logic = logic()) => l.edges.filter((e) => e.from === n.id && (!port || (e.fromPort ?? 'out') === port));
/** A node `from` feeds, of a type. */
export const fed = (from: { id: string } | undefined, type: string, port?: string, l: Logic = logic()): LogicNode | undefined =>
  from ? l.nodes.find((n) => n.type === type && wiresFrom(from, port, l).some((e) => e.to === n.id)) : undefined;

/** A dropdown: its list once open (the bubble then keeps clear of it), else its button. */
export const dd = (btn: Element | null | undefined) => shown('.dd-list') ?? btn;

/** The label of a button without its note (`<em>`). */
const own = (b: Element) => {
  const em = b.querySelector('em')?.textContent ?? '';
  const s = b.textContent ?? '';
  return (em && s.endsWith(em) ? s.slice(0, -em.length) : s).trim();
};

/** A palette entry by its label: the entry when in sight, else the search box to find it. */
export function entry(label: string, translate = true): HTMLElement | null {
  const want = translate ? t(label) : label;
  const pal = shown('.lx-pal');
  const box = pal?.getBoundingClientRect();
  for (const b of document.querySelectorAll<HTMLElement>('.lx-pal .lx-entry > button:first-child')) {
    if (b.querySelector('strong')?.textContent !== want) continue;
    const r = b.getBoundingClientRect();
    if (box && r.height && r.top >= box.top && r.bottom <= box.bottom) return b;
  }
  return shown('.lx-pal .lx-search input');
}

/** The open menu of a wire dropped in the void: its line `label`, else the menu. */
export function quickItem(label: string): HTMLElement | null {
  const want = t(label);
  const box = shown('.lx-quick .lx-qlist')?.getBoundingClientRect();
  for (const b of document.querySelectorAll<HTMLElement>('.lx-quick .lx-qlist button')) {
    const r = b.getBoundingClientRect();
    if (own(b) === want && box && r.height && r.top >= box.top - 1 && r.bottom <= box.bottom + 1) return b;
  }
  return shown('.lx-quick input') ?? shown('.lx-quick');
}
/** Where a « drag this dot into the void, choose X » step points: the menu once open, else the dot. */
export const dragTo = (dot: () => Element | null | undefined, label: string) => () => (shown('.lx-quick') ? quickItem(label) : dot());

/** The template the lesson needs (the `n`-th of the example), opened once the project is there. */
export function openWhenReady(n: number) {
  return () => {
    let stable = 0;
    let tries = 0;
    const go = () => {
      const p = project();
      const want = p && p.id === useLearn.getState().project ? designTemplates(p)[n] : undefined;
      if (want) {
        if (template()?.id === want.id) stable++;
        else {
          stable = 0;
          openTemplate(n);
        }
      }
      if (stable < 5 && tries++ < 100) setTimeout(go, 200);
    };
    go();
  };
}

/** The `n`-th template of the project. */
export const templateAt = (n: number) => {
  const p = project();
  return p ? designTemplates(p)[n] : undefined;
};

/** The first node of a type. */
const first = (type: string, test: (n: LogicNode) => boolean = () => true, l?: Logic) => nodesOf(type, l).find(test);
const when = (on?: string) => first('when', (n) => (on === undefined ? true : (n as { on?: string }).on === on));

/** The project's Logic (the stand-in template while its canvas is open, else the project's). */
const projectLogic = (): Logic => project()?.logic ?? { nodes: [], edges: [] };

/** The Wait's seconds when the preset was inserted. */
let waitWas = 0;

/** designer › logic. */
export const lessons: Lesson[] = [
  {
    id: 'designer.logic.when-then',
    cat: 'designer',
    chapter: 'logic',
    title: { fr: 'Quand… alors…', en: 'When… then…' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Ouvrez Logique : les règles du modèle.', en: 'Open Logic: the rules of the template.' },
        at: logicButton,
        done: logicOpen,
      },
      {
        say: { fr: 'Cliquez Quand… (ou cherchez « quand »).', en: 'Click When… (or search “when”).' },
        at: () => entry('When…'),
        done: () => !!when(),
      },
      {
        say: { fr: 'Choisissez le moment : Continuer (F2) est appuyé.', en: 'Choose the moment: Continue (F2) is pressed.' },
        at: () => dd(nodeEl(when())?.querySelector('.dd-btn')),
        done: () => !!when('continue'),
      },
      {
        say: { fr: 'Tirez le point Puis dans le vide, tapez « sortir », cliquez Sortir (OUT).', en: 'Drag the Then dot into the void, type “out”, click Take out (OUT).' },
        at: dragTo(() => portEl(when()), 'Take out (OUT)'),
        done: () => !!fed(when(), 'out'),
      },
      {
        say: { fr: 'Fermez. À l’antenne, F2 fera sortir le graphique.', en: 'Close. On air, F2 will take the graphic out.' },
        at: closeButton,
        done: () => !logicOpen(),
      },
    ],
  },
  {
    id: 'designer.logic.if-else',
    cat: 'designer',
    chapter: 'logic',
    title: { fr: 'Si… sinon', en: 'If… else' },
    setup: { kind: 'designer', example: 'ex-17-basket' },
    steps: [
      {
        say: { fr: 'La fiche joueur est ouverte. Ouvrez Logique.', en: 'The player card is open. Open Logic.' },
        before: openWhenReady(1),
        at: logicButton,
        done: logicOpen,
      },
      {
        say: { fr: 'Cliquez À la prise (cherchez « prise »).', en: 'Click When taken (search “taken”).' },
        at: () => entry('When taken'),
        done: () => !!when('start'),
      },
      {
        say: { fr: 'Tirez son point Puis dans le vide, tapez « si », cliquez Si….', en: 'Drag its Then dot into the void, type “if”, click If….' },
        at: dragTo(() => portEl(when('start')), 'If…'),
        done: () => !!fed(when('start'), 'check'),
      },
      {
        say: { fr: 'Cliquez + condition, puis : Points > 20.', en: 'Click + condition, then: Points > 20.' },
        at: () => {
          const n = nodeEl(fed(when('start'), 'check'));
          return n?.querySelector('.lx-phrase') ?? n?.querySelector('.lx-add') ?? n;
        },
        done: () => !!nodesOf('check').some((n) => (n as { rows: { value?: string }[] }).rows.some((r) => (r.value ?? '').trim())),
      },
      {
        say: { fr: 'Sinon : tirez Faux dans le vide, tapez « sortir », cliquez Sortir (OUT).', en: 'Else: drag False into the void, type “out”, click Take out (OUT).' },
        at: dragTo(() => portEl(first('check'), 'no'), 'Take out (OUT)'),
        done: () => nodesOf('check').some((c) => !!fed(c, 'out', 'no')),
      },
    ],
  },
  {
    id: 'designer.logic.triggers',
    cat: 'designer',
    chapter: 'logic',
    title: { fr: 'Déclencheurs', en: 'Triggers' },
    setup: { kind: 'designer', example: 'ex-16-quiz-tv' },
    steps: [
      {
        say: { fr: 'Le chrono est ouvert. Ouvrez Logique.', en: 'The timer is open. Open Logic.' },
        before: openWhenReady(1),
        at: logicButton,
        done: logicOpen,
      },
      {
        say: { fr: 'Cliquez Déclencheur reçu (cherchez « déclencheur »).', en: 'Click Trigger received (search “trigger”).' },
        at: () => entry('Trigger received'),
        done: () => !!when('trigger'),
      },
      {
        say: { fr: 'Donnez-lui un nom : top.', en: 'Give it a name: top.' },
        at: () => nodeEl(when('trigger'))?.querySelector('input'),
        done: () => !!((when('trigger') as { name?: string } | undefined)?.name ?? '').trim(),
      },
      {
        say: { fr: 'Tirez Puis dans le vide, tapez « widget », cliquez Commande d’un widget.', en: 'Drag Then into the void, type “widget”, click Widget control.' },
        at: dragTo(() => portEl(when('trigger')), 'Widget control'),
        done: () => !!fed(when('trigger'), 'widget'),
      },
      {
        say: { fr: 'C’est fait : le bouton « top » de l’Opérateur, ou l’API, lance le chrono.', en: 'Done: the Operator’s “top” button, or the API, starts the timer.' },
        at: () => nodeEl(fed(when('trigger'), 'widget')),
        done: 'next',
      },
    ],
  },
  {
    id: 'designer.logic.project',
    cat: 'designer',
    chapter: 'logic',
    title: { fr: 'Logique du projet', en: 'Project Logic' },
    setup: { kind: 'designer', example: 'ex-17-basket' },
    steps: [
      {
        say: { fr: 'Cliquez Logique · projet : des règles entre les modèles.', en: 'Click Logic · project: rules between the templates.' },
        at: '.pjp-logic',
        done: () => logicOpen() && !shown('.lx-view'),
      },
      {
        say: { fr: 'Cliquez le modèle Tableau de score.', en: 'Click the template Tableau de score.' },
        at: () => entry(templateAt(0)?.name ?? '', false),
        done: () => nodesOf('template', projectLogic()).some((n) => (n as { template: string }).template === templateAt(0)?.id),
      },
      {
        say: { fr: 'Tirez son point dans le vide, tapez « quand », cliquez Quand….', en: 'Drag its dot into the void, type “when”, click When….' },
        at: dragTo(() => portEl(nodesOf('template', projectLogic())[0], 'src'), 'When…'),
        done: () => projectLogic().edges.some((e) => e.port === 'src' && nodesOf('when', projectLogic()).some((w) => w.id === e.to)),
      },
      {
        say: { fr: 'Tirez Puis dans le vide, tapez « sortir » : Sortir un graphique, puis Fiche joueur.', en: 'Drag Then into the void, type “out”: Take a graphic out, then Fiche joueur.' },
        at: () => {
          const pl = projectLogic();
          const w = nodesOf('when', pl).find((n) => (n as { on?: string }).on === 'in');
          const take = fed(w, 'take', undefined, pl);
          return take ? dd(nodeEl(take)?.querySelector('.dd-btn')) : dragTo(() => portEl(w), 'Take a graphic out')();
        },
        done: () => {
          const pl = projectLogic();
          return nodesOf('when', pl).some((w) => {
            const take = fed(w, 'take', undefined, pl) as { template?: string; out?: boolean } | undefined;
            return !!take?.out && !!take.template;
          });
        },
      },
      {
        say: { fr: 'Voilà : quand le score entre à l’antenne, la fiche joueur sort.', en: 'There: when the score goes on air, the player card goes out.' },
        at: () => nodeEl(nodesOf('take', projectLogic())[0]),
        done: 'next',
      },
    ],
  },
  {
    id: 'designer.logic.presets',
    cat: 'designer',
    chapter: 'logic',
    title: { fr: 'Préréglages de Logique', en: 'Logic presets' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Ouvrez Logique.', en: 'Open Logic.' },
        at: logicButton,
        done: logicOpen,
      },
      {
        say: { fr: 'Cliquez Préréglages : des règles toutes faites.', en: 'Click Presets: ready-made rules.' },
        at: () => withText('.logic-editor .lx-tool', t('Presets')),
        done: () => !!shown('.lx-presets'),
      },
      {
        say: { fr: 'Cliquez « Sortie automatique après N s ».', en: 'Click “Take out after N seconds”.' },
        at: () => withText('.lx-presets .lx-pcard', t('Take out after N seconds')),
        done: () => {
          const w = first('wait') as { seconds: number } | undefined;
          if (w) waitWas = w.seconds;
          return !!w && nodesOf('out').length > 0;
        },
      },
      {
        say: { fr: 'Attendre : mettez 5 s. Le graphique sortira seul.', en: 'Wait: set 5 s. The graphic will go out by itself.' },
        at: () => nodeEl(first('wait'))?.querySelector('input'),
        done: () => nodesOf('wait').some((w) => (w as { seconds: number }).seconds !== waitWas),
      },
      {
        say: { fr: 'Fermez Logique.', en: 'Close Logic.' },
        at: closeButton,
        done: () => !logicOpen(),
      },
    ],
  },
];
