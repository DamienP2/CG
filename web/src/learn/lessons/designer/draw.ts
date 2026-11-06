import type { Lesson } from '../../types';
import type { Layer } from '../../../engine/types';
import { propValue } from '../../../engine/evaluate';
import { t, tc } from '../../../i18n';
import { designer, hasLayer, layers, layersOf, prop, selected, shown, withText } from '../../probe';

/** Where the layer was when the step began. */
let from = { x: 0, y: 0 };
/** A value of the layer when the step began (to see it change). */
let was = '';
/** How many points the path had when the step began. */
let count = 0;

/** A setting of a layer that is not an animated property (`sides`, `fillStyle`…). */
const attr = (l: Layer | undefined, k: string): unknown => (l as unknown as Record<string, unknown> | undefined)?.[k];
/** A property's value at the playhead, as text (a colour too). */
const value = (l: Layer | undefined, p: Parameters<typeof prop>[1]) => (l ? JSON.stringify(propValue(l, p, designer().frame)) : '');
/** The first layer of a type. */
const first = (type: string): Layer | undefined => layersOf(type)[0];
/** A button by its tip (`title`, moved to `data-tip` by the tooltips once hovered). */
const tip = (sel: string, name: string) => `${sel}[title="${name}"], ${sel}[data-tip="${name}"]`;
/** A tool of the bar above the layers, by its name. */
const tool = (name: string) => () => shown(tip('.tl-insert .tool', name));

/** Rows already brought into view once (the person may scroll away after). */
const scrolled = new WeakSet<Element>();
/** Brought into the panel's view, once. */
function inView(el: HTMLElement): HTMLElement {
  if (!scrolled.has(el)) {
    scrolled.add(el);
    el.scrollIntoView({ block: 'nearest' });
  }
  return el;
}

/**
 * A row of the right panel (its label), inside the sections `path`; while a
 * section is closed, its header (to open it).
 */
function row(path: string[], label: string): HTMLElement | null {
  let scope: Element = document.querySelector('.panel.right') ?? document.body;
  for (const title of path) {
    const head = [...scope.querySelectorAll<HTMLElement>('.pp-twirl')].find((b) => b.textContent?.trim() === title && b.getClientRects().length);
    if (!head) return null;
    if (head.getAttribute('aria-expanded') !== 'true') return inView(head);
    scope = head.closest('section') ?? scope;
  }
  for (const r of scope.querySelectorAll<HTMLElement>('.row, .pp-row')) {
    const l = r.querySelector('.prop-label, .pp-label');
    if (l?.textContent?.trim() === label && r.getClientRects().length) return inView(r);
  }
  return null;
}

/** A layer's row in the timeline, by its type. */
function timelineRow(type: string): HTMLElement | null {
  const l = first(type);
  if (!l) return null;
  for (const el of document.querySelectorAll<HTMLElement>('.tl-label.layer')) if (el.querySelector('.layer-name')?.textContent === l.name && el.getClientRects().length) return el;
  return null;
}

/** The root layers' order. */
const order = () =>
  layers()
    .filter((l) => !l.parent)
    .map((l) => l.id)
    .join();

/** The selected layer's box lines up with another layer's (an edge or the centre). */
function aligned(): boolean {
  const l = selected()[0];
  if (!l) return false;
  const lines = (o: Layer) => ({
    x: [prop(o, 'x'), prop(o, 'x') + prop(o, 'width') / 2, prop(o, 'x') + prop(o, 'width')],
    y: [prop(o, 'y'), prop(o, 'y') + prop(o, 'height') / 2, prop(o, 'y') + prop(o, 'height')],
  });
  const me = lines(l);
  return layers().some((o) => {
    if (o.id === l.id || o.parent) return false;
    const it = lines(o);
    return (['x', 'y'] as const).some((a) => me[a].some((v) => it[a].some((w) => Math.abs(v - w) < 0.5)));
  });
}

/** The horizontal guides on the stage, in pixels of the picture (their label, shown on hover). */
const guidesY = () => [...document.querySelectorAll('.guide.h span')].map((s) => Number(s.textContent)).filter((v) => Number.isFinite(v));

/** designer › draw. */
export const lessons: Lesson[] = [
  {
    id: 'designer.draw.first-layer',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Dessiner et tourner un calque', en: 'Draw and turn a layer' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Ajoutez un rectangle : cliquez Rectangle.', en: 'Add a rectangle: click Rectangle.' },
        at: tool(t('Rectangle')),
        done: () => hasLayer('rect'),
      },
      {
        say: { fr: 'Glissez-le dans le canvas pour le déplacer.', en: 'Drag it in the canvas to move it.' },
        at: '.tf-frame polygon, .stage-frame',
        before: () => {
          const l = selected()[0];
          from = { x: prop(l, 'x'), y: prop(l, 'y') };
        },
        done: () => selected().some((l) => Math.hypot(prop(l, 'x') - from.x, prop(l, 'y') - from.y) > 20),
      },
      {
        say: { fr: 'Tirez le rond au bout de la tige pour le tourner. Shift : par 15°.', en: 'Drag the knob at the end of the stalk to turn it. Shift: by 15°.' },
        at: '.tf-knob',
        done: () => selected().some((l) => Math.abs(prop(l, 'rotation')) >= 10),
      },
      {
        say: { fr: 'Le ↺ de Rotation, à droite, remet 0°.', en: 'The ↺ of Rotation, on the right, puts 0° back.' },
        at: '.pp-reset.on',
        done: () => selected().some((l) => Math.abs(prop(l, 'rotation')) < 0.01),
      },
    ],
  },
  {
    id: 'designer.draw.shapes',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Formes : rectangle, ellipse, polygone', en: 'Shapes: rectangle, ellipse, polygon' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Rectangle, puis tapez 40 dans Arrondi : ses coins s’arrondissent.', en: 'Click Rectangle, then type 40 in Radius: its corners round off.' },
        at: () => (hasLayer('rect') ? row([t('Shape')], t('Radius')) : tool(t('Rectangle'))()),
        done: () => layersOf('rect').some((l) => prop(l, 'cornerRadius') > 0),
      },
      {
        say: { fr: 'Cliquez Ellipse, puis Moitié : un demi-disque.', en: 'Click Ellipse, then Half: half a disc.' },
        at: () => (hasLayer('ellipse') ? row([t('Shape')], tc('ellipse', 'Quick')) : tool(t('Ellipse'))()),
        done: () => layersOf('ellipse').some((l) => Math.abs(prop(l, 'arcEnd') - prop(l, 'arcStart')) < 359),
      },
      {
        say: { fr: 'Cliquez Polygone.', en: 'Click Polygon.' },
        at: tool(t('Polygon')),
        done: () => hasLayer('polygon'),
      },
      {
        say: { fr: 'Côtés : tapez 8, puis Entrée.', en: 'Sides: type 8, then Enter.' },
        at: () => row([t('Shape')], t('Sides')),
        done: () => layersOf('polygon').some((l) => (attr(l, 'sides') ?? 5) !== 5),
      },
      {
        say: { fr: 'Activez Étoile : une étoile à 8 branches.', en: 'Turn Star on: an 8-pointed star.' },
        at: () => row([t('Shape')], t('Star')),
        done: () => layersOf('polygon').some((l) => !!attr(l, 'star')),
      },
    ],
  },
  {
    id: 'designer.draw.pen',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Plume et tracés', en: 'Pen and paths' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Plume : un tracé courbe.', en: 'Click Pen: a curved path.' },
        at: tool(t('Pen')),
        done: () => hasLayer('pen'),
      },
      {
        say: { fr: 'Tirez un de ses points sur le canvas.', en: 'Drag one of its points on the canvas.' },
        at: '.wk-handle',
        before: () => void (was = JSON.stringify(attr(first('pen'), 'points'))),
        done: () => JSON.stringify(attr(first('pen'), 'points')) !== was,
      },
      {
        say: { fr: 'Outil : ✚ Ajouter, puis cliquez dans son cadre : un point de plus.', en: 'Tool: ✚ Add, then click inside its frame: one more point.' },
        at: () => shown('.wk-catch') ?? row([t('Path')], t('Tool')),
        before: () => void (count = ((attr(first('pen'), 'points') as unknown[] | undefined) ?? []).length),
        done: () => ((attr(first('pen'), 'points') as unknown[] | undefined) ?? []).length > count,
      },
      {
        say: { fr: 'Activez Fermé : le tracé se referme.', en: 'Turn Closed on: the path closes.' },
        at: () => row([t('Path')], t('Closed')),
        done: () => !!attr(first('pen'), 'closed'),
      },
    ],
  },
  {
    id: 'designer.draw.colors',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Couleurs et dégradés', en: 'Colours and gradients' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Rectangle.', en: 'Click Rectangle.' },
        at: tool(t('Rectangle')),
        done: () => hasLayer('rect'),
      },
      {
        say: { fr: 'Remplissage › Couleur : cliquez la pastille, choisissez une teinte.', en: 'Fill › Color: click the swatch, pick a hue.' },
        at: () => shown('.cp-pop') ?? row([t('Fill')], t('Color')),
        before: () => void (was = value(first('rect'), 'fill')),
        done: () => value(first('rect'), 'fill') !== was,
      },
      {
        say: { fr: 'Type : Linéaire. Un dégradé.', en: 'Type: Linear. A gradient.' },
        at: () => row([t('Fill')], t('Type')),
        done: () => (attr(first('rect'), 'fillStyle') as { kind?: string } | undefined)?.kind === 'linear',
      },
      {
        say: { fr: 'Changez la couleur À : la fin du dégradé.', en: 'Change the To colour: the end of the gradient.' },
        at: () => shown('.cp-pop') ?? row([t('Fill')], t('To')),
        before: () => void (was = value(first('rect'), 'fill2')),
        done: () => value(first('rect'), 'fill2') !== was,
      },
      {
        say: { fr: 'Angle : tapez 0, puis Entrée. Il va de bas en haut.', en: 'Angle: type 0, then Enter. It goes from bottom to top.' },
        at: () => row([t('Fill')], t('Angle')),
        done: () => ((attr(first('rect'), 'fillStyle') as { angle?: number } | undefined)?.angle ?? 90) !== 90,
      },
    ],
  },
  {
    id: 'designer.draw.stroke-shadow',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Contour et ombre', en: 'Stroke and shadow' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Rectangle.', en: 'Click Rectangle.' },
        at: tool(t('Rectangle')),
        done: () => hasLayer('rect'),
      },
      {
        say: { fr: 'Ouvrez Contour et activez-le.', en: 'Open Stroke and turn it on.' },
        at: () => row([t('Stroke')], t('Stroke')),
        done: () => prop(first('rect'), 'strokeWidth') > 0,
      },
      {
        say: { fr: 'Style : Tirets.', en: 'Style: Dashes.' },
        at: () => row([t('Stroke')], t('Style')),
        done: () => (attr(first('rect'), 'strokeStyle') as { dash?: string } | undefined)?.dash === 'dashed',
      },
      {
        say: { fr: 'Ouvrez Effets et activez Ombre.', en: 'Open Effects and turn Shadow on.' },
        at: () => row([t('Effects')], t('Shadow')),
        done: () => !!attr(first('rect'), 'dropShadow'),
      },
      {
        say: { fr: 'Décalage Y : tapez 20, puis Entrée. L’ombre descend.', en: 'Offset Y: type 20, then Enter. The shadow goes down.' },
        at: () => row([t('Effects')], t('Offset Y')),
        before: () => void (was = value(first('rect'), 'shadowY')),
        done: () => value(first('rect'), 'shadowY') !== was,
      },
    ],
  },
  {
    id: 'designer.draw.guides',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Repères et magnétisme', en: 'Guides and snapping' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Rectangle.', en: 'Click Rectangle.' },
        at: tool(t('Rectangle')),
        done: () => hasLayer('rect'),
      },
      {
        say: { fr: 'Tirez un repère depuis la règle du haut, vers le bas.', en: 'Pull a guide out of the top ruler, downwards.' },
        at: '.ruler-x',
        done: () => !!shown('.guide.h'),
      },
      {
        say: { fr: 'Glissez le rectangle vers le repère : il s’y colle. Alt : sans aimant.', en: 'Drag the rectangle to the guide: it snaps to it. Alt: no snapping.' },
        at: () => shown('.tf-frame polygon') ?? shown('.guide.h'),
        before: () => {
          const l = first('rect');
          from = { x: prop(l, 'x'), y: prop(l, 'y') };
        },
        done: () => {
          const l = first('rect');
          if (!l || Math.hypot(prop(l, 'x') - from.x, prop(l, 'y') - from.y) < 5) return false;
          const y = prop(l, 'y');
          const h = prop(l, 'height');
          return guidesY().some((g) => [y, y + h / 2, y + h].some((v) => Math.abs(v - g) < 1));
        },
      },
      {
        say: { fr: 'Double-cliquez le repère : il s’en va.', en: 'Double-click the guide: it goes away.' },
        at: '.guide.h',
        done: () => !shown('.guide.h'),
      },
    ],
  },
  {
    id: 'designer.draw.align',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Aligner et superposer', en: 'Align and stack' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez deux fois Rectangle.', en: 'Click Rectangle twice.' },
        at: tool(t('Rectangle')),
        done: () => hasLayer('rect', 2),
      },
      {
        say: { fr: 'Glissez le second : des lignes l’alignent sur le premier.', en: 'Drag the second one: lines line it up with the first.' },
        at: '.tf-frame polygon',
        before: () => {
          const l = selected()[0];
          from = { x: prop(l, 'x'), y: prop(l, 'y') };
        },
        done: () => selected().some((l) => Math.hypot(prop(l, 'x') - from.x, prop(l, 'y') - from.y) > 10) && aligned(),
      },
      {
        say: { fr: 'Le dernier ajouté passe devant. Clic droit dessus › Ordre › Arrière-plan.', en: 'The last one added is in front. Right-click it › Order › Send to back.' },
        at: () => withText('.clip-menu .ux2-submenu button', t('Send to back')) ?? withText('.clip-menu button', t('Order')) ?? shown('.tf-frame polygon'),
        before: () => void (was = order()),
        done: () => order() !== was,
      },
    ],
  },
  {
    id: 'designer.draw.folders',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Dossiers', en: 'Folders' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Nouveau dossier.', en: 'Click New folder.' },
        at: '.tl-insert .add-btn.folder',
        done: () => hasLayer('group'),
      },
      {
        say: { fr: 'Le dossier choisi, cliquez Rectangle : il va dedans.', en: 'With the folder chosen, click Rectangle: it goes inside.' },
        at: tool(t('Rectangle')),
        before: () => {
          const g = first('group');
          if (g && !selected().some((l) => l.type === 'group')) designer().select([g.id]);
        },
        done: () => layersOf('rect').some((l) => layersOf('group').some((g) => g.id === l.parent)),
      },
      {
        say: { fr: 'Cliquez l’icône du dossier : il replie ses calques.', en: 'Click the folder’s icon: it folds its layers.' },
        at: '.tl-label.folder .tl-fold',
        done: () => !!shown(tip('.tl-label.folder .tl-fold', t('Show its layers'))),
      },
      {
        say: { fr: 'Son œil cache tout ce qu’il contient.', en: 'Its eye hides all it holds.' },
        at: '.tl-label.folder .row-btn',
        done: () => layersOf('group').some((g) => !g.visible),
      },
    ],
  },
  {
    id: 'designer.draw.masks',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Masques', en: 'Masks' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Ellipse, puis Rectangle.', en: 'Click Ellipse, then Rectangle.' },
        at: () => (hasLayer('ellipse') ? tool(t('Rectangle'))() : tool(t('Ellipse'))()),
        done: () => hasLayer('ellipse') && hasLayer('rect'),
      },
      {
        say: { fr: 'Dans les calques, Shift-clic sur l’ellipse : les deux sont choisis.', en: 'In the layers, Shift-click the ellipse: both are chosen.' },
        at: () => timelineRow('ellipse'),
        done: () => selected().length >= 2,
      },
      {
        say: { fr: 'Clic droit › Utiliser comme masque. L’ellipse ne se voit plus que dans le rectangle.', en: 'Right-click › Use as mask. The ellipse now shows only inside the rectangle.' },
        at: () => withText('.clip-menu button', t('Use as mask')) ?? timelineRow('rect') ?? timelineRow('ellipse'),
        done: () => layersOf('group').some((g) => !!attr(g, 'mask')),
      },
      {
        say: { fr: 'Mode : Exclure. L’inverse : elle se voit hors du rectangle.', en: 'Mode: Exclude. The other way: it shows outside the rectangle.' },
        at: () => row([t('Mask')], t('Mode')),
        done: () => layersOf('group').some((g) => !!(attr(g, 'mask') as { exclude?: boolean } | undefined)?.exclude),
      },
    ],
  },
  {
    id: 'designer.draw.pseudo3d',
    cat: 'designer',
    chapter: 'draw',
    title: { fr: 'Pseudo-3D : inclinaison, perspective, épaisseur', en: 'Pseudo-3D: skew, perspective, thickness' },
    setup: { kind: 'designer' },
    steps: [
      {
        say: { fr: 'Cliquez Rectangle.', en: 'Click Rectangle.' },
        at: tool(t('Rectangle')),
        done: () => hasLayer('rect'),
      },
      {
        say: { fr: 'Inclinaison, X : tapez 20, puis Entrée. Il penche.', en: 'Skew, X: type 20, then Enter. It leans.' },
        at: () => row([t('Properties'), tc('section', 'Transform')], t('Skew')),
        done: () => Math.abs(prop(first('rect'), 'skewX')) + Math.abs(prop(first('rect'), 'skewY')) >= 1,
      },
      {
        say: { fr: 'Rotation 3D, Y : tapez 50. Il tourne dans la profondeur.', en: '3D rotation, Y: type 50. It turns in depth.' },
        at: () => row([t('Properties'), tc('section', 'Transform')], t('3D rotation')),
        done: () => Math.abs(prop(first('rect'), 'rotateX')) + Math.abs(prop(first('rect'), 'rotateY')) >= 5,
      },
      {
        say: { fr: 'Perspective : tapez 400. Plus petite, plus forte.', en: 'Perspective: type 400. Smaller is stronger.' },
        at: () => row([t('Properties'), tc('section', 'Transform')], t('Perspective')),
        done: () => Math.abs(prop(first('rect'), 'perspective') - 1200) >= 1,
      },
      {
        say: { fr: 'Épaisseur : tapez 80. Il prend du volume.', en: 'Thickness: type 80. It gets depth.' },
        at: () => row([t('Properties'), tc('section', 'Transform')], t('Thickness')),
        done: () => prop(first('rect'), 'depth') > 0,
      },
    ],
  },
];
