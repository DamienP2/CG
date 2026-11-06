import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { project, shown, withText } from '../../probe';
import { cued, isOnAir, itemById, itemNamed, LIST, moreOf, NEXT, rundown } from './start';

/** Counts and the rundown when a step began; the item. */
let count = 0;
let order = '';
let id = '';
let was = '';

const lists = () => project()?.playlists ?? [];
const mine = () => lists().filter((p) => p.owner).length;
/** The + of the playlist tabs, and its menu. */
const NEW_LIST = '.opx-pltabs > .opx-add';
const menuItem = (label: string) => withText('.opx-pl-menu button', t(label));

/** operator › playlists. */
export const lessons: Lesson[] = [
  {
    id: 'operator.playlists.create',
    cat: 'operator',
    chapter: 'playlists',
    title: { fr: 'Créer une playlist', en: 'Create a playlist' },
    setup: { kind: 'operator', example: 'ex-07-talk-show' },
    steps: [
      {
        say: { fr: 'Le + à droite des onglets : nouvelle playlist.', en: 'The + right of the tabs: a new playlist.' },
        at: NEW_LIST,
        done: () => !!menuItem('Shared playlist'),
      },
      {
        say: { fr: 'Choisissez Playlist partagée.', en: 'Choose Shared playlist.' },
        at: () => menuItem('Shared playlist'),
        before: () => void (count = lists().length),
        done: () => !!shown('.dialog'),
      },
      {
        say: { fr: 'Nommez-la, puis Créer.', en: 'Name it, then Create.' },
        at: '.dialog',
        done: () => lists().length > count,
      },
      {
        say: { fr: 'Elle est ouverte et vide. Le + du Conducteur y ajoute des graphiques.', en: 'It is open and empty. The + of the Rundown adds graphics to it.' },
        at: '.opx-head > .opx-add',
        done: 'next',
      },
    ],
  },
  {
    id: 'operator.playlists.add',
    cat: 'operator',
    chapter: 'playlists',
    title: { fr: 'Ajouter et dupliquer', en: 'Add and duplicate' },
    setup: { kind: 'operator', example: 'ex-07-talk-show' },
    steps: [
      {
        say: { fr: 'Le + du Conducteur : ajouter un graphique.', en: 'The + of the Rundown: add a graphic.' },
        at: '.opx-head > .opx-add',
        done: () => !!shown('.opx-addmodal'),
      },
      {
        say: { fr: 'Cliquez un modèle : il s’ajoute à la fin de la playlist.', en: 'Click a template: it is added at the end of the playlist.' },
        at: '.opx-addmodal',
        before: () => void (count = rundown().length),
        done: () => rundown().length > count,
      },
      {
        say: { fr: 'Sur sa ligne, l’icône copie : dupliquer.', en: 'On its row, the copy icon: duplicate.' },
        at: '.opx-gr.on .opx-acts button:first-child',
        before: () => void (count = rundown().length),
        done: () => rundown().length > count,
      },
      {
        say: { fr: 'Ouvrez son ⋯.', en: 'Open its ⋯.' },
        at: '.opx-gr.on .opx-acts button:last-child',
        done: () => !!shown('.opx-row-menu'),
      },
      {
        say: { fr: 'Dupliquer dans Réseaux : une copie dans l’autre playlist.', en: 'Duplicate into Réseaux: a copy in the other playlist.' },
        at: () => withText('.opx-row-menu button', 'Réseaux'),
        before: () => void (count = rundown().filter((r) => r.playlist === 'social').length),
        done: () => rundown().filter((r) => r.playlist === 'social').length > count,
      },
    ],
  },
  {
    id: 'operator.playlists.reorder',
    cat: 'operator',
    chapter: 'playlists',
    title: { fr: 'Réordonner', en: 'Reorder' },
    setup: { kind: 'operator', example: 'ex-07-talk-show' },
    steps: [
      {
        say: { fr: 'Tirez la poignée ⋮⋮ d’une ligne vers le haut ou le bas.', en: 'Drag the ⋮⋮ grip of a row up or down.' },
        at: LIST,
        before: () => void (order = ''),
        done: () => {
          const now = rundown().map((r) => r.id).join();
          if (!order) order = now;
          return !!now && now !== order;
        },
      },
      {
        say: { fr: 'Les flèches ↑ ↓ choisissent le graphique. Appuyez sur ↓.', en: 'The ↑ ↓ arrows choose the graphic. Press ↓.' },
        before: () => void (was = cued()),
        done: () => !!cued() && cued() !== was,
      },
    ],
  },
  {
    id: 'operator.playlists.auto',
    cat: 'operator',
    chapter: 'playlists',
    title: { fr: 'Enchaîner automatiquement', en: 'Go on by itself' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Cliquez AUTO : la playlist peut enchaîner seule.', en: 'Click AUTO: the playlist can go on by itself.' },
        at: '.opx-head .opx-btn.small',
        done: () => !!lists().find((p) => p.id === 'ouverture')?.autoNext,
      },
      {
        say: { fr: 'Ouvrez le ⋯ de LE JOURNAL.', en: 'Open the ⋯ of LE JOURNAL.' },
        at: () => moreOf('LE JOURNAL'),
        done: () => !!shown('.opx-row-menu') || !!shown('.marker-editor'),
      },
      {
        say: { fr: 'Suivant automatique…', en: 'Auto next…' },
        at: () => withText('.opx-row-menu button', t('Auto next…')),
        done: () => !!shown('.marker-editor'),
      },
      {
        say: { fr: 'Choisissez Après : 5 s à l’antenne, puis le suivant.', en: 'Choose After: 5 s on air, then the next one.' },
        at: '.marker-editor',
        before: () => void (id = itemNamed('LE JOURNAL')?.id ?? ''),
        done: () => itemById(id)?.autoSecs !== undefined,
      },
      {
        say: { fr: 'Échap, puis F1 : LE JOURNAL passe, puis AU SOMMAIRE, seul.', en: 'Esc, then F1: LE JOURNAL goes on air, then AU SOMMAIRE by itself.' },
        at: NEXT,
        done: () => isOnAir('AU SOMMAIRE'),
      },
    ],
  },
  {
    id: 'operator.playlists.schedule',
    cat: 'operator',
    chapter: 'playlists',
    title: { fr: 'Programmer une prise', en: 'Schedule a take' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Ouvrez le ⋯ de LE JOURNAL.', en: 'Open the ⋯ of LE JOURNAL.' },
        at: () => moreOf('LE JOURNAL'),
        done: () => !!shown('.opx-row-menu'),
      },
      {
        say: { fr: 'Programmer une prise… : à une heure, dans un délai, au timecode. Grisé ici : pas de vraie sortie.', en: 'Schedule a take…: at a time, after a delay, at a timecode. Greyed out here: no real output.' },
        at: () => withText('.opx-row-menu button', t('Schedule a take…')),
        done: 'next',
      },
    ],
  },
  {
    id: 'operator.playlists.personal',
    cat: 'operator',
    chapter: 'playlists',
    title: { fr: 'Personnelle ou partagée', en: 'Personal or shared' },
    setup: { kind: 'operator', example: 'ex-07-talk-show' },
    steps: [
      {
        say: { fr: 'Le + à droite des onglets…', en: 'The + right of the tabs…' },
        at: NEW_LIST,
        done: () => !!menuItem('Personal playlist'),
      },
      {
        say: { fr: '… Playlist personnelle, puis Créer.', en: '… Personal playlist, then Create.' },
        at: () => menuItem('Personal playlist') ?? shown('.dialog'),
        before: () => void (count = mine()),
        done: () => mine() > count,
      },
      {
        say: { fr: 'Son point : seuls vous et les admins la voyez. Ouvrez son ⋯.', en: 'Its dot: only you and the admins see it. Open its ⋯.' },
        at: '.opx-pl.on .opx-pl-more',
        done: () => !!menuItem('Share with everyone'),
      },
      {
        say: { fr: 'Partager avec tous : elle devient partagée.', en: 'Share with everyone: it becomes shared.' },
        at: () => menuItem('Share with everyone'),
        done: () => mine() === count,
      },
    ],
  },
];
