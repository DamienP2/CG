import type { Cat, Text } from './types';

/** A tip: its keys (`Ctrl + D`, alternatives with ` / `; none: a bulb), and what they do. */
export interface Tip {
  keys: string;
  say: Text;
}

const tip = (keys: string, fr: string, en: string): Tip => ({ keys, say: { fr, en } });

export const TIPS: Record<Cat, Tip[]> = {
  designer: [
    tip('K', 'Lecture / pause.', 'Play / pause.'),
    tip('Espace', 'Maintenue : la main pour déplacer le canvas.', 'Held: the hand, to move the canvas.'),
    tip('Ctrl + molette', 'Zoom (ou pincement).', 'Zoom (or pinch).'),
    tip(', / .', 'Image précédente / suivante. Shift : par 10.', 'Previous / next frame. Shift: by 10.'),
    tip('Début / Fin', 'Première / dernière image.', 'First / last frame.'),
    tip('← / →', 'Déplacer d’1 px. Shift : 10 px.', 'Move by 1 px. Shift: 10 px.'),
    tip('Ctrl + D', 'Dupliquer.', 'Duplicate.'),
    tip('Ctrl + C', 'Copier des calques, puis Ctrl + V.', 'Copy layers, then Ctrl + V.'),
    tip('Ctrl + Z', 'Annuler. Ctrl + Y : rétablir.', 'Undo. Ctrl + Y: redo.'),
    tip('Shift', 'En déplaçant : un seul axe.', 'While moving: one axis only.'),
    tip('Shift', 'En tournant : par 15°. En inclinant : par 5°.', 'While turning: by 15°. While skewing: by 5°.'),
    tip('Alt', 'Sur le point d’ancre : sans aimant.', 'On the anchor point: no snapping.'),
    tip('Échap', 'Désélectionner.', 'Deselect.'),
    tip('Suppr', 'Supprimer les calques ou images clés choisis.', 'Delete the selected layers or keyframes.'),
    tip('Molette', 'Sur un champ : régler. Shift ×10, Alt ×0,1.', 'On a field: adjust. Shift ×10, Alt ×0.1.'),
    tip('↺', 'Remet la valeur par défaut.', 'Back to the default value.'),
    tip('🔗', 'Proportions verrouillées : un seul champ.', 'Proportions locked: one field.'),
    tip('Double-clic', 'Sur un repère : le supprimer.', 'On a guide: delete it.'),
    tip('Double-clic', 'Sur un tableau : son éditeur.', 'On a table: its editor.'),
  ],
  operator: [
    tip('F1', 'Envoyer à l’antenne.', 'Take on air.'),
    tip('F2', 'Continuer l’animation. Espace aussi.', 'Continue the animation. Space too.'),
    tip('F3', 'Sortir le graphique.', 'Take the graphic out.'),
    tip('F4', 'Mettre à jour ce qui est à l’antenne.', 'Update what is on air.'),
    tip('F12', 'Tout effacer.', 'Clear everything.'),
    tip('Ctrl + Z', 'Annuler la dernière action.', 'Undo the last action.'),
    tip('↑ / ↓', 'Graphique précédent / suivant.', 'Previous / next graphic.'),
    tip('1 … 9', 'Prendre le graphique 1 à 9.', 'Take graphic 1 to 9.'),
    tip('N', 'Ligne suivante du jeu de données.', 'Next row of the data set.'),
    tip('?', 'La liste des raccourcis.', 'The list of shortcuts.'),
    tip('Entrée', 'Dans un paragraphe : nouvelle ligne.', 'In a paragraph: a new line.'),
    tip('Double-clic', 'Sur un graphique : le renommer.', 'On a graphic: rename it.'),
  ],
  admin: [
    tip('', 'Système › Santé › Exporter : tout pour le support.', 'System › Health › Export: all the support needs.'),
    tip('', 'Seul un poste de production envoie à l’antenne.', 'Only a production station goes on air.'),
    tip('', 'Une nouvelle connexion déconnecte l’ancienne.', 'A new sign-in signs the previous one out.'),
    tip('', 'Un Designer peut être limité à certains projets.', 'A Designer can be limited to some projects.'),
    tip('', 'Sortie HTML5 : une adresse pour OBS, vMix ou un navigateur.', 'HTML5 output: an address for OBS, vMix or a browser.'),
  ],
};
