import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { plain } from '../../../engine/rich';
import { useApp } from '../../../store';
import { onAir, shown } from '../../probe';
import { airState, cued, isOnAir, itemById, itemNamed, listTab, NEXT, openList, playOf, rundown, row, titled, valuesPane } from './start';

/** The item the lesson works on, and a value when a step began. */
let id = '';
let was = '';

/** A name with « Claire » in bold, as the Designer or an earlier take may leave it. */
const STYLED = '<b>Claire</b> Vasseur';
const nameOf = () => itemById(id)?.data.name ?? '';
/**
 * A name already styled, once the project is there: the Operator shows its
 * styles (Ctrl+B / I / U work there). True once it is saved.
 */
function seed(): boolean {
  if (id) return itemById(id)?.data.name === STYLED;
  const r = itemNamed('Claire Vasseur');
  if (!r) return false;
  id = r.id;
  void useApp.getState().saveRundown(rundown().map((x) => (x.id === r.id ? { ...x, data: { ...x.data, name: STYLED } } : x)));
  return false;
}

/** The value typed by hand over the data (its field). */
const handInput = () => shown('.opx-vt-src.hand')?.closest('.opx-var')?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ?? null;
/** The number of a row of the data set: the chosen one, the one on air. */
const rowNumber = (cls: 'chosen' | 'air') => {
  const tr = cls === 'air' ? shown('.ods-src .ods-badge.air')?.closest('tr') : shown('.ods-src tr.chosen');
  return tr?.querySelector('.ods-n')?.textContent?.trim() ?? '';
};

/** operator › values. */
export const lessons: Lesson[] = [
  {
    id: 'operator.values.texts',
    cat: 'operator',
    chapter: 'values',
    title: { fr: 'Remplir les textes', en: 'Fill in the texts' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Ouvrez la playlist Journal.', en: 'Open the Journal playlist.' },
        at: () => listTab('Journal'),
        done: () => openList() === 'Journal',
      },
      {
        say: { fr: 'Cliquez Paul Girard.', en: 'Click Paul Girard.' },
        at: () => row('Paul Girard'),
        done: () => cued() === 'Paul Girard',
      },
      {
        say: { fr: 'Onglet Nom : tapez un autre nom. La ligne prend ce nom.', en: 'Nom tab: type another name. The row takes that name.' },
        at: valuesPane,
        before: () => void (id = itemNamed('Paul Girard')?.id ?? ''),
        done: () => !!id && !!itemById(id)?.name && itemById(id)?.name !== 'Paul Girard',
      },
      {
        say: { fr: 'Onglet Fonction : tapez sa fonction.', en: 'Fonction tab: type the role.' },
        at: valuesPane,
        before: () => void (was = itemById(id)?.data.role ?? ''),
        done: () => (itemById(id)?.data.role ?? '') !== was,
      },
    ],
  },
  {
    id: 'operator.values.by-hand',
    cat: 'operator',
    chapter: 'values',
    title: { fr: 'Taper par-dessus les données', en: 'Type over the data' },
    setup: { kind: 'operator', example: 'ex-12-festival-live' },
    steps: [
      {
        say: { fr: 'Cliquez JUSTICE (DJ SET).', en: 'Click JUSTICE (DJ SET).' },
        at: () => row('JUSTICE (DJ SET)'),
        done: () => cued() === 'JUSTICE (DJ SET)',
      },
      {
        say: { fr: 'Artiste vient du programme. Le crayon : saisir à la main.', en: 'Artiste comes from the programme. The pen: type it by hand.' },
        at: () => titled('.opx-tiles ', t('Type it by hand')),
        done: () => !!titled('.opx-tiles ', t('Back to the data')),
      },
      {
        say: { fr: 'Tapez un autre artiste.', en: 'Type another artist.' },
        at: () => handInput(),
        before: () => void (was = handInput()?.value ?? ''),
        done: () => {
          const v = handInput()?.value.trim();
          return !!v && v !== was.trim();
        },
      },
      {
        say: { fr: 'L’icône base de données : revenir aux données.', en: 'The database icon: back to the data.' },
        at: () => titled('.opx-tiles ', t('Back to the data')),
        done: () => !!titled('.opx-tiles ', t('Type it by hand')),
      },
    ],
  },
  {
    id: 'operator.values.styles',
    cat: 'operator',
    chapter: 'values',
    title: { fr: 'Gras, couleurs dans un texte', en: 'Bold and colours in a text' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Ouvrez la playlist Journal.', en: 'Open the Journal playlist.' },
        at: () => listTab('Journal'),
        before: () => void (id = ''),
        done: () => seed() && openList() === 'Journal',
      },
      {
        say: { fr: 'Cliquez Claire Vasseur : « Claire » est en gras.', en: 'Click Claire Vasseur: “Claire” is in bold.' },
        at: () => row('Claire Vasseur'),
        done: () => cued() === 'Claire Vasseur' && !!shown('.opx-tiles .rt.bare'),
      },
      {
        say: { fr: 'Sélectionnez Vasseur, puis Ctrl+B (⌘B) : en gras aussi.', en: 'Select Vasseur, then Ctrl+B (⌘B): bold too.' },
        at: '.opx-tiles .rt.bare',
        done: () => plain(nameOf()) === 'Claire Vasseur' && /Vasseur<\/b>/.test(nameOf()),
      },
      {
        say: { fr: 'Une couleur : tapez <c=#ff3b5c> au début et </c> à la fin.', en: 'A colour: type <c=#ff3b5c> at the start and </c> at the end.' },
        at: '.opx-tiles .rt.bare',
        done: () => /<c=#[0-9a-f]{6}>/i.test(nameOf()) && nameOf().includes('</c>'),
      },
      {
        say: { fr: 'F1 : à l’antenne, avec ses styles.', en: 'F1: on air, with its styles.' },
        at: NEXT,
        done: () => onAir() > 0,
      },
    ],
  },
  {
    id: 'operator.values.images',
    cat: 'operator',
    chapter: 'values',
    title: { fr: 'Images et couleurs', en: 'Pictures and colours' },
    setup: { kind: 'operator', example: 'ex-20-live-shopping' },
    steps: [
      {
        say: { fr: 'Cliquez MAISON LUNE.', en: 'Click MAISON LUNE.' },
        at: () => row('MAISON LUNE'),
        done: () => cued() === 'MAISON LUNE',
      },
      {
        say: { fr: 'Photo : cliquez Choisir une image…', en: 'Photo: click Choose a picture…' },
        at: '.opx-tiles .pick',
        before: () => {
          id = itemNamed('MAISON LUNE')?.id ?? '';
          was = itemById(id)?.data.photo ?? '';
        },
        done: () => !!shown('.lib'),
      },
      {
        say: { fr: 'Bibliothèque : une icône, sa couleur, puis Utiliser.', en: 'Library: an icon, its colour, then Use.' },
        at: '.pl-side',
        done: () => !!id && (itemById(id)?.data.photo ?? '') !== was && !shown('.lib'),
      },
      {
        say: { fr: 'Opacité : tapez 100 %. L’image apparaît dans l’Aperçu.', en: 'Opacity: type 100%. The picture shows in the Preview.' },
        at: valuesPane,
        before: () => void (was = itemById(id)?.data.showPhoto ?? ''),
        done: () => (itemById(id)?.data.showPhoto ?? '') !== was,
      },
      {
        say: { fr: 'F1 : le produit part avec cette image.', en: 'F1: the product goes on air with that picture.' },
        at: NEXT,
        done: () => onAir() > 0,
      },
    ],
  },
  {
    id: 'operator.values.rows',
    cat: 'operator',
    chapter: 'values',
    title: { fr: 'Jeux de données : ligne suivante', en: 'Data sets: the next row' },
    setup: { kind: 'operator', example: 'ex-12-festival-live' },
    steps: [
      {
        say: { fr: 'Cliquez JUSTICE (DJ SET).', en: 'Click JUSTICE (DJ SET).' },
        at: () => row('JUSTICE (DJ SET)'),
        done: () => cued() === 'JUSTICE (DJ SET)',
      },
      {
        say: { fr: 'Son ▶ : la ligne 1 du programme part à l’antenne.', en: 'Its ▶: row 1 of the programme goes on air.' },
        at: () => playOf('JUSTICE (DJ SET)'),
        done: () => isOnAir('JUSTICE (DJ SET)'),
      },
      {
        say: { fr: 'Cliquez la ligne 2 : elle est choisie.', en: 'Click row 2: it is chosen.' },
        at: '.ods-src .ods-rows',
        done: () => !!rowNumber('chosen') && rowNumber('chosen') !== rowNumber('air'),
      },
      {
        say: { fr: 'F4 : elle passe à l’antenne.', en: 'F4: it goes on air.' },
        at: '.opx-upd',
        before: () => void (was = airState()),
        done: () => airState() !== was,
      },
    ],
  },
];
