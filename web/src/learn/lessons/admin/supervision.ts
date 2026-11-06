import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { onPage, shown, withText } from '../../probe';

/** Unsaved changes on the page (its bar « Discard / Save »). */
const dirty = () => !!shown('.save-bar.show');
/** A tab of the page, by its exact label; open or not. */
const tab = (label: string) => [...document.querySelectorAll<HTMLElement>('.sys-tabs [role=tab]')].find((b) => b.querySelector('span')?.textContent?.trim() === label && b.getClientRects().length);
const tabOn = (label: string) => tab(label)?.getAttribute('aria-selected') === 'true';
/** A settings card, by its title. */
const card = (title: string) => withText('.set-card', title);

/** admin › supervision. */
export const lessons: Lesson[] = [
  {
    id: 'admin.supervision.performance',
    cat: 'admin',
    chapter: 'supervision',
    title: { fr: 'Performances', en: 'Performance' },
    setup: { kind: 'page', path: '/system/performance' },
    steps: [
      {
        say: { fr: 'Chaque canal : images par seconde, horloge, graphiques à l’antenne.', en: 'Each channel: frames per second, clock, graphics on air.' },
        at: '.perf-channel',
        done: 'next',
      },
      {
        say: { fr: 'Temps de rendu : sous la durée d’une image, tout va bien.', en: 'Render time: under one frame’s time, all is well.' },
        at: '.perf-stats, .perf-channel',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Capacité.', en: 'Click Capacity.' },
        at: () => tab(t('Capacity')),
        done: () => tabOn(t('Capacity')),
      },
      {
        say: { fr: 'Ce que la machine peut encore prendre : les cœurs libres.', en: 'What the machine can still take: the free cores.' },
        at: '.perf-budget',
        done: 'next',
      },
    ],
  },
  {
    id: 'admin.supervision.health',
    cat: 'admin',
    chapter: 'supervision',
    title: { fr: 'Santé et journaux', en: 'Health and logs' },
    setup: { kind: 'page', path: '/system/health' },
    steps: [
      {
        say: { fr: 'En service depuis, arrêts, erreurs, disque : l’état du serveur.', en: 'Up since, crashes, errors, disk: the server’s state.' },
        at: '.hl-cards',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Journal.', en: 'Click Journal.' },
        at: () => tab(t('Journal')),
        done: () => tabOn(t('Journal')),
      },
      {
        say: { fr: 'Filtrez : les erreurs seules, par exemple.', en: 'Filter: errors only, for instance.' },
        at: '.hl-bar .segmented',
        done: { click: '.hl-bar .segmented button' },
      },
      {
        say: { fr: 'Cliquez Journal en direct : ce qui arrive, à l’instant.', en: 'Click Live log: what happens, right now.' },
        at: () => tab(t('Live log')),
        done: () => tabOn(t('Live log')),
      },
      {
        say: { fr: 'Un souci ? Exportez pour le support et envoyez le zip.', en: 'A problem? Export for the support and send the zip.' },
        at: '.health-page .settings-head a.btn',
        done: 'next',
      },
    ],
  },
  {
    id: 'admin.supervision.asrun',
    cat: 'admin',
    chapter: 'supervision',
    title: { fr: 'Rapport de diffusion', en: 'Broadcast report' },
    setup: { kind: 'page', path: '/system/asrun' },
    steps: [
      {
        say: { fr: 'Tout ce qui est passé à l’antenne : quoi, quand, par qui.', en: 'All that went on air: what, when, by whom.' },
        at: () => shown('.asr-table') ?? shown('.asr-toolbar'),
        done: 'next',
      },
      {
        say: { fr: 'Période : ouvrez la liste.', en: 'Period: open the list.' },
        at: () => shown(`.asr-drop[title="${t('Period')}"]`),
        done: () => !!shown('.dd-list'),
      },
      {
        say: { fr: 'Choisissez une période.', en: 'Choose a period.' },
        at: '.dd-list',
        done: () => !shown('.dd-list'),
      },
      {
        say: { fr: 'TAKE : seulement les passages à l’antenne.', en: 'TAKE: only what went on air.' },
        at: () => withText('.asr-chip', 'TAKE'),
        done: () => !!withText('.asr-chip.on', 'TAKE'),
      },
      {
        say: { fr: 'CSV ou PDF : le rapport à envoyer.', en: 'CSV or PDF: the report to send.' },
        at: '.asr-head-actions',
        done: 'next',
      },
    ],
  },
  {
    id: 'admin.supervision.time',
    cat: 'admin',
    chapter: 'supervision',
    title: { fr: 'Heure et synchro', en: 'Time and sync' },
    setup: { kind: 'page', path: '/system/time' },
    steps: [
      {
        say: { fr: 'L’heure du serveur. NTP la garde juste.', en: 'The server’s time. NTP keeps it right.' },
        at: '.time-now',
        done: 'next',
      },
      {
        say: { fr: 'Timecode : l’horloge des prises à heure fixe. Ouvrez la liste.', en: 'Timecode: the clock of timed takes. Open the list.' },
        at: () => shown(`.dd-btn[title="${t('Takes at a timecode')}"]`),
        done: () => !!shown('.dd-list'),
      },
      {
        say: { fr: 'L’heure du serveur, ou le timecode d’une entrée SDI. Échap : fermer.', en: 'The server’s time, or an SDI input’s timecode. Esc: close.' },
        at: '.dd-list',
        done: () => !shown('.dd-list'),
      },
      {
        say: { fr: 'Référence d’horloge : PTP ou genlock DeckLink cale l’image.', en: 'Clock reference: PTP or DeckLink genlock locks the picture.' },
        at: () => card(t('Clock reference')),
        done: 'next',
      },
      {
        say: { fr: 'Changé ? Abandonner : rien n’est changé.', en: 'Changed? Discard: nothing changes.' },
        at: '.save-bar.show .btn:not(.primary)',
        done: () => !dirty(),
      },
    ],
  },
  {
    id: 'admin.supervision.updates',
    cat: 'admin',
    chapter: 'supervision',
    title: { fr: 'Mises à jour', en: 'Updates' },
    setup: { kind: 'page', path: '/system/updates' },
    steps: [
      {
        say: { fr: 'La version installée.', en: 'The installed version.' },
        at: '.update-version',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Nouveautés pour les lire.', en: 'Click What’s new to read it.' },
        at: '.update-notes summary',
        done: () => !document.querySelector('.update-notes') || !!document.querySelector('.update-notes[open]'),
      },
      {
        say: { fr: 'Installer redémarre le moteur : jamais pendant une émission !', en: 'Install restarts the engine: never during a show!' },
        at: '.update-latest',
        done: 'next',
      },
      {
        say: { fr: 'Les versions : on peut aussi revenir en arrière.', en: 'The versions: you can also go back.' },
        at: '.update-rows',
        done: 'next',
      },
    ],
  },
  {
    id: 'admin.supervision.maintenance',
    cat: 'admin',
    chapter: 'supervision',
    title: { fr: 'Sauvegarde et maintenance', en: 'Backup and maintenance' },
    setup: { kind: 'page', path: '/system/maintenance' },
    steps: [
      {
        say: { fr: 'Dossier des données : tout Strata est là. Copiez-le pour sauvegarder.', en: 'Data folder: all of Strata is there. Copy it to back up.' },
        at: '.sys-list code',
        done: 'next',
      },
      {
        say: { fr: 'Redémarrer le moteur : hors antenne seulement.', en: 'Restart engine: off air only.' },
        at: '.settings-head .btn',
        done: 'next',
      },
      {
        say: { fr: 'Un projet seul : cliquez Projets.', en: 'One project alone: click Projects.' },
        at: () => withText('.home-tabs > button', t('Projects')),
        done: () => onPage(/^\/projects/),
      },
      {
        say: { fr: 'Cliquez ⋯ d’un projet.', en: 'Click a project’s ⋯.' },
        at: () => shown(`.project-head .icon-btn[title="${t('More')}"]`),
        done: () => !!shown('.project-menu'),
      },
      {
        say: { fr: 'Exporter : un zip à garder. Échap : fermer.', en: 'Export: a zip to keep. Esc: close.' },
        at: () => shown('.project-menu a[href*="export?full"]') ?? shown('.project-menu'),
        done: () => !shown('.project-menu'),
      },
    ],
  },
];
