# Pulse CG — serveur d'habillage broadcast

Générateur de caractères (CG) temps réel qui combine :

- **le designer façon MXMZ / After Effects** : timeline, keyframes, courbes d'easing, stop points (pause / out) ;
- **la simplicité web de Singular.live** : tout se pilote dans le navigateur, sortie HTML5 prête pour OBS / vMix / CasparCG ;
- **la logique data-driven de Flowics** : champs de données, bindings, API de contrôle pour l'automation.

Le moteur est écrit en **Rust**. Il produit trois types de sortie : **HTML5**, **SDI** (DeckLink) et **SMPTE ST 2110-20** (fill + key).

Architecture, choix techniques et feuille de route : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Démarrage rapide

Pré-requis : Rust stable (1.80 ou plus), Node 22. Polices conseillées : `fonts-inter`.

```bash
# 1. Web app (Designer + Opérateur + sortie HTML5)
cd web && npm install && npm run build && cd ..

# 2. Serveur (API, WebSocket, playout, sorties)
cargo run --release -p cg-server
# → http://localhost:8080/designer
# → http://localhost:8080/operator
# → http://localhost:8080/output        (sortie HTML5 transparente)
```

En développement, lancez `npm run dev` dans `web/` (Vite sur le port 5173, qui proxifie l'API vers le port 8080).

Au premier lancement, un projet de démo est créé dans `data/project.json` (lower third + score bug).

### Options du serveur

| Option | Variable | Défaut |
| --- | --- | --- |
| `--bind` | `CG_BIND` | `0.0.0.0:8080` |
| `--data-dir` | `CG_DATA_DIR` | `data` (`project.json`, `outputs.json`, `assets/`) |
| `--web-dir` | `CG_WEB_DIR` | `web/dist` |

### Sorties baseband

Créez `data/outputs.json` (voir [`docs/outputs.example.json`](docs/outputs.example.json)) :

```json
{
  "st2110": [{ "name": "CG1", "fill": "239.100.1.1:5004", "key": "239.100.1.2:5004", "interface": "10.10.0.21" }],
  "sdi": [{ "name": "CG1-SDI", "device": 0, "externalKey": true }]
}
```

Les SDP se récupèrent sur `GET /api/outputs/CG1/fill.sdp` et `/key.sdp` (à importer dans le contrôleur NMOS ou le récepteur).

## Utilisation

### Designer
- Barre d'outils : rectangle, ellipse, texte, image, groupe (avec masque *clip*).
- **Scène** : sélection, déplacement, poignées de redimensionnement, zones de sécurité, fond studio, transparent ou noir.
- **Inspecteur** : chaque propriété a un **chronomètre** (comme dans After Effects) qui active l'animation. Ensuite, toute modification à la tête de lecture crée ou met à jour une keyframe (auto-key). Les flèches ◀ ◆ ▶ permettent de naviguer entre les keyframes. Faire glisser le libellé d'un champ modifie la valeur (Maj = ×10, Alt = ×0,1). Les champs numériques acceptent des expressions (`1920/2`).
- **Timeline** : règle avec scrub, keyframes déplaçables (multi-sélection avec Maj), easing par keyframe (linéaire, easy ease, bezier libre, back, elastic, bounce, hold) avec aperçu de la courbe, marqueurs *Pause* (vert) et *Out* (rouge) déplaçables, zoom, boucle, mode *Playout preview* qui s'arrête sur les pauses.
- **Données** : champs de template (texte, multiligne, nombre, couleur, image), syntaxe `{{clé}}` dans les textes, bindings de propriétés (couleur ou nombre) vers un champ.
- Raccourcis : `Espace` lecture, `Ctrl+Z` / `Ctrl+Maj+Z`, `Ctrl+D` dupliquer, `Suppr` supprimer (calques ou keyframes), flèches = nudge, `,` / `.` image par image.
- Sauvegarde automatique.

### Opérateur
- **Rundown** : liste d'éléments (template + données + couche de playout), tally *ON AIR*.
- **Preview / Program** : la preview affiche l'élément cué, le program affiche ce qui est réellement à l'antenne.
- **TAKE** (`F1` / `Entrée`), **CONTINUE** (`F2` / `Espace`), **OUT** (`F3`), **UPDATE** à chaud, **CLEAR ALL** (`F12`).
- Plusieurs graphiques à l'antenne simultanément, sur des couches différentes.

## API de contrôle (automation)

| Méthode | Route | Rôle |
| --- | --- | --- |
| `GET` / `PUT` | `/api/project` | projet complet |
| `PUT` / `DELETE` | `/api/templates/{id}` | créer, mettre à jour ou supprimer un template |
| `GET` | `/api/templates/{id}/thumbnail.png?frame=` | rendu serveur d'un template |
| `PUT` | `/api/rundown` | playlist |
| `POST` | `/api/channel/command` | commandes de playout (voir ci-dessous) |
| `GET` | `/api/channel` · `/api/channel/preview.png` | état et rendu du program |
| `GET` / `PUT` | `/api/assets` · `/api/assets/{nom}` | médias |
| `WS` | `/ws` | évènements temps réel et commandes |

```bash
curl -X POST localhost:8080/api/channel/command -H 'content-type: application/json' \
  -d '{"action":"take","layer":10,"templateId":"lower-third","data":{"name":"Ada Lovelace"}}'
# actions : take | continue | takeOut | update | clear
```

## Arborescence

```
crates/
  cg-core     modèle, keyframes et easing, logique de playout (sans I/O)
  cg-render   moteur de rendu logiciel (tiny-skia, texte vectoriel)
  cg-output   ST 2110-20 (RFC 4175, fill + key, SDP), SDI DeckLink
  cg-server   axum : REST, WebSocket, horloge de playout, fichiers statiques
web/          React + TypeScript : Designer, Opérateur, sortie HTML5
docs/         architecture, exemples de configuration
```

## Tests

```bash
cargo test --workspace
cargo run --release -p cg-render --example bench_render       # environ 1,5 ms par frame 1080p
cargo run --release -p cg-output --example bench_packetize    # environ 7 ms par frame 1080p
cd web && npm run build
```
