import type { Lesson } from '../../types';
import { t } from '../../../i18n';
import { onPage, shown, withText } from '../../probe';

/** Unsaved changes on the page (its bar « Discard / Apply »). */
const dirty = () => !!shown('.save-bar.show');
/** A tab of the page, by its label; open or not. */
const tab = (label: string) => withText('.sys-tabs [role=tab]', label);
const tabOn = (label: string) => !!withText('.sys-tabs [role=tab][aria-selected=true]', label);

/** admin › integrations. */
export const lessons: Lesson[] = [
  {
    id: 'admin.integrations.data-source',
    cat: 'admin',
    chapter: 'integrations',
    title: { fr: 'Connecteur de données', en: 'Data connector' },
    setup: { kind: 'page', path: '/data' },
    steps: [
      {
        say: { fr: 'Les sources partagées par tous les projets. Cliquez + : nouvelle source.', en: 'The sources all projects share. Click +: new source.' },
        at: () => shown(`.lib-nav-section .icon-btn[title="${t('New data source')}"]`),
        done: () => !!shown('.kind-picker'),
      },
      {
        say: { fr: 'Son type : JSON, CSV ou Google Sheet, RSS, XML… ou Push. Cliquez-en un.', en: 'Its type: JSON, CSV or Google Sheet, RSS, XML… or Push. Click one.' },
        at: '.kind-picker',
        done: { click: '.kind-picker button' },
      },
      {
        say: { fr: 'Tester lit la source une fois et montre ses lignes.', en: 'Test reads the source once and shows its rows.' },
        at: () => withText('.set-card header .btn', t('Test')),
        done: 'next',
      },
      {
        say: { fr: 'Ici, Annuler : rien n’est créé.', en: 'Here, Cancel: nothing is created.' },
        at: '.settings-head .btn:not(.primary):not(.danger)',
        done: () => !shown('.kind-picker'),
      },
    ],
  },
  {
    id: 'admin.integrations.mos',
    cat: 'admin',
    chapter: 'integrations',
    title: { fr: 'MOS et conducteur', en: 'MOS and running order' },
    setup: { kind: 'page', path: '/system/mos' },
    steps: [
      {
        say: { fr: 'Activé, la rédaction (ENPS, iNews…) se connecte à Strata.', en: 'On, the newsroom (ENPS, iNews…) connects to Strata.' },
        at: '.set-card .check',
        done: 'next',
      },
      {
        say: { fr: 'Projet : celui dont les journalistes choisissent les modèles.', en: 'Project: the one whose templates the journalists pick.' },
        at: () => shown(`.set-card .dd-btn[title="${t('Project')}"]`),
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Conducteurs.', en: 'Click Running orders.' },
        at: () => tab(t('Running orders')),
        done: () => tabOn(t('Running orders')),
      },
      {
        say: { fr: 'Les conducteurs reçus : sujets et graphiques.', en: 'The running orders received: stories and graphics.' },
        at: '.user-table, .empty',
        done: 'next',
      },
      {
        say: { fr: 'Cliquez Plugin journaliste : son adresse va dans la rédaction.', en: 'Click Journalist plugin: its address goes in the newsroom.' },
        at: () => tab(t('Journalist plugin')),
        done: () => tabOn(t('Journalist plugin')),
      },
    ],
  },
  {
    id: 'admin.integrations.premiere',
    cat: 'admin',
    chapter: 'integrations',
    title: { fr: 'Panneau Premiere Pro', en: 'Premiere Pro panel' },
    setup: { kind: 'page', path: '/system/api' },
    steps: [
      {
        say: { fr: 'Ce bouton télécharge le panneau, déjà réglé sur ce serveur.', en: 'This button downloads the panel, already set to this server.' },
        at: () => shown('.api-tools a.btn'),
        done: 'next',
      },
      {
        say: { fr: 'Décompressez-le, lancez son script d’installation. Puis Premiere : Fenêtre › Extensions › Strata.', en: 'Unzip it, run its install script. Then Premiere: Window › Extensions › Strata.' },
        at: () => shown('.api-tools a.btn'),
        done: 'next',
      },
      {
        say: { fr: 'Le panneau demande une clé d’API. Cliquez Clés d’API.', en: 'The panel asks for an API key. Click API keys.' },
        at: () => withText('.sys-page .lib-nav-item', t('API keys')),
        done: () => onPage(/^\/system\/keys/),
      },
    ],
  },
  {
    id: 'admin.integrations.tracking',
    cat: 'admin',
    chapter: 'integrations',
    title: { fr: 'Tracking caméra', en: 'Camera tracking' },
    setup: { kind: 'page', path: '/tracking' },
    steps: [
      {
        say: { fr: 'Chaque caméra envoie sa position en OpenTrackIO. Cliquez + : ajouter une caméra.', en: 'Each camera sends its position in OpenTrackIO. Click +: add a camera.' },
        at: () => shown(`.lib-nav-section .icon-btn[title="${t('Add a camera')}"]`) ?? shown('.tk-empty .btn'),
        done: dirty,
      },
      {
        say: { fr: 'Réception : multicast ou unicast, port, source. Retard : calé sur l’image.', en: 'Reception: multicast or unicast, port, source. Delay: matched to the picture.' },
        at: () => withText('.tk-card', t('Reception')),
        // Under the picture: brought into view.
        before: () => void setTimeout(() => withText('.tk-card', t('Reception'))?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300),
        done: 'next',
      },
      {
        say: { fr: 'Abandonner : rien n’est changé.', en: 'Discard: nothing changes.' },
        at: '.save-bar.show .btn:not(.primary)',
        done: () => !dirty(),
      },
    ],
  },
];
