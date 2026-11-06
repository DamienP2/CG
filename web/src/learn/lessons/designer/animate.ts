import type { Lesson, Step } from '../../types';
import { t, tc } from '../../../i18n';
import { designer, hasLayer, keyframes, layers, openTemplate, project, selected, shown, template, withText } from '../../probe';
import { useLearn } from '../../store';
import { designTemplates } from '../../../engine/drafts';
import { useClipboard } from '../../../designer/clipboard';
import { useDesigner } from '../../../designer/designerStore';
import type { Layer } from '../../../engine/types';

/** The layer a lesson works on (chosen when it starts). */
let target = '';
/** A layer made during the lesson. */
let fresh = '';
/** Values remembered when a step starts. */
let was: { n: number; s: string } = { n: 0, s: '' };

/** The training project's own template is open (not the one of the lesson before, still shown while the page loads). */
const ready = () => {
  const p = project();
  const id = template()?.id;
  return !!p && !!id && p.id === useLearn.getState().project && designTemplates(p).some((x) => x.id === id);
};
const byId = (id: string) => layers().find((l) => l.id === id);
/** The example's template open, and its first animated text as the layer to work on. */
function ensure(): Layer | undefined {
  if (project()?.id !== useLearn.getState().project) return undefined;
  if (!ready()) openTemplate(0);
  const l = byId(target);
  if (l) return l;
  const first = layers().find((x) => x.type === 'text' && keyframes(x) > 0);
  if (first) target = first.id;
  return first;
}
/** A layer's row in the timeline's list (left). */
function rowOf(id: string): HTMLElement | null {
  const rows = [...document.querySelectorAll<HTMLElement>('.tl-rows > .tl-row')];
  const i = rows.findIndex((r) => r.dataset.layer === id);
  return i < 0 ? null : (document.querySelectorAll<HTMLElement>('.tl-left > .tl-label')[i] ?? null);
}
/** A property row (Position…) under a layer unfolded in the timeline. */
function propRow(id: string, label: string): HTMLElement | null {
  for (let el = rowOf(id)?.nextElementSibling; el && !el.classList.contains('layer'); el = el.nextElementSibling)
    if (el.querySelector('.prop-name')?.textContent === label) return el as HTMLElement;
  return null;
}
/** The whole timeline: a ring that big puts the bubble at its top left, over the layers, clear of the menus opened on the tracks. */
const timeline = () => shown('.tl-scroll');
/** A section of the properties (its title as shown), open or not. */
function twirl(title: string, open?: boolean): HTMLElement | null {
  for (const b of document.querySelectorAll<HTMLElement>(`.pp-group${open ? '.open' : ''} > header .pp-twirl`))
    if (b.textContent?.trim() === title && b.getClientRects().length) return b;
  return null;
}
/** The control of a settings row by its label (in a section). */
function row(label: string, section?: string): HTMLElement | null {
  const root = section ? twirl(section, true)?.closest('.pp-group') : document;
  for (const r of root?.querySelectorAll<HTMLElement>('.wk-row') ?? []) if (r.querySelector('.prop-label')?.textContent?.trim() === label && r.getClientRects().length) return r.querySelector<HTMLElement>('.wk-ctl');
  return null;
}
const rect = () => selected().find((l) => l.type === 'rect');
const outMarker = () => template()?.markers.find((m) => m.kind === 'out');
/** The easing of the stretch clicked in the timeline. */
function segEasing(): string {
  const s = designer().selectedSegment;
  const l = s && byId(s.layerId);
  return (s && l?.tracks[s.props[0]]?.find((k) => k.frame === s.frame)?.easing.type) ?? '';
}
type Counter = Layer & { to?: string; transition?: string };
const counter = () => layers().find((l) => l.type === 'counter') as Counter | undefined;

/** Unfolds the layer worked on: the first step of the example's lessons. */
const unfold: Step = {
  say: { fr: 'Cliquez la flèche ▸ de ce calque : ses propriétés et leurs images clés.', en: 'Click the ▸ arrow of this layer: its properties and their keyframes.' },
  // Folded to begin with (the rows unfolded stay so from a lesson to the next).
  before: () => void ((target = ''), useDesigner.setState({ expanded: {} }), ensure()),
  at: () => {
    const l = ensure();
    return l ? rowOf(l.id)?.querySelector('.twirl') : null;
  },
  done: () => !!designer().expanded[ensure()?.id ?? '-'],
};
const addRect: Step = {
  say: { fr: 'Cliquez Rectangle, en bas à gauche.', en: 'Click Rectangle, bottom left.' },
  at: () => shown(`.tl-insert .tool[title="${t('Rectangle')}"]`),
  done: () => ready() && hasLayer('rect'),
};
const play: Step = {
  say: { fr: 'K ou ▶ : lecture.', en: 'K or ▶: play.' },
  at: '.transport .play',
  done: () => designer().playing,
};

/** designer › animate. */
export const lessons: Lesson[] = [
  {
    id: 'designer.animate.keyframes',
    cat: 'designer',
    chapter: 'animate',
    title: { fr: 'Images clés', en: 'Keyframes' },
    setup: { kind: 'designer' },
    steps: [
      addRect,
      {
        say: { fr: 'Allez au début : ⏮ ou la touche Origine.', en: 'Go to the start: ⏮ or the Home key.' },
        at: () => shown(`.transport .icon-btn[title="${t('Go to start (Home)')}"]`),
        done: () => designer().frame === 0,
      },
      {
        say: { fr: 'Cliquez le ◇ de Position, à droite : une image clé.', en: 'Click the ◇ of Position, on the right: a keyframe.' },
        at: () => withText('.pp-row', t('Position'))?.querySelector('.pp-tl'),
        done: () => (rect()?.tracks.x?.length ?? 0) >= 1,
      },
      {
        say: { fr: 'Cliquez plus loin sur la règle du temps : la tête de lecture avance.', en: 'Click further on the time ruler: the playhead moves on.' },
        at: '.tl-time',
        done: () => designer().frame >= Math.min(...(rect()?.tracks.x ?? [{ frame: 0 }]).map((k) => k.frame)) + 10,
      },
      {
        say: { fr: 'Glissez le rectangle : une 2ᵉ image clé se pose. K pour voir.', en: 'Drag the rectangle: a 2nd keyframe is set. K to watch.' },
        at: '.tf-frame polygon, .stage-frame',
        done: () => (['x', 'y'] as const).some((p) => new Set((rect()?.tracks[p] ?? []).map((k) => k.value)).size >= 2),
      },
    ],
  },
  {
    id: 'designer.animate.easing',
    cat: 'designer',
    chapter: 'animate',
    title: { fr: 'Courbes d’accélération', en: 'Easing curves' },
    setup: { kind: 'designer', example: 'ex-01-journal-televise' },
    steps: [
      unfold,
      {
        say: { fr: 'Cliquez le trait entre deux losanges : un passage de l’animation.', en: 'Click the line between two diamonds: a stretch of the animation.' },
        at: '.kf-seg',
        done: () => !!designer().selectedSegment,
      },
      {
        say: { fr: 'À droite, choisissez une courbe, par ex. Rebond.', en: 'On the right, choose a curve, e.g. Bounce.' },
        at: '.easing-picks',
        before: () => void (was = { n: 0, s: segEasing() }),
        done: () => !!segEasing() && segEasing() !== was.s,
      },
      { ...play, say: { fr: 'K ou ▶ : lecture. Regardez la différence.', en: 'K or ▶: play. See the difference.' } },
    ],
  },
  {
    id: 'designer.animate.markers',
    cat: 'designer',
    chapter: 'animate',
    title: { fr: 'IN, OUT et pauses', en: 'IN, OUT and pauses' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'IN (vert) : l’entrée. ∞ : le graphique reste là à l’antenne. OUT (rouge) : la sortie.', en: 'IN (green): the way in. ∞: the graphic holds there on air. OUT (red): the way out.' },
        at: () => (ready() ? shown('.tl-marks') : null),
        done: 'next',
      },
      {
        say: { fr: 'Glissez ∞ vers la droite : l’entrée dure plus longtemps.', en: 'Drag ∞ to the right: the way in lasts longer.' },
        at: '.tl-marker.onair',
        before: () => void (was = { n: outMarker()?.frame ?? 0, s: '' }),
        done: () => (outMarker()?.frame ?? 0) > was.n + 2,
      },
      {
        say: { fr: 'Cliquez ∞, puis Sortie : Après. Il sortira seul après 5 s.', en: 'Click ∞, then Out: After. It goes out by itself after 5 s.' },
        at: () => shown('.marker-editor') ?? shown('.tl-marker.onair'),
        done: () => outMarker()?.resume?.type === 'after',
      },
      {
        say: { fr: 'Clic droit sur la règle du temps › Ajouter une pause ici : l’animation y attend Continuer (F2).', en: 'Right-click the time ruler › Add a pause here: the animation waits there for Continue (F2).' },
        at: timeline,
        done: () => !!template()?.markers.some((m) => m.kind === 'pause'),
      },
    ],
  },
  {
    id: 'designer.animate.copy',
    cat: 'designer',
    chapter: 'animate',
    title: { fr: 'Copier une animation', en: 'Copy an animation' },
    setup: { kind: 'designer', example: 'ex-01-journal-televise' },
    steps: [
      unfold,
      {
        say: { fr: 'Survolez la ligne Position : cliquez son icône Copier l’animation.', en: 'Hover the Position row: click its Copy the animation icon.' },
        before: () => useClipboard.setState({ animation: null }),
        // Its buttons show on hover: the row.
        at: () => propRow(target, t('Position')),
        done: () => !!useClipboard.getState().animation,
      },
      {
        say: { fr: 'Cliquez Rectangle : un calque sans animation.', en: 'Click Rectangle: a layer with no animation.' },
        before: () => void (fresh = ''),
        at: () => shown(`.tl-insert .tool[title="${t('Rectangle')}"]`),
        done: () => {
          const r = selected().find((l) => l.type === 'rect' && !keyframes(l));
          if (r) fresh = r.id;
          return !!r;
        },
      },
      {
        say: { fr: 'Cliquez la flèche ▸ du rectangle.', en: 'Click the ▸ arrow of the rectangle.' },
        at: () => rowOf(fresh)?.querySelector('.twirl'),
        done: () => !!designer().expanded[fresh],
      },
      {
        say: { fr: 'Survolez sa ligne Position : cliquez Coller l’animation. K : il bouge comme l’autre.', en: 'Hover its Position row: click Paste the animation. K: it moves like the other one.' },
        at: () => propRow(fresh, t('Position')),
        done: () => keyframes(byId(fresh)) > 0,
      },
    ],
  },
  {
    id: 'designer.animate.loop',
    cat: 'designer',
    chapter: 'animate',
    title: { fr: 'Mouvement en boucle', en: 'Looping movement' },
    setup: { kind: 'designer' },
    steps: [
      addRect,
      {
        say: { fr: 'Clic droit sur le rectangle, dans le canvas › Animation…', en: 'Right-click the rectangle, in the canvas › Animation…' },
        // Round the whole canvas: the bubble at its top left, clear of the menu.
        at: '.stage-wrap',
        done: () => !!shown('.an-dialog'),
      },
      {
        say: { fr: 'Onglet Boucle : cliquez Flottement.', en: 'Loop tab: click Float.' },
        // The tab, then the card.
        at: () => (withText('.an-tabs button.on', t('Loop')) && withText('.an-card', t('Float'))) || withText('.an-tabs button', t('Loop')),
        // A loop chosen (not « None »).
        done: () => {
          const on = withText('.an-tabs button.on', t('Loop')) && shown('.an-card.on');
          return !!on && on.textContent?.trim() !== t('None');
        },
      },
      {
        say: { fr: 'Cliquez Appliquer.', en: 'Click Apply.' },
        at: '.an-dialog footer .btn.primary',
        done: () => !!(rect() as (Layer & { motion?: unknown }) | undefined)?.motion,
      },
      { ...play, say: { fr: 'K ou ▶ : il flotte, même quand le graphique reste à l’antenne.', en: 'K or ▶: it floats, even while the graphic holds on air.' } },
    ],
  },
  {
    id: 'designer.animate.value-change',
    cat: 'designer',
    chapter: 'animate',
    title: { fr: 'Animation au changement de valeur', en: 'Animation when a value changes' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez + (Widgets), puis Compteur.', en: 'Click + (Widgets), then Counter.' },
        at: () => withText('.add-menu button', tc('widget', 'Counter')) ?? shown('.tl-corner .opx-add'),
        done: () => ready() && hasLayer('counter'),
      },
      {
        say: { fr: 'À droite, ouvrez Transition.', en: 'On the right, open Transition.' },
        at: () => twirl(t('Transition')),
        done: () => !!twirl(t('Transition'), true),
      },
      {
        say: { fr: 'Type : Retournement.', en: 'Type: Flip.' },
        at: () => row(t('Type'), t('Transition')),
        done: () => counter()?.transition === 'flip',
      },
      {
        say: { fr: 'Valeur : tapez un autre nombre. Il s’anime vers lui, comme à l’antenne.', en: 'Value: type another number. It moves to it, as on air.' },
        at: () => row(t('Value')),
        before: () => void (was = { n: 0, s: counter()?.to ?? '' }),
        done: () => {
          const v = counter()?.to ?? '';
          return v !== was.s && /\d/.test(v);
        },
      },
      {
        say: { fr: 'Tapez d’autres nombres : chaque nouvelle valeur se retourne, à l’antenne aussi.', en: 'Type other numbers: each new value flips, on air too.' },
        at: '.tf-frame polygon',
        done: 'next',
      },
    ],
  },
  {
    id: 'designer.animate.delete-keys',
    cat: 'designer',
    chapter: 'animate',
    title: { fr: 'Supprimer des images clés', en: 'Delete keyframes' },
    setup: { kind: 'designer', example: 'ex-01-journal-televise' },
    steps: [
      unfold,
      {
        say: { fr: 'Cliquez un losange ◆ : il est sélectionné.', en: 'Click a diamond ◆: it is selected.' },
        at: '.tl-row.prop .kf',
        done: () => designer().selectedKeys.length > 0,
      },
      {
        say: { fr: 'Suppr : il est effacé.', en: 'Delete: it is erased.' },
        before: () => void (was = { n: keyframes(byId(target)), s: '' }),
        at: '.tl-row.prop .kf.sel',
        done: () => keyframes(byId(target)) < was.n,
      },
      {
        say: { fr: 'Tout le calque : clic droit sur sa barre, à droite › Effacer les images clés de…, puis Effacer.', en: 'The whole layer: right-click its bar, on the right › Erase the keyframes of…, then Erase.' },
        // Its name: the menu opens on the bar, clear of the bubble.
        at: () => rowOf(target),
        done: () => keyframes(byId(target)) === 0,
      },
    ],
  },
];
