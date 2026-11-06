import type { Lesson } from '../../types';
import { MAIN_FORMAT } from '../../../engine/types';
import { projectFormats } from '../../../engine/formats';
import { publishState } from '../../../engine/drafts';
import { t, tc } from '../../../i18n';
import { useTrackPreview } from '../../../designer/Tracking';
import { designer, hasLayer, layers, project, selected, shown, template, withText } from '../../probe';
import { dd, openWhenReady } from './logic';

/*
 * Before air: what the Operator sets, the formats, the safe areas, camera
 * tracking, publishing and the versions. All in the training project.
 */

const rectTool = () => shown(`.tl-insert .tool[title="${t('Rectangle')}"]`);
const addRect: Lesson['steps'][number] = {
  say: { fr: 'Ajoutez un rectangle : cliquez Rectangle.', en: 'Add a rectangle: click Rectangle.' },
  at: rectTool,
  done: () => hasLayer('rect'),
};
/** A row of the template's settings (right panel), by its label. */
const tplField = (label: string) => withText('.tpl-field', t(label));
/** The template's camera tracking list. */
const cameraList = () => dd(tplField('Camera tracking')?.querySelector('.dd-btn'));
/** The safe areas' margins in the Display menu. */
const safeMenuOpen = () => !!withText('.ux2-drow.open', t('Safe area'));
/** The number of versions in the History list. */
const versions = () => document.querySelectorAll('.history-pop .pjp-restore').length;
/** The layer's Tracking section (right panel). */
function trackingSection(): HTMLElement | null {
  for (const s of document.querySelectorAll<HTMLElement>('.pp-group'))
    if (s.querySelector(':scope > header span')?.textContent === tc('camera', 'Tracking') && s.getClientRects().length) return s;
  return null;
}
/** A row of the Tracking section by its label (its header while it is folded). */
function trackRow(label: string): Element | null {
  const s = trackingSection();
  if (!s) return null;
  if (!s.classList.contains('open')) return s.querySelector('header');
  return [...s.querySelectorAll('.wk-row')].find((r) => r.querySelector('.prop-label')?.textContent === t(label)) ?? s;
}
/** Brings what a step points at into view once it is there (the right panel scrolls). */
const reveal = (at: () => Element | null) => () => {
  let k = 0;
  const go = () => {
    const el = at();
    if (el) el.scrollIntoView({ block: 'nearest' });
    else if (k++ < 25) setTimeout(go, 200);
  };
  go();
};

/** Versions when the step began. */
let versionsWas = 0;
/** The title safe margin when the lesson began. */
let titleSafeWas = 0.1;

/** designer › air. */
export const lessons: Lesson[] = [
  {
    id: 'designer.air.expose',
    cat: 'designer',
    chapter: 'air',
    title: { fr: 'Exposer à l’Opérateur', en: 'Expose to the Operator' },
    setup: { kind: 'designer' },
    steps: [
      addRect,
      {
        say: { fr: 'Ouvrez Remplissage, puis cliquez (•) au bout de Couleur.', en: 'Open Fill, then click (•) at the end of Color.' },
        at: () => shown('.pp-row:has(.pp-field.color) .pp-op') ?? withText('.pp-group > header', t('Fill')),
        done: () => selected().some((l) => !!l.bindings.fill),
      },
      {
        say: { fr: 'Allumé : l’Opérateur choisira la couleur. Recliquez pour l’enlever.', en: 'Lit: the Operator will choose the color. Click again to remove it.' },
        at: () => shown('.pp-row .pp-op.on'),
        done: 'next',
      },
    ],
  },
  {
    id: 'designer.air.formats',
    cat: 'designer',
    chapter: 'air',
    title: { fr: 'Formats 16:9 et 9:16', en: '16:9 and 9:16 formats' },
    setup: { kind: 'designer', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Le synthé est ouvert. Cliquez + à côté de Principal 16:9.', en: 'The lower third is open. Click + next to Main 16:9.' },
        before: openWhenReady(0),
        at: '.format-bar .add',
        done: () => !!shown('.add-format'),
      },
      {
        say: { fr: 'Choisissez 9:16, puis Ajouter et adapter.', en: 'Choose 9:16, then Add and adapt.' },
        at: () => {
          const card = withText('.add-format .fmt-card', '9:16');
          return card && !card.classList.contains('on') ? card : shown('.add-format footer .btn.primary');
        },
        done: () => {
          const p = project();
          return !!p && projectFormats(p).some((f) => f.height > f.width) && designer().format !== MAIN_FORMAT;
        },
      },
      {
        say: { fr: 'Voici le 9:16 : sa mise en page à part, à retoucher ici.', en: 'Here is 9:16: a layout of its own, to touch up here.' },
        at: '.stage-holder',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Principal 16:9 : il n’a pas bougé.', en: 'Click Main 16:9: it has not moved.' },
        at: '.format-bar button:first-child',
        done: () => designer().format === MAIN_FORMAT,
      },
    ],
  },
  {
    id: 'designer.air.safe',
    cat: 'designer',
    chapter: 'air',
    title: { fr: 'Zone de sécurité', en: 'Safe area' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Affichage.', en: 'Click Display.' },
        before: () => void (titleSafeWas = project()?.guides?.titleSafe ?? 0.1),
        at: () => withText('.toolbar .btn', t('Display')),
        done: () => !!shown('.ux2-dmenu'),
      },
      {
        say: { fr: 'Zone de sécurité : cliquez Régler.', en: 'Safe area: click Tune.' },
        at: () => withText('.ux2-drow', t('Safe area'))?.querySelector('.ux2-adj'),
        done: safeMenuOpen,
      },
      {
        say: { fr: 'Sécurité titre : mettez 8 %. Les textes restent dans ce cadre.', en: 'Title safe: set 8%. Texts stay inside this frame.' },
        at: () => shown('.ux2-dsub .gm-row')?.querySelectorAll('input')[1] ?? shown('.ux2-dsub .gm-row'),
        done: () => Math.abs((project()?.guides?.titleSafe ?? 0.1) - titleSafeWas) > 0.001,
      },
      {
        say: { fr: 'Échap : fermez. Le cadre intérieur, c’est la sécurité titre.', en: 'Esc: close. The inner frame is the title safe.' },
        at: () => shown('.ux2-dmenu') ?? shown('.safe-area.title'),
        done: () => !shown('.ux2-dmenu'),
      },
    ],
  },
  {
    id: 'designer.air.tracking',
    cat: 'designer',
    chapter: 'air',
    title: { fr: 'Tracking caméra', en: 'Camera tracking' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'À droite, Tracking caméra : ouvrez la liste.', en: 'On the right, Camera tracking: open the list.' },
        at: cameraList,
        done: () => !!shown('.dd-list') || !!template()?.camera,
      },
      {
        say: { fr: 'Choisissez une caméra : le modèle suivra ses mouvements.', en: 'Choose a camera: the template will follow its moves.' },
        at: cameraList,
        done: () => !!template()?.camera,
      },
      {
        say: { fr: 'Aperçu : Simulé. Pas besoin de la vraie caméra.', en: 'Preview: Simulated. No need for the real camera.' },
        at: () => tplField('Preview')?.querySelector('.segmented, [role="radiogroup"]') ?? tplField('Preview'),
        done: () => !!useTrackPreview.getState().sim,
      },
      {
        say: { fr: 'Tirez Pan : les calques ancrés au décor suivront.', en: 'Drag Pan: the layers anchored to the set will follow.' },
        at: () => shown('.tpl-sim'),
        done: () => Math.abs(useTrackPreview.getState().sim?.pan ?? 0) > 0.5,
      },
    ],
  },
  {
    id: 'designer.air.behind',
    cat: 'designer',
    chapter: 'air',
    title: { fr: 'Derrière les personnes', en: 'Behind the people' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Tracking caméra : choisissez la caméra.', en: 'Camera tracking: choose the camera.' },
        at: cameraList,
        done: () => !!template()?.camera,
      },
      {
        say: { fr: 'Aperçu : Simulé. Pas besoin de la vraie caméra.', en: 'Preview: Simulated. No need for the real camera.' },
        at: () => tplField('Preview')?.querySelector('.segmented, [role="radiogroup"]') ?? tplField('Preview'),
        done: () => !!useTrackPreview.getState().sim,
      },
      addRect,
      {
        say: { fr: 'Tracking, Ancrage : Décor. Le calque reste sur le plateau.', en: 'Tracking, Anchoring: Set. The layer stays on the set.' },
        before: reveal(() => trackingSection()),
        at: () => trackRow('Anchoring'),
        done: () => selected().some((l) => !!l.anchor),
      },
      {
        say: { fr: 'Personnes : Derrière. Le calque passe derrière les gens filmés.', en: 'People: Behind. The layer goes behind the people filmed.' },
        before: reveal(() => trackRow('People')),
        at: () => trackRow('People'),
        done: () => layers().some((l) => !!l.anchor?.behind),
      },
    ],
  },
  {
    id: 'designer.air.publish',
    cat: 'designer',
    chapter: 'air',
    title: { fr: 'Publier', en: 'Publish' },
    setup: { kind: 'designer' },
    steps: [
      addRect,
      {
        say: { fr: 'Le point orange : ces changements ne sont pas encore dans l’Opérateur.', en: 'The orange dot: these changes are not in the Operator yet.' },
        at: '.template-item .tpl-draft',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Publier, puis confirmez.', en: 'Click Publish, then confirm.' },
        at: () => shown('.modal-back .modal .btn.primary') ?? shown('.ux2-publish'),
        done: () => {
          const p = project();
          const id = template()?.id;
          return !!p && !!id && !!publishState(p, id).published && !publishState(p, id).draft;
        },
      },
      {
        say: { fr: 'Publié : l’Opérateur a ce modèle, gardé en version dans l’historique.', en: 'Published: the Operator has this template, kept as a version in the history.' },
        at: '.history-menu',
        done: 'next',
      },
    ],
  },
  {
    id: 'designer.air.versions',
    cat: 'designer',
    chapter: 'air',
    title: { fr: 'Versions et retour arrière', en: 'Versions and going back' },
    setup: { kind: 'designer' },
    steps: [
      addRect,
      {
        say: { fr: 'Ouvrez l’historique des versions.', en: 'Open the history of the versions.' },
        at: '.history-menu > .top-tool',
        done: () => !!shown('.history-pop'),
      },
      {
        say: { fr: 'Garder une version : tapez une note, puis Garder.', en: 'Keep a version: type a note, then Keep.' },
        before: () => void (versionsWas = versions()),
        at: () => shown('.modal-back .modal') ?? shown('.history-pop .pjp-keep'),
        done: () => versions() > versionsWas,
      },
      {
        say: { fr: 'Supprimez le rectangle : cliquez-le, puis Suppr.', en: 'Delete the rectangle: click it, then Delete.' },
        at: '.stage-holder',
        done: () => !hasLayer('rect'),
      },
      {
        say: { fr: 'Historique : survolez votre version, cliquez Restaurer. Le rectangle revient.', en: 'History: hover your version, click Restore. The rectangle comes back.' },
        at: () => shown('.modal-back .modal') ?? shown('.history-pop') ?? shown('.history-menu > .top-tool'),
        done: () => hasLayer('rect'),
      },
    ],
  },
];
