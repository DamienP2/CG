import type { Lesson } from './types';
import { addLesson } from './store';
import { layers, onAir, path, template, withText } from './probe';

/*
 * An example's tour: made for the example, on a training copy of it. In the
 * Designer: how it is made; in the Operator: driving it.
 */

export function designerTour(example: string, name: string): Lesson {
  const l: Lesson = {
    id: `tour.designer.${example}`,
    cat: 'designer',
    chapter: 'start',
    title: { fr: name, en: name },
    setup: { kind: 'designer', example },
    steps: [
      {
        say: { fr: 'Les modèles de l’exemple sont à gauche. Ouvrez-en un.', en: 'The example’s templates are on the left. Open one.' },
        at: '.template-item',
        done: () => !!template() && layers().length > 0,
      },
      {
        say: { fr: 'Ses calques sont dans la timeline. Cliquez-en un pour voir ses propriétés.', en: 'Its layers are in the timeline. Click one to see its properties.' },
        at: '.tl-label.layer',
        done: { click: '.tl-label.layer' },
      },
      {
        say: { fr: 'Appuyez sur K pour lire son animation.', en: 'Press K to play its animation.' },
        at: '.stage-frame',
        done: { key: 'k' },
      },
      {
        say: { fr: 'Logique : comment il réagit aux données et aux déclencheurs.', en: 'Logic: how it reacts to data and triggers.' },
        at: () => withText('button', /^\s*Logi/),
        done: 'next',
      },
      {
        say: { fr: 'Essayez-le : ouvrez l’Opérateur.', en: 'Try it: open the Operator.' },
        at: '.project-tabs button:nth-child(2)',
        done: () => /\/operator/.test(path()),
      },
      {
        say: { fr: 'F1 l’envoie à l’antenne d’entraînement. Rien ne part à l’antenne.', en: 'F1 takes it to the training air. Nothing goes on air.' },
        at: '.opx-btn.big.red',
        done: () => onAir() > 0,
      },
    ],
  };
  addLesson(l);
  return l;
}

export function operatorTour(example: string, name: string): Lesson {
  const l: Lesson = {
    id: `tour.operator.${example}`,
    cat: 'operator',
    chapter: 'start',
    title: { fr: name, en: name },
    setup: { kind: 'operator', example },
    steps: [
      {
        say: { fr: 'Choisissez un graphique dans la playlist.', en: 'Pick a graphic in the playlist.' },
        at: '.opx-gr',
        done: { click: '.opx-gr' },
      },
      {
        say: { fr: 'Ses valeurs sont ici : changez-en une.', en: 'Its values are here: change one.' },
        at: '.opx-var-val, .opx-values',
        done: 'next',
      },
      {
        say: { fr: 'F1 : à l’antenne. C’est une simulation, rien ne part à l’antenne.', en: 'F1: on air. It is a simulation, nothing goes on air.' },
        at: '.opx-btn.big.red',
        done: () => onAir() > 0,
      },
      {
        say: { fr: 'F3 : il sort.', en: 'F3: it goes out.' },
        done: () => onAir() === 0,
      },
    ],
  };
  addLesson(l);
  return l;
}
