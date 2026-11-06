import type { Lesson } from '../../types';
import { t, tc } from '../../../i18n';
import { hasLayer, layers, project, selected, shown, template, withText } from '../../probe';
import { useLearn } from '../../store';
import { designTemplates } from '../../../engine/drafts';
import type { Layer } from '../../../engine/types';

/** An Image layer's own fields. */
type Img = Layer & { src?: string; video?: boolean; input?: string; crop?: { l: number; t: number; r: number; b: number } };
const image = (): Img | undefined => selected().find((l) => l.type === 'image') as Img | undefined;
/** The Video layer (an Image playing a file or a live input). */
const video = (): Img | undefined => layers().find((l) => l.type === 'image' && (l as Img).video) as Img | undefined;
/** The Lottie layer (a folder that receives the animation's layers). */
const lottie = () => layers().find((l) => l.type === 'group' && (l as Layer & { lottie?: string }).lottie !== undefined);

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
/** The control of a settings row by its label. */
function row(label: string): HTMLElement | null {
  for (const r of document.querySelectorAll<HTMLElement>('.wk-row')) if (r.querySelector('.prop-label')?.textContent?.trim() === label && r.getClientRects().length) return r.querySelector<HTMLElement>('.wk-ctl');
  return null;
}
/** An item of the + menu (Widgets) by its name. */
const addItem = (name: string) => withText('.add-menu button', tc('widget', name));
const plus = '.tl-corner .opx-add';
const imageTool = () => shown(`.tl-insert .tool[title="${t('Image')}"]`);

/** designer › media. */
export const lessons: Lesson[] = [
  {
    id: 'designer.media.library',
    cat: 'designer',
    chapter: 'media',
    title: { fr: 'Bibliothèque : images, icônes', en: 'Library: pictures, icons' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Image, en bas à gauche.', en: 'Click Image, bottom left.' },
        at: imageTool,
        done: () => ready() && hasLayer('image'),
      },
      {
        say: { fr: 'À droite, cliquez « Choisir une image… ».', en: 'On the right, click “Choose a picture…”.' },
        at: '.pick',
        done: () => !!shown('.lib'),
      },
      {
        say: { fr: 'Onglet Bibliothèque : icônes, émojis, drapeaux, illustrations.', en: 'Library tab: icons, emojis, flags, illustrations.' },
        at: () => withText('.lib-tabs button', t('Library')),
        done: () => !!shown('.pl'),
      },
      {
        say: { fr: 'Cliquez une icône, une couleur, puis Utiliser.', en: 'Click an icon, a colour, then Use.' },
        at: '.pl-side',
        done: () => !!image()?.src,
      },
    ],
  },
  {
    id: 'designer.media.crop',
    cat: 'designer',
    chapter: 'media',
    title: { fr: 'Recadrer une image', en: 'Crop a picture' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Image, en bas à gauche.', en: 'Click Image, bottom left.' },
        at: imageTool,
        done: () => ready() && hasLayer('image'),
      },
      {
        say: { fr: 'À droite, cliquez « Choisir une image… ».', en: 'On the right, click “Choose a picture…”.' },
        at: '.pick',
        done: () => !!shown('.lib'),
      },
      {
        say: { fr: 'Onglet Bibliothèque : double-cliquez une illustration ou une icône.', en: 'Library tab: double-click an illustration or an icon.' },
        // The tab, then beside the pictures (the bubble off them).
        at: () => shown('.pl-side') ?? withText('.lib-tabs button', t('Library')),
        done: () => !!image()?.src,
      },
      {
        say: { fr: 'Ouvrez Ajustement et recadrage, puis activez Recadrer.', en: 'Open Fit & crop, then turn Crop on.' },
        at: () => row(t('Crop')) ?? twirl(t('Fit & crop')),
        done: () => !!shown('.img-crop-move'),
      },
      {
        say: { fr: 'Tirez un rond orange : seule une partie de l’image reste.', en: 'Drag an orange dot: only part of the picture stays.' },
        // The bottom right one: the bubble goes under the picture.
        at: () => [...document.querySelectorAll('.wk-handle')].pop(),
        done: () => {
          const c = image()?.crop;
          return !!c && c.l + c.t + c.r + c.b > 0.03;
        },
      },
    ],
  },
  {
    id: 'designer.media.video',
    cat: 'designer',
    chapter: 'media',
    title: { fr: 'Vidéo et entrée en direct', en: 'Video and live input' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez + (Widgets), puis Vidéo.', en: 'Click + (Widgets), then Video.' },
        at: () => addItem('Video') ?? shown(plus),
        done: () => ready() && !!video(),
      },
      {
        say: { fr: 'Fichier : « Choisir une vidéo… » ouvre vos vidéos (mp4, mov…).', en: 'File: “Choose a video…” opens your videos (mp4, mov…).' },
        at: '.video-pick',
        done: () => !!shown('.lib'),
      },
      {
        say: { fr: 'Double-cliquez une vidéo, ou Annuler.', en: 'Double-click a video, or Cancel.' },
        at: '.lib-f',
        done: () => !shown('.lib'),
      },
      {
        say: { fr: 'Source : Entrée en direct. Une caméra ou un flux, à la place du fichier.', en: 'Source: Live input. A camera or a stream, instead of the file.' },
        at: () => withText('.wk-body .segmented button', t('Live input')),
        // No input yet: the app says where to add one.
        done: () => !!video()?.input || !!withText('.toast', t('No live input yet: add one in Broadcast › Video inputs.')),
      },
    ],
  },
  {
    id: 'designer.media.import-psd',
    cat: 'designer',
    chapter: 'media',
    title: { fr: 'Importer un PSD ou un SVG', en: 'Import a PSD or an SVG' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez + à côté de Modèles.', en: 'Click + beside Templates.' },
        at: '.template-list .opx-add',
        done: () => ready() && !!shown('.modal.new-tpl'),
      },
      {
        say: { fr: 'Déposez ici un .psd ou un .svg : une fenêtre montre ce qui est gardé, calque par calque.', en: 'Drop a .psd or an .svg here: a window shows what is kept, layer by layer.' },
        at: '.new-tpl-drop',
        done: 'next',
      },
      {
        say: { fr: 'Fermez : rien n’est importé.', en: 'Close: nothing is imported.' },
        at: () => shown(`.modal.new-tpl header .icon-btn[title="${t('Close')}"]`),
        done: () => !shown('.modal.new-tpl'),
      },
    ],
  },
  {
    id: 'designer.media.import-lottie',
    cat: 'designer',
    chapter: 'media',
    title: { fr: 'Importer After Effects (Lottie)', en: 'Import After Effects (Lottie)' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez + (Widgets), puis Animation (Lottie).', en: 'Click + (Widgets), then Animation (Lottie).' },
        at: () => addItem('Animation (Lottie)') ?? shown(plus),
        done: () => ready() && !!lottie(),
      },
      {
        say: { fr: 'À droite, ouvrez Général, puis cliquez « Choisir un fichier Lottie… ».', en: 'On the right, open General, then click “Choose a Lottie file…”.' },
        at: () => shown('.video-pick') ?? twirl(t('General')),
        done: () => !!shown('.lib'),
      },
      {
        say: { fr: 'Vos .json Bodymovin, .zip, .lottie : chacun devient des calques. Annuler pour fermer.', en: 'Your Bodymovin .json, .zip, .lottie: each one becomes layers. Cancel to close.' },
        at: '.lib-f',
        done: () => !shown('.lib'),
      },
      {
        say: { fr: 'Un projet .aep entier ? Le + à côté de Modèles en fait un modèle.', en: 'A whole .aep project? The + beside Templates makes it a template.' },
        at: '.template-list .opx-add',
        done: 'next',
      },
    ],
  },
];
