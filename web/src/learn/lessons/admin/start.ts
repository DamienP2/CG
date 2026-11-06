import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { onPage, shown, withText } from '../../probe';

/** A button of the main menu, by its label. */
const menu = (label: string) => withText('.home-tabs > button, .ux1-navgroup > button', label);

/** admin › start. */
export const lessons: Lesson[] = [
  {
    id: 'admin.start.first-steps',
    cat: 'admin',
    chapter: 'start',
    title: { fr: 'Premiers pas', en: 'First steps' },
    setup: { kind: 'page', path: '/projects' },
    steps: [
      {
        say: { fr: 'Projets : un pack de graphiques par émission.', en: 'Projects: one pack of graphics per show.' },
        at: () => menu(t('Projects')),
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Diffusion : sorties, entrées, tracking.', en: 'Click Broadcast: outputs, inputs, tracking.' },
        at: '.ux1-navgroup > button',
        done: () => !!shown('.ux1-navmenu'),
      },
      {
        say: { fr: 'Sorties, entrées, caméras. Cliquez Flux sorties.', en: 'Outputs, inputs, cameras. Click Output streams.' },
        at: '.ux1-navmenu',
        done: () => onPage(/^\/outputs/),
      },
      {
        say: { fr: 'Système : utilisateurs, matériel, réglages. Cliquez-le.', en: 'System: users, hardware, settings. Click it.' },
        at: () => menu(t('System')),
        done: () => onPage(/^\/system/),
      },
      {
        say: { fr: '? : les leçons, à tout moment.', en: '?: the lessons, at any time.' },
        at: '.learn-help',
        done: 'next',
      },
    ],
  },
  {
    id: 'admin.start.user-menu',
    cat: 'admin',
    chapter: 'start',
    title: { fr: 'Langue, thème, raccourcis', en: 'Language, theme, shortcuts' },
    setup: { kind: 'page', path: '/projects' },
    steps: [
      {
        say: { fr: 'Cliquez votre nom, en haut à droite.', en: 'Click your name, top right.' },
        at: '.ux1-user-btn',
        done: () => !!shown('.ux1-umenu'),
      },
      {
        say: { fr: 'Langue et thème : ici, gardés pour vous. Cliquez Raccourcis clavier.', en: 'Language and theme: here, kept for you. Click Keyboard shortcuts.' },
        at: '.ux1-umenu .ux1-mi:not(.danger)',
        done: () => !!shown('.ux1-sc'),
      },
      {
        say: { fr: 'Les touches de l’Opérateur. ? les montre partout. Échap : fermer.', en: 'The Operator’s keys. ? shows them anywhere. Esc: close.' },
        at: '.ux1-sc',
        done: () => !shown('.ux1-sc'),
      },
    ],
  },
  {
    id: 'admin.start.dashboard',
    cat: 'admin',
    chapter: 'start',
    title: { fr: 'Le tableau de bord', en: 'The dashboard' },
    setup: { kind: 'page', path: '/projects' },
    steps: [
      {
        say: { fr: 'La pastille dit l’état du serveur. Cliquez-la.', en: 'The pill tells the server’s state. Click it.' },
        at: '.ux1-pill',
        done: () => onPage(/^\/system\/performance/),
      },
      {
        say: { fr: 'Processeurs, mémoire : la charge de la machine.', en: 'Processors, memory: the machine’s load.' },
        at: '.perf-tiles',
        done: 'next',
      },
      {
        say: { fr: 'Avertissements : ce qui ne va pas, en clair.', en: 'Warnings: what is wrong, in plain words.' },
        at: '.perf-allgood, .perf-warnings',
        done: 'next',
      },
      {
        say: { fr: 'Machine chargée : la pastille montre le CPU, en orange.', en: 'A loaded machine: the pill shows the CPU, in orange.' },
        at: '.ux1-pill',
        done: 'next',
      },
    ],
  },
];
