import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { hasLayer, prop, selected, shown } from '../../probe';

/** Where the layer was when the step began. */
let from = { x: 0, y: 0 };

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
        at: () => shown(`.tl-insert .tool[title="${t('Rectangle')}"]`),
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
];
