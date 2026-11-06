import type { Cat, Text } from './types';

/** The chapters of each part, in order. */
export const CHAPTERS: Record<Cat, { id: string; title: Text }[]> = {
  admin: [
    { id: 'start', title: { fr: 'Bien démarrer', en: 'Getting started' } },
    { id: 'access', title: { fr: 'Accès', en: 'Access' } },
    { id: 'control', title: { fr: 'Régie', en: 'Control room' } },
    { id: 'video', title: { fr: 'Vidéo', en: 'Video' } },
    { id: 'integrations', title: { fr: 'Données et intégrations', en: 'Data and integrations' } },
    { id: 'supervision', title: { fr: 'Supervision', en: 'Supervision' } },
  ],
  designer: [
    { id: 'start', title: { fr: 'Bien démarrer', en: 'Getting started' } },
    { id: 'draw', title: { fr: 'Dessiner', en: 'Drawing' } },
    { id: 'text', title: { fr: 'Textes', en: 'Texts' } },
    { id: 'media', title: { fr: 'Images et médias', en: 'Pictures and media' } },
    { id: 'animate', title: { fr: 'Animer', en: 'Animation' } },
    { id: 'widgets', title: { fr: 'Widgets', en: 'Widgets' } },
    { id: 'data', title: { fr: 'Données', en: 'Data' } },
    { id: 'logic', title: { fr: 'Logique', en: 'Logic' } },
    { id: 'air', title: { fr: 'Diffuser', en: 'Going on air' } },
  ],
  operator: [
    { id: 'start', title: { fr: 'Bien démarrer', en: 'Getting started' } },
    { id: 'air', title: { fr: 'À l’antenne', en: 'On air' } },
    { id: 'values', title: { fr: 'Valeurs', en: 'Values' } },
    { id: 'playlists', title: { fr: 'Playlists', en: 'Playlists' } },
    { id: 'widgets', title: { fr: 'Widgets à l’antenne', en: 'Widgets on air' } },
    { id: 'room', title: { fr: 'En régie', en: 'In the control room' } },
  ],
};

export const CAT_NAMES: Record<Cat, Text> = {
  admin: { fr: 'Administration', en: 'Administration' },
  designer: { fr: 'Designer', en: 'Designer' },
  operator: { fr: 'Opérateur', en: 'Operator' },
};
