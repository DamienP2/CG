import type { Lesson } from '../../types';
import type { PlayoutItem, RundownItem } from '../../../engine/types';
import { useApp } from '../../../store';
import { onAir, project, shown } from '../../probe';

/*
 * Helpers of the Operator lessons (this file and its neighbours): the
 * person's simulation, the rundown, the rows and tabs of the page.
 */

/** The graphics on air in this person's simulations. */
export const airItems = (): PlayoutItem[] =>
  Object.entries(useApp.getState().live)
    .filter(([id]) => id.startsWith('sim~'))
    .flatMap(([, l]) => Object.values(l.state?.layers ?? {}));
/** What is on air, as a string to compare (graphics, values, widgets). */
export const airState = () => JSON.stringify(airItems().map((p) => [p.rundownId, p.data, p.widgets ?? null, p.clocks ?? null]));
/** The rundown items on air. */
export const airIds = () => airItems().map((p) => p.rundownId ?? '');
export const rundown = (): RundownItem[] => project()?.rundown ?? [];
export const itemNamed = (name: string) => rundown().find((r) => r.name === name);
export const itemById = (id: string) => rundown().find((r) => r.id === id);
/** The rundown item `name` is on air. */
export const isOnAir = (name: string) => {
  const r = itemNamed(name);
  return !!r && airIds().includes(r.id);
};
/** Held on a pause of its template (waiting for CONTINUE or a trigger). */
export const atPause = () =>
  airItems().some((p) => (p.phase === 'holding' || p.phase === 'outHold') && !!project()?.templates.find((t) => t.id === p.templateId)?.markers.some((m) => m.kind === 'pause' && Math.abs(m.frame - p.frame) < 0.5));
/** The name of the playlist open. */
export const openList = () => shown('.opx-pl.on .opx-name-cell')?.textContent?.trim() ?? '';
/** The name of the graphic selected (CUE). */
export const cued = () => shown('.opx-gr.on strong')?.textContent?.trim() ?? '';
/** The template of the graphic selected. */
export const cuedTemplate = () => shown('.opx-gr.on .opx-gr-tpl')?.textContent?.trim() ?? '';
/** The tab of the playlist `name`. */
export const listTab = (name: string) => [...document.querySelectorAll('.opx-pl')].find((el) => el.querySelector('.opx-name-cell')?.textContent?.trim() === name);
/** The row of the graphic `name` (or of its template). */
export const row = (name: string) => [...document.querySelectorAll('.opx-gr')].find((el) => el.querySelector('strong')?.textContent?.trim() === name || el.querySelector('.opx-gr-tpl')?.textContent?.trim() === name);
/** Its ▶ / ■ button. */
export const playOf = (name: string) => row(name)?.querySelector('.opx-sq');
/** Its ⋯ button. */
export const moreOf = (name: string) => row(name)?.querySelector('.opx-acts button:last-child');
/** The element of `sel` whose tooltip is `label` (a tooltip shown once moves from `title` to `data-tip`). */
export const titled = (sel: string, label: string) => shown(`${sel}[title="${label}"], ${sel}[data-tip="${label}"]`);
/** The values of the graphic selected: their tabs and fields. */
export const valuesPane = () => document.querySelectorAll('.opx > .opx-col')[1]?.querySelector(':scope > .opx-pane.grow');
/** The graphics of the playlist (a ring there leaves them free: the bubble goes beside). */
export const LIST = '.opx-col .opx-scroll';
/** NEXT, in the transport bar. */
export const NEXT = '.ux1-transport .opx-btn.big.red';

/** Values of an item, as a string, when a step began; the item. */
let was = '';
let id = '';

/** operator › start. */
export const lessons: Lesson[] = [
  {
    id: 'operator.start.first-take',
    cat: 'operator',
    chapter: 'start',
    title: { fr: 'Premier passage à l’antenne', en: 'First time on air' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Ici, tout est simulé : rien ne part à l’antenne. Cliquez un graphique de la playlist.', en: 'Here everything is simulated: nothing goes on air. Click a graphic of the playlist.' },
        at: '.opx-gr',
        done: { click: '.opx-gr' },
      },
      {
        say: { fr: 'F1 ou le bouton rouge : à l’antenne.', en: 'F1 or the red button: on air.' },
        at: '.opx-btn.big.red',
        done: () => onAir() > 0,
      },
      {
        say: { fr: 'F3 : il sort.', en: 'F3: it goes out.' },
        done: () => onAir() === 0,
      },
    ],
  },
  {
    id: 'operator.start.tour',
    cat: 'operator',
    chapter: 'start',
    title: { fr: 'Tour de l’écran Opérateur', en: 'A tour of the Operator' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'À gauche, les playlists. Cliquez l’onglet Journal.', en: 'On the left, the playlists. Click the Journal tab.' },
        at: () => listTab('Journal'),
        done: () => openList() === 'Journal',
      },
      {
        say: { fr: 'Dessous, ses graphiques. Cliquez Claire Vasseur.', en: 'Below, its graphics. Click Claire Vasseur.' },
        at: () => row('Claire Vasseur'),
        done: () => cued() === 'Claire Vasseur',
      },
      {
        say: { fr: 'Au centre, son Aperçu et ses valeurs à remplir.', en: 'In the middle, its Preview and the values to fill in.' },
        at: () => document.querySelectorAll('.opx > .opx-col')[1],
        done: 'next',
      },
      {
        say: { fr: 'À droite, l’antenne. Ici, une SIMULATION : rien ne part.', en: 'On the right, the antenna. Here a SIMULATION: nothing goes out.' },
        at: () => document.querySelectorAll('.opx > .opx-col')[2],
        done: 'next',
      },
      {
        say: { fr: 'En bas, NEXT, CONTINUE, OUT… et leurs touches F1, F2, F3.', en: 'At the bottom, NEXT, CONTINUE, OUT… and their keys F1, F2, F3.' },
        at: '.ux1-transport',
        done: 'next',
      },
    ],
  },
  {
    id: 'operator.start.output',
    cat: 'operator',
    chapter: 'start',
    title: { fr: 'Choisir la sortie', en: 'Choose the output' },
    setup: { kind: 'operator', example: 'ex-02-info-continu' },
    steps: [
      {
        say: { fr: 'Sans sortie choisie, l’Opérateur simule : rien ne part à l’antenne.', en: 'Without an output, the Operator simulates: nothing goes on air.' },
        at: '.opx-title.live',
        done: 'next',
      },
      {
        say: { fr: 'En régie, la liste Sortie, en haut, choisit le canal où partent les graphiques.', en: 'In the control room, the Output list, at the top, chooses the channel the graphics go to.' },
        done: 'next',
      },
      {
        say: { fr: 'Une sortie a parfois plusieurs images. Cliquez 9:16 pour la voir aussi.', en: 'An output may have several pictures. Click 9:16 to see it too.' },
        at: '.opx-pics',
        done: () => document.querySelectorAll('.opx-pics button.on').length >= 2,
      },
      {
        say: { fr: 'F1 : le graphique part dans les deux images.', en: 'F1: the graphic goes to both pictures.' },
        at: NEXT,
        done: () => onAir() > 0,
      },
    ],
  },
  {
    id: 'operator.start.preview',
    cat: 'operator',
    chapter: 'start',
    title: { fr: 'Aperçu et antenne', en: 'Preview and antenna' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'L’Aperçu montre le graphique choisi. Cliquez AU SOMMAIRE.', en: 'The Preview shows the chosen graphic. Click AU SOMMAIRE.' },
        at: () => row('AU SOMMAIRE'),
        done: () => cued() === 'AU SOMMAIRE',
      },
      {
        say: { fr: 'Changez un texte : seul l’Aperçu change.', en: 'Change a text: only the Preview changes.' },
        at: valuesPane,
        before: () => {
          id = itemNamed('AU SOMMAIRE')?.id ?? '';
          was = JSON.stringify(itemById(id)?.data);
        },
        done: () => !!id && JSON.stringify(itemById(id)?.data) !== was,
      },
      {
        say: { fr: 'F1 : il passe à l’antenne, à droite.', en: 'F1: it goes on air, on the right.' },
        at: NEXT,
        done: () => onAir() > 0,
      },
      {
        say: { fr: 'Changez encore un texte : l’antenne ne bouge pas, l’Aperçu si.', en: 'Change a text again: the antenna stays, the Preview changes.' },
        at: valuesPane,
        before: () => void (was = JSON.stringify(rundown().map((r) => r.data))),
        done: () => JSON.stringify(rundown().map((r) => r.data)) !== was,
      },
    ],
  },
];
