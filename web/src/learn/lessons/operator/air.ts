import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { onAir, shown } from '../../probe';
import { airIds, airState, atPause, cued, isOnAir, itemById, itemNamed, LIST, listTab, NEXT, openList, playOf, row, titled, valuesPane } from './start';

/** What was on air, or an item's values, when a step began; the item. */
let was = '';
let id = '';
let ids: string[] = [];
let count = 0;

const openJournal = {
  say: { fr: 'Ouvrez la playlist Journal.', en: 'Open the Journal playlist.' },
  at: () => listTab('Journal'),
  done: () => openList() === 'Journal',
};

/** operator › air. */
export const lessons: Lesson[] = [
  {
    id: 'operator.air.prepare',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Préparer un graphique', en: 'Prepare a graphic' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      openJournal,
      {
        say: { fr: 'Cliquez Marc Delorme.', en: 'Click Marc Delorme.' },
        at: () => row('Marc Delorme'),
        done: () => cued() === 'Marc Delorme',
      },
      {
        say: { fr: 'Onglet Fonction : corrigez sa fonction. L’Aperçu suit.', en: 'Fonction tab: fix his role. The Preview follows.' },
        at: valuesPane,
        before: () => {
          id = itemNamed('Marc Delorme')?.id ?? '';
          was = itemById(id)?.data.role ?? '';
        },
        done: () => !!id && (itemById(id)?.data.role ?? '') !== was,
      },
      {
        say: { fr: 'CUE et NEXT : c’est lui qui partira au prochain F1.', en: 'CUE and NEXT: he goes on air at the next F1.' },
        at: NEXT,
        done: 'next',
      },
    ],
  },
  {
    id: 'operator.air.take',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Envoyer à l’antenne (F1)', en: 'Take on air (F1)' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      openJournal,
      {
        say: { fr: 'F1 : Claire Vasseur, en CUE, part à l’antenne.', en: 'F1: Claire Vasseur, in CUE, goes on air.' },
        at: NEXT,
        done: () => onAir() > 0,
      },
      {
        say: { fr: 'F1 encore : NEXT envoie le suivant.', en: 'F1 again: NEXT takes the next one.' },
        at: NEXT,
        before: () => void (ids = airIds()),
        done: () => onAir() > 0 && airIds().some((x) => !ids.includes(x)),
      },
      {
        say: { fr: 'Le ▶ d’une ligne l’envoie aussi. Cliquez celui de PARIS.', en: 'A row’s ▶ takes it too. Click the one of PARIS.' },
        at: () => playOf('PARIS'),
        done: () => isOnAir('PARIS'),
      },
    ],
  },
  {
    id: 'operator.air.continue',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Continuer (F2)', en: 'Continue (F2)' },
    setup: { kind: 'operator', example: 'ex-16-quiz-tv' },
    steps: [
      {
        say: { fr: 'Cliquez QUESTION 7.', en: 'Click QUESTION 7.' },
        at: () => row('QUESTION 7'),
        done: () => cued() === 'QUESTION 7',
      },
      {
        say: { fr: 'F1 : la question s’arrête sur une pause.', en: 'F1: the question stops on a pause.' },
        at: NEXT,
        done: atPause,
      },
      {
        say: { fr: 'CONTINUE est orange. F2 : la bonne réponse s’allume.', en: 'CONTINUE is orange. F2: the right answer lights up.' },
        at: '.ux1-transport .opx-btn.amber',
        done: () => onAir() > 0 && !atPause(),
      },
    ],
  },
  {
    id: 'operator.air.out',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Sortir (F3)', en: 'Take out (F3)' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Cliquez le ▶ de LE JOURNAL.', en: 'Click the ▶ of LE JOURNAL.' },
        at: () => playOf('LE JOURNAL'),
        done: () => isOnAir('LE JOURNAL'),
      },
      {
        say: { fr: 'Puis celui de AU SOMMAIRE.', en: 'Then the one of AU SOMMAIRE.' },
        at: () => playOf('AU SOMMAIRE'),
        done: () => onAir() >= 2,
      },
      {
        say: { fr: 'F3 : le graphique de devant sort.', en: 'F3: the front-most graphic goes out.' },
        at: '.ux1-transport .opx-btn:nth-child(3)',
        before: () => void (count = onAir()),
        done: () => onAir() < count,
      },
      {
        say: { fr: 'OUT, sur sa carte à droite, sort l’autre.', en: 'OUT, on its card on the right, takes the other one out.' },
        at: '.opx-aircard .opx-tile.out',
        done: () => onAir() === 0,
      },
    ],
  },
  {
    id: 'operator.air.update',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Mettre à jour à l’antenne (F4)', en: 'Update on air (F4)' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Cliquez le ▶ de LE JOURNAL : il part et reste choisi.', en: 'Click the ▶ of LE JOURNAL: it goes on air and stays selected.' },
        at: () => playOf('LE JOURNAL'),
        done: () => isOnAir('LE JOURNAL'),
      },
      {
        say: { fr: 'Changez Émission : l’antenne ne change pas encore.', en: 'Change Émission: the antenna does not change yet.' },
        at: valuesPane,
        done: () => !!shown('.opx-upd.ready'),
      },
      {
        say: { fr: 'UPDATE compte les changements. F4 : envoyez-les.', en: 'UPDATE counts the changes. F4: send them.' },
        at: '.opx-upd',
        before: () => void (was = airState()),
        done: () => airState() !== was && !shown('.opx-upd.ready'),
      },
    ],
  },
  {
    id: 'operator.air.clear',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Tout effacer (F12)', en: 'Clear all (F12)' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      openJournal,
      {
        say: { fr: 'Envoyez trois graphiques : ▶ de Claire Vasseur, PARIS, INTERNATIONAL.', en: 'Take three graphics: ▶ of Claire Vasseur, PARIS, INTERNATIONAL.' },
        at: LIST,
        done: () => onAir() >= 3,
      },
      {
        say: { fr: 'F12 ou CLEAR ALL : tout sort d’un coup.', en: 'F12 or CLEAR ALL: everything goes out at once.' },
        at: '.ux1-clear',
        done: () => onAir() === 0,
      },
    ],
  },
  {
    id: 'operator.air.undo',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Annuler', en: 'Undo' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      openJournal,
      {
        say: { fr: 'Envoyez Claire Vasseur et PARIS avec leur ▶.', en: 'Take Claire Vasseur and PARIS with their ▶.' },
        at: LIST,
        done: () => isOnAir('Claire Vasseur') && isOnAir('PARIS'),
      },
      {
        say: { fr: 'Simulez une erreur : F12 efface tout.', en: 'Make a mistake: F12 clears everything.' },
        at: '.ux1-clear',
        before: () => void (count = onAir()),
        done: () => onAir() === 0,
      },
      {
        say: { fr: 'Ctrl+Z (⌘Z) ou UNDO : tout revient.', en: 'Ctrl+Z (⌘Z) or UNDO: everything comes back.' },
        at: () => titled('.ux1-transport button', t('UNDO · the last action')),
        done: () => onAir() >= Math.max(1, count),
      },
    ],
  },
  {
    id: 'operator.air.fade',
    cat: 'operator',
    chapter: 'air',
    title: { fr: 'Fondu ou cut', en: 'Fade or cut' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Cliquez le ▶ de LE JOURNAL : il part et reste choisi.', en: 'Click the ▶ of LE JOURNAL: it goes on air and stays selected.' },
        at: () => playOf('LE JOURNAL'),
        done: () => isOnAir('LE JOURNAL'),
      },
      {
        say: { fr: 'Cliquez FADE, à côté d’UPDATE.', en: 'Click FADE, next to UPDATE.' },
        at: '.opx-upd-mode',
        done: () => !!shown('.opx-upd-mode button:first-child.on'),
      },
      {
        say: { fr: 'Changez Émission, puis F4 : le texte change en fondu.', en: 'Change Émission, then F4: the text cross-fades.' },
        at: valuesPane,
        before: () => void (was = airState()),
        done: () => airState() !== was,
      },
      {
        say: { fr: 'Remettez CUT : le changement sera net.', en: 'Back to CUT: the change will be at once.' },
        at: '.opx-upd-mode',
        done: () => !!shown('.opx-upd-mode button:last-child.on'),
      },
    ],
  },
];
