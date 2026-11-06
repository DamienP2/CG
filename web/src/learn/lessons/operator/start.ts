import type { Lesson } from '../../types';
import { onAir } from '../../probe';

/** operator › start. */
export const lessons: Lesson[] = [
  {
    id: 'operator.start.first-take',
    cat: 'operator',
    chapter: 'start',
    title: { fr: 'Premier passage à l’antenne', en: 'First time on air' },
    setup: { kind: 'operator', example: 'ex-01-journal-televise' },
    steps: [
      {
        say: { fr: 'Ici, tout est simulé : rien ne part à l’antenne. Cliquez un graphique de la playlist.', en: 'Here everything is simulated: nothing goes on air. Click a graphic of the playlist.' },
        at: '.opx-gr',
        done: { click: '.opx-gr' },
      },
      {
        say: { fr: 'F1 ou le bouton rouge : à l’antenne.', en: 'F1 or the red button: on air.' },
        at: '.opx-btn.big.red',
        done: () => onAir() > 0,
      },
      {
        say: { fr: 'F3 : il sort.', en: 'F3: it goes out.' },
        done: () => onAir() === 0,
      },
    ],
  },
];
