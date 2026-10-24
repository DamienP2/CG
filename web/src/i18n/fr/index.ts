// French texts, by English wording. One file per part of the interface.
//
// Words: template → modèle, layer → calque, rundown → conducteur, channel →
// canal, on air → à l’antenne, data set → jeu de données, lower third →
// synthé, asset → ressource. Buttons of the transport (TAKE, NEXT, OUT,
// CUE, UPDATE, CONTINUE, PVW, PGM) keep their broadcast names. French
// spacing: a no-break space (U+00A0) before ? ! : ; and inside « ».
import { common } from './common';
import { data } from './data';
import { designer } from './designer';
import { home } from './home';
import { importer } from './importer';
import { operator } from './operator';
import { widgets } from './widgets';
import { widgetsData } from './widgetsData';
import { widgetsA } from './widgetsA';
import { widgetsB } from './widgetsB';
import { widgetsC } from './widgetsC';

export const fr: Record<string, string> = { ...common, ...home, ...importer, ...designer, ...data, ...operator, ...widgets, ...widgetsData, ...widgetsA, ...widgetsB, ...widgetsC };
