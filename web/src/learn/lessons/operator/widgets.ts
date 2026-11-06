import type { Lesson } from '../../types';
import { onAir, shown } from '../../probe';
import { airItems, atPause, cued, cuedTemplate, isOnAir, itemById, itemNamed, LIST, listTab, NEXT, openList, playOf, row, valuesPane } from './start';

/** What was on air, or an item's values, when a step began; the item. */
let was = '';
let id = '';

/** The widgets of the graphics on air (started, paused…), as a string. */
const widgetState = () => JSON.stringify(airItems().map((p) => [p.widgets ?? null, p.clocks ?? null]));

/** operator › widgets. */
export const lessons: Lesson[] = [
  {
    id: 'operator.widgets.clock-score',
    cat: 'operator',
    chapter: 'widgets',
    title: { fr: 'Chrono et score', en: 'Timer and score' },
    setup: { kind: 'operator', example: 'ex-03-football' },
    steps: [
      {
        say: { fr: 'Ouvrez la playlist Match.', en: 'Open the Match playlist.' },
        at: () => listTab('Match'),
        done: () => openList() === 'Match',
      },
      {
        say: { fr: 'Le ▶ de PFC : le score et le chrono à l’antenne.', en: 'The ▶ of PFC: the score and the timer on air.' },
        at: () => playOf('PFC'),
        done: () => isOnAir('PFC'),
      },
      {
        say: { fr: 'Le chrono attend : cliquez LIRE.', en: 'The timer waits: click PLAY.' },
        at: '.opx-aircard .opx-widget',
        before: () => void (was = widgetState()),
        done: () => widgetState() !== was,
      },
      {
        say: { fr: 'Onglet Score : Score domicile à 2.', en: 'Score tab: Score domicile to 2.' },
        at: valuesPane,
        done: () => !!shown('.opx-upd.ready'),
      },
      {
        say: { fr: 'F4 : le score change à l’antenne, le chrono continue.', en: 'F4: the score changes on air, the timer goes on.' },
        at: '.opx-upd',
        before: () => void (was = JSON.stringify(airItems().map((p) => p.data))),
        done: () => JSON.stringify(airItems().map((p) => p.data)) !== was,
      },
    ],
  },
  {
    id: 'operator.widgets.ticker',
    cat: 'operator',
    chapter: 'widgets',
    title: { fr: 'Défilant et générique', en: 'Ticker and credits' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Ouvrez la playlist Journal.', en: 'Open the Journal playlist.' },
        at: () => listTab('Journal'),
        done: () => openList() === 'Journal',
      },
      {
        say: { fr: 'Cliquez la dernière ligne, le Ticker.', en: 'Click the last row, the Ticker.' },
        at: () => row('Ticker'),
        done: () => cuedTemplate() === 'Ticker',
      },
      {
        say: { fr: 'Onglet Défilant : une ligne, une info. Ajoutez-en une.', en: 'Défilant tab: one line, one item. Add one.' },
        at: valuesPane,
        before: () => {
          id = itemNamed(cued())?.id ?? '';
          was = itemById(id)?.data.items ?? '';
        },
        done: () => !!id && (itemById(id)?.data.items ?? '').split('\n').filter((l) => l.trim()).length > was.split('\n').filter((l) => l.trim()).length,
      },
      {
        say: { fr: 'F1 : le bandeau défile.', en: 'F1: the ticker scrolls.' },
        at: NEXT,
        done: () => onAir() > 0,
      },
      {
        say: { fr: 'PAUSE l’arrête. Un générique se pilote pareil.', en: 'PAUSE stops it. Credits work the same way.' },
        at: '.opx-aircard .opx-widget',
        before: () => void (was = widgetState()),
        done: () => widgetState() !== was,
      },
    ],
  },
  {
    id: 'operator.widgets.tiles',
    cat: 'operator',
    chapter: 'widgets',
    title: { fr: 'Tuiles à l’antenne', en: 'Tiles on air' },
    setup: { kind: 'operator', example: 'ex-03-football' },
    steps: [
      {
        say: { fr: 'Ouvrez la playlist Match.', en: 'Open the Match playlist.' },
        at: () => listTab('Match'),
        done: () => openList() === 'Match',
      },
      {
        say: { fr: 'Envoyez PFC et Ilan Kebbal avec leur ▶.', en: 'Take PFC and Ilan Kebbal with their ▶.' },
        at: LIST,
        done: () => onAir() >= 2,
      },
      {
        say: { fr: 'Une carte par graphique : OUT, CONTINUE et ses widgets.', en: 'A card per graphic: OUT, CONTINUE and its widgets.' },
        at: '.opx-airlist',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez la tuile du chrono : ses touches s’allument.', en: 'Click the timer’s tile: its keys light up.' },
        at: '.opx-aircard .opx-widget',
        done: () => !!shown('.opx-widget.sel'),
      },
      {
        say: { fr: 'P : le chrono démarre.', en: 'P: the timer starts.' },
        at: '.opx-widget.sel',
        before: () => void (was = widgetState()),
        done: () => widgetState() !== was,
      },
    ],
  },
  {
    id: 'operator.widgets.triggers',
    cat: 'operator',
    chapter: 'widgets',
    title: { fr: 'Déclencheurs', en: 'Triggers' },
    setup: { kind: 'operator', example: 'ex-15-ceremonie-prix' },
    steps: [
      {
        say: { fr: 'Cliquez la Révélation du lauréat.', en: 'Click the winner’s Révélation.' },
        at: () => row('Révélation du lauréat'),
        done: () => cuedTemplate() === 'Révélation du lauréat',
      },
      {
        say: { fr: 'F1 : il attend le déclencheur reveal.', en: 'F1: it waits for the trigger reveal.' },
        at: NEXT,
        done: atPause,
      },
      {
        say: { fr: 'Cliquez reveal, sur sa carte : le lauréat apparaît.', en: 'Click reveal, on its card: the winner shows.' },
        at: '.opx-trig',
        done: () => onAir() > 0 && !atPause(),
      },
    ],
  },
];
