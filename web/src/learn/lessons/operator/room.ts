import type { Lesson } from '../../types';
import { actionLabel } from '../../../operator/shortcuts';
import { onAir, shown } from '../../probe';
import { cued, isOnAir, listTab, NEXT, openList, playOf } from './start';

/** The selected graphic, or a count of keys, when a step began. */
let was = '';
let keys = 0;

/** The row of an action on the Shortcuts page, and its keys. */
const keysRow = (action: string) => [...document.querySelectorAll('.sch-sc-row')].find((el) => el.querySelector('.sch-sc-label')?.textContent?.trim() === actionLabel(action));
const keyCount = (action: string) => keysRow(action)?.querySelectorAll('.sch-sc-key').length ?? 0;
/** The action the lesson binds: TAKE (no key in the Broadcast profile). */
const TAKE = 'take';

/** operator › room. */
export const lessons: Lesson[] = [
  {
    id: 'operator.room.zones',
    cat: 'operator',
    chapter: 'room',
    title: { fr: 'Plusieurs zones', en: 'Several zones' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Ouvrez la playlist Journal.', en: 'Open the Journal playlist.' },
        at: () => listTab('Journal'),
        done: () => openList() === 'Journal',
      },
      {
        say: { fr: 'La pastille dit la zone. Envoyez Claire Vasseur (Synthé) : son ▶.', en: 'The pill tells the zone. Take Claire Vasseur (Synthé): its ▶.' },
        at: () => playOf('Claire Vasseur'),
        done: () => isOnAir('Claire Vasseur'),
      },
      {
        say: { fr: 'Puis PARIS (Lieu) : autre zone, les deux restent.', en: 'Then PARIS (Lieu): another zone, both stay.' },
        at: () => playOf('PARIS'),
        done: () => isOnAir('PARIS') && isOnAir('Claire Vasseur'),
      },
      {
        say: { fr: 'Puis Marc Delorme : même zone, il remplace Claire.', en: 'Then Marc Delorme: same zone, he replaces Claire.' },
        at: () => playOf('Marc Delorme'),
        done: () => isOnAir('Marc Delorme') && !isOnAir('Claire Vasseur'),
      },
    ],
  },
  {
    id: 'operator.room.operators',
    cat: 'operator',
    chapter: 'room',
    title: { fr: 'Plusieurs opérateurs', en: 'Several operators' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'En haut, les personnes sur ce canal. Ici, vous seul.', en: 'At the top, the people on this channel. Here, only you.' },
        at: '.opl-people',
        done: 'next',
      },
      {
        say: { fr: 'F1 : envoyer un graphique vous donne sa zone.', en: 'F1: taking a graphic gives you its zone.' },
        at: NEXT,
        done: () => onAir() > 0,
      },
      {
        say: { fr: 'En régie, les autres voient cette zone tenue, avec votre avatar.', en: 'In the control room, the others see this zone held, with your avatar.' },
        at: '.opx-aircard',
        done: 'next',
      },
      {
        say: { fr: 'Ils peuvent la prendre d’un clic. Vous êtes prévenu et pouvez la reprendre.', en: 'They can take it over in one click. You are told and can take it back.' },
        done: 'next',
      },
    ],
  },
  {
    id: 'operator.room.outputs',
    cat: 'operator',
    chapter: 'room',
    title: { fr: 'Sorties supplémentaires', en: 'More outputs' },
    setup: { kind: 'operator', example: 'ex-07-talk-show' },
    steps: [
      {
        say: { fr: 'Ouvrez le ⋯ de la playlist Plateau.', en: 'Open the ⋯ of the Plateau playlist.' },
        at: '.opx-pl.on .opx-pl-more',
        done: () => !!shown('.opx-pl-menu'),
      },
      {
        say: { fr: 'Avec des sorties en plus, « Envoyer vers » apparaît ici : où va la playlist.', en: 'With more outputs, “Send to” shows here: where the playlist goes.' },
        at: '.opx-pl-menu',
        done: 'next',
      },
    ],
  },
  {
    id: 'operator.room.keys',
    cat: 'operator',
    chapter: 'room',
    title: { fr: 'Raccourcis clavier', en: 'Keyboard shortcuts' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Appuyez sur « ? » : la liste des raccourcis.', en: 'Press “?”: the list of the shortcuts.' },
        at: '.ux1-help',
        done: () => !!shown('.ux1-sc'),
      },
      {
        say: { fr: 'F1 NEXT, F2 CONTINUE, F3 OUT, F4 UPDATE, F12 tout effacer.', en: 'F1 NEXT, F2 CONTINUE, F3 OUT, F4 UPDATE, F12 clear all.' },
        at: '.ux1-sc',
        done: 'next',
      },
      {
        say: { fr: 'Échap pour fermer.', en: 'Esc to close.' },
        done: () => !shown('.ux1-sc'),
      },
      {
        say: { fr: '↓ : le graphique suivant de la playlist.', en: '↓: the next graphic of the playlist.' },
        before: () => void (was = cued()),
        done: () => !!cued() && cued() !== was,
      },
      {
        say: { fr: '2 : envoie le 2e graphique.', en: '2: takes the 2nd graphic.' },
        done: () => onAir() > 0,
      },
    ],
  },
  {
    id: 'operator.room.custom-keys',
    cat: 'operator',
    chapter: 'room',
    title: { fr: 'Personnaliser les touches', en: 'Customise the keys' },
    setup: { kind: 'page', path: '/shortcuts' },
    steps: [
      {
        say: { fr: 'Vos touches de l’Opérateur, action par action.', en: 'Your keys in the Operator, action by action.' },
        at: '.sch-sc-page',
        done: 'next',
      },
      {
        say: { fr: 'Le + de TAKE : ajouter une touche.', en: 'The + of TAKE: add a key.' },
        at: () => keysRow(TAKE)?.querySelector('.sch-sc-acts .sch-sc-btn:last-child'),
        before: () => void (keys = keyCount(TAKE)),
        done: () => !!keysRow(TAKE)?.classList.contains('rec'),
      },
      {
        say: { fr: 'Appuyez sur T.', en: 'Press T.' },
        at: () => keysRow(TAKE),
        done: () => keyCount(TAKE) > keys,
      },
      {
        say: { fr: 'Remettez comme avant : survolez la touche, cliquez son ×.', en: 'Put it back: hover the key, click its ×.' },
        at: () => [...(keysRow(TAKE)?.querySelectorAll('.sch-sc-key') ?? [])].pop(),
        done: () => keyCount(TAKE) === keys,
      },
    ],
  },
];
