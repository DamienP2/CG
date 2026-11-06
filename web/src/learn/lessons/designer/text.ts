import type { Lesson } from '../../types';
import { t, tc } from '../../../i18n';
import { hasLayer, project, prop, selected, shown, template, withText } from '../../probe';
import { useLearn } from '../../store';
import { designTemplates } from '../../../engine/drafts';
import type { Layer } from '../../../engine/types';

/** The text layer selected (its own fields: text, font, varStyles…). */
type TextL = Layer & { text?: string; fontFamily?: string; fontWeight?: number; overflow?: string; wrap?: boolean; varStyles?: Record<string, { bold?: boolean }> };
const text = (): TextL | undefined => selected().find((l) => l.type === 'text') as TextL | undefined;
/** Its text without tags, variables or pictures. */
const plain = (s = '') => s.replace(/<[^>]*>/g, '').replace(/\{\{\s*\w+\s*\}\}/g, 'x');

/** The training project's own template is open (not the one of the lesson before, still shown while the page loads). */
const ready = () => {
  const p = project();
  const id = template()?.id;
  return !!p && !!id && p.id === useLearn.getState().project && designTemplates(p).some((x) => x.id === id);
};
/** A section of the properties (its title as shown), open or not. */
function twirl(title: string, open?: boolean): HTMLElement | null {
  for (const b of document.querySelectorAll<HTMLElement>(`.pp-group${open ? '.open' : ''} > header .pp-twirl`))
    if (b.textContent?.trim() === title && b.getClientRects().length) return b;
  return null;
}
/** An open section, whole. */
const section = (title: string) => twirl(title, true)?.closest<HTMLElement>('.pp-group') ?? null;
/** In an open section, the first element matching `sel` whose text has `has`. */
function inSection(title: string, sel: string, has = ''): HTMLElement | null {
  const g = twirl(title, true)?.closest('.pp-group');
  for (const el of g?.querySelectorAll<HTMLElement>(sel) ?? []) if ((el.textContent ?? '').includes(has) && el.getClientRects().length) return el;
  return null;
}
/** The control of a settings row by its label. */
function row(label: string): HTMLElement | null {
  for (const r of document.querySelectorAll<HTMLElement>('.wk-row')) if (r.querySelector('.prop-label')?.textContent?.trim() === label && r.getClientRects().length) return r.querySelector<HTMLElement>('.wk-ctl');
  return null;
}
const line = () => shown(`.tl-insert .tool[title="${tc('text', 'Line')}"]`);
/** Adds a Text: the first step of most lessons. */
const addLine = {
  say: { fr: 'Cliquez Ligne (T), en bas à gauche : un texte s’ajoute.', en: 'Click Line (T), bottom left: a text is added.' },
  at: line,
  done: () => ready() && hasLayer('text'),
};
/** The Content section (the ring round it: the right-click menu stays clear of the bubble). */
const content = () => shown('.rt-box')?.closest<HTMLElement>('.pp-group') ?? null;

/** Values remembered when a step starts. */
let was = { text: '', x: 0, y: 0, font: '', size: 0, weight: 0 };

/** designer › text. */
export const lessons: Lesson[] = [
  {
    id: 'designer.text.add',
    cat: 'designer',
    chapter: 'text',
    title: { fr: 'Ajouter un texte', en: 'Add a text' },
    setup: { kind: 'designer' },
    steps: [
      addLine,
      {
        say: { fr: 'Contenu, à droite : tapez votre texte.', en: 'Content, on the right: type your text.' },
        at: '.rt-box',
        before: () => void (was.text = text()?.text ?? ''),
        done: () => {
          const s = text()?.text ?? '';
          return s !== was.text && plain(s).trim().length > 0;
        },
      },
      {
        say: { fr: 'Glissez-le dans le canvas pour le placer.', en: 'Drag it in the canvas to place it.' },
        at: '.tf-frame polygon, .stage-frame',
        before: () => {
          const l = text();
          was = { ...was, x: prop(l, 'x'), y: prop(l, 'y') };
        },
        done: () => {
          const l = text();
          return !!l && Math.hypot(prop(l, 'x') - was.x, prop(l, 'y') - was.y) > 20;
        },
      },
    ],
  },
  {
    id: 'designer.text.line-paragraph',
    cat: 'designer',
    chapter: 'text',
    title: { fr: 'Ligne ou paragraphe', en: 'Line or paragraph' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Ligne (T) : le texte reste sur une ligne. Cliquez Ligne.', en: 'Line (T): the text stays on one line. Click Line.' },
        at: line,
        done: () => ready() && hasLayer('text'),
      },
      {
        say: { fr: 'Paragraphe (¶) : les lignes passent à la ligne. Cliquez Paragraphe.', en: 'Paragraph (¶): the lines wrap. Click Paragraph.' },
        at: () => shown(`.tl-insert .tool[title="${t('Paragraph')}"]`),
        done: () => !!(text() as TextL | undefined)?.wrap,
      },
      {
        say: { fr: 'Tirez le bord droit du cadre : les lignes se recomposent.', en: 'Drag the right side of the frame: the lines wrap again.' },
        // The handle in the middle of the right side.
        at: () => document.querySelectorAll('.tf-frame .tf-handle')[3],
        before: () => void (was.size = prop(text(), 'width')),
        done: () => {
          const l = text();
          return !!l?.wrap && Math.abs(prop(l, 'width') - was.size) > 40;
        },
      },
    ],
  },
  {
    id: 'designer.text.typography',
    cat: 'designer',
    chapter: 'text',
    title: { fr: 'Typographie et polices', en: 'Typography and fonts' },
    setup: { kind: 'designer' },
    steps: [
      addLine,
      {
        say: { fr: 'À droite, ouvrez Typographie.', en: 'On the right, open Typography.' },
        at: () => twirl(t('Typography')),
        done: () => !!twirl(t('Typography'), true),
      },
      {
        say: { fr: 'Police : choisissez-en une autre.', en: 'Font: choose another one.' },
        // Round the section: the bubble goes above it, the list of fonts opens below.
        at: () => section(t('Typography')),
        before: () => void (was.font = text()?.fontFamily ?? ''),
        done: () => !!text() && text()!.fontFamily !== was.font,
      },
      {
        say: { fr: 'Taille : tapez un plus grand nombre, puis Entrée.', en: 'Size: type a bigger number, then Enter.' },
        at: () => inSection(t('Typography'), '.pp-row', t('Size')),
        before: () => void (was.size = prop(text(), 'fontSize')),
        done: () => prop(text(), 'fontSize') > was.size + 5,
      },
      {
        say: { fr: 'Décoration : cliquez Gras (B).', en: 'Decoration: click Bold (B).' },
        at: () => shown(`.segmented button[title="${t('Bold')}"]`),
        before: () => void (was.weight = text()?.fontWeight ?? 400),
        done: () => (text()?.fontWeight ?? 400) !== was.weight,
      },
    ],
  },
  {
    id: 'designer.text.too-long',
    cat: 'designer',
    chapter: 'text',
    title: { fr: 'Texte trop long', en: 'Text too long' },
    setup: { kind: 'designer' },
    steps: [
      addLine,
      {
        say: { fr: 'Contenu : tapez une longue phrase. Le texte se resserre, puis rapetisse pour tenir.', en: 'Content: type a long sentence. The text gets narrower, then smaller, to fit.' },
        at: '.rt-box',
        done: () => plain(text()?.text).length >= 45,
      },
      {
        say: { fr: 'Ouvrez Comportement.', en: 'Open Behaviour.' },
        at: () => twirl(t('Behaviour')),
        done: () => !!twirl(t('Behaviour'), true),
      },
      {
        say: { fr: 'Trop long : choisissez « … ». Le texte est coupé avec des points.', en: 'Too long: choose “…”. The text is cut with dots.' },
        at: () => row(t('Too long')),
        done: () => text()?.overflow === 'ellipsis',
      },
    ],
  },
  {
    id: 'designer.text.styles',
    cat: 'designer',
    chapter: 'text',
    title: { fr: 'Styles dans le texte', en: 'Styles in the text' },
    setup: { kind: 'designer' },
    steps: [
      addLine,
      {
        say: { fr: 'Contenu : double-cliquez un mot, puis clic droit › Exposer la sélection à l’opérateur.', en: 'Content: double-click a word, then right-click › Expose the selection to the Operator.' },
        at: content,
        done: () => /\{\{\s*\w+\s*\}\}/.test(text()?.text ?? ''),
      },
      {
        say: { fr: 'Ce mot a son propre style. Ouvrez Typographie.', en: 'This word has its own style. Open Typography.' },
        at: () => twirl(t('Typography')),
        done: () => !!twirl(t('Typography'), true),
      },
      {
        say: { fr: 'En haut, choisissez la variable au lieu de « Commun · tout le texte ».', en: 'At the top, choose the variable instead of “Common · the whole text”.' },
        at: () => section(t('Typography')),
        done: () => !!shown('.tx-target .dd-btn.var'),
      },
      {
        say: { fr: 'Décoration : cliquez Gras (B). Seul ce mot change.', en: 'Decoration: click Bold (B). Only this word changes.' },
        at: () => shown(`.segmented button[title="${t('Bold')}"]`),
        done: () => Object.values(text()?.varStyles ?? {}).some((s) => s.bold !== undefined),
      },
    ],
  },
  {
    id: 'designer.text.pictures',
    cat: 'designer',
    chapter: 'text',
    title: { fr: 'Images dans le texte', en: 'Pictures in the text' },
    setup: { kind: 'designer' },
    steps: [
      addLine,
      {
        say: { fr: 'Contenu : clic droit à l’endroit voulu › Insérer une image…', en: 'Content: right-click where you want it › Insert a picture…' },
        at: content,
        done: () => !!shown('.lib'),
      },
      {
        say: { fr: 'Onglet Bibliothèque : double-cliquez une icône ou un drapeau.', en: 'Library tab: double-click an icon or a flag.' },
        // The tab, then beside the pictures (the bubble off them).
        at: () => shown('.pl-side') ?? withText('.lib-tabs button', t('Library')),
        done: () => /<img=/.test(text()?.text ?? ''),
      },
      {
        say: { fr: 'Cliquez la puce ▣ dans le Contenu : ses réglages.', en: 'Click the ▣ chip in the Content: its settings.' },
        at: '.rt-tok.i',
        done: () => !!shown('.tv-pop'),
      },
      {
        say: { fr: 'Hauteur : Ligne. L’image prend la hauteur de la ligne.', en: 'Height: Line. The picture takes the height of the line.' },
        at: () => withText('.tv-pop .tv-row', t('Height')),
        done: () => /<img=[^>]*\|line>/.test(text()?.text ?? ''),
      },
    ],
  },
];
