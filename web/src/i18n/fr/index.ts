// French texts, by English wording. One file per part of the interface.
//
// Words: template → modèle, layer → calque, rundown → conducteur, channel →
// canal, on air → à l’antenne, data set → jeu de données, lower third →
// synthé, asset → ressource. Buttons of the transport (TAKE, NEXT, OUT,
// CUE, UPDATE, CONTINUE, PVW, PGM) keep their broadcast names. French
// spacing: a no-break space (U+00A0) before ? ! : ; and inside « ».
import { common } from './common';
import { data } from './data';
import { home } from './home';

export const fr: Record<string, string> = { ...common, ...home, ...data };
