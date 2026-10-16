# Pulse CG — serveur d'habillage broadcast

Générateur de caractères (CG) temps réel qui combine :

- **le designer façon MXMZ / After Effects** : timeline, keyframes, courbes d'easing, stop points (pause / out) ;
- **la simplicité web de Singular.live** : tout se pilote dans le navigateur, sortie HTML5 prête pour OBS / vMix / CasparCG ;
- **la logique data-driven de Flowics** : champs de données, bindings, API de contrôle pour l'automation.

Le moteur est écrit en **Rust**. Il produit trois types de sortie : **HTML5**, **SDI** (DeckLink) et **SMPTE ST 2110-20** (fill + key).

Architecture, choix techniques et feuille de route : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Installation sur un serveur (Linux, macOS, Windows)

Le serveur est distribué sous la forme d'**un exécutable autonome** par plateforme : il embarque l'UI web, les polices et le moteur. Il s'installe en **service natif** : systemd sous Linux, launchd sous macOS, service Windows.

- **Windows** : installateur `.msi` avec l'app **Pulse CG** (zone de notification) (service, pare-feu, menu Démarrer, déploiement silencieux `msiexec /qn`).
- **macOS** : installateur `.pkg` universel (Apple Silicon + Intel) avec l'app **Pulse CG** (barre des menus).
- **Linux** : archive avec binaire statique et `sudo ./install.sh` (systemd).

Les mises à jour suivantes se font **sans désinstaller**, depuis **Réglages → Mises à jour** : en ligne (releases GitHub) ou en déposant l'archive de la version (serveurs hors ligne), avec retour automatique à la version précédente si la nouvelle ne démarre pas.

Les commandes `cg-server service install | uninstall | start | stop | status` sont identiques sur les trois OS. Le guide complet est dans [`docs/INSTALL.md`](docs/INSTALL.md).

## Développement

Pré-requis : Rust stable (1.80 ou plus) et Node 22.

```bash
# 1. Web app (Designer + Opérateur + sortie HTML5), embarquée ensuite dans le binaire
cd web && npm install && npm run build && cd ..

# 2. Serveur (API, WebSocket, playout, sorties)
cargo run --release -p cg-server -- --data-dir data
# → http://localhost:8080/              (création du compte admin au premier lancement)
# → http://localhost:8080/output/main   (sortie HTML5 transparente de la chaîne « main »)
```

En développement de l'UI, lancez `npm run dev` dans `web/` : Vite sert l'UI sur le port 5173 et proxifie l'API vers le port 8080.

Au premier lancement :

- la page d'accueil, ouverte **sur le serveur lui-même** (`http://localhost:8080`), propose de créer le compte administrateur. À distance, utilisez `cg-server user add admin` ;
- un projet de démo est créé dans `<data>/projects/` : lower third, score bug et un exemple de chaque widget ;
- une chaîne de sortie `main` (1080p50) est créée.

Une installation 0.1 est migrée automatiquement : `project.json` devient le premier projet, et `outputs.json` (ou les `outputs` de `config.json`) passe dans la première chaîne.

### Options du serveur

| Option | Variable | Défaut |
| --- | --- | --- |
| `--bind` | `CG_BIND` | `0.0.0.0:8080` |
| `--data-dir` | `CG_DATA_DIR` | dossier de données de l'utilisateur ; pour le service : `/var/lib/pulse-cg`, `/Library/Application Support/PulseCG` ou `%ProgramData%\PulseCG` |
| `--web-dir` | `CG_WEB_DIR` | UI embarquée (option utile pour servir `web/dist` en développement) |

### Comptes utilisateurs en ligne de commande

```bash
cg-server user add <nom> [--role admin|designer|operator|viewer]   # demande le mot de passe
cg-server user list
cg-server user passwd <nom>
cg-server user delete <nom>
```

Ces commandes agissent sur le dossier de données du service s'il existe (sinon sur le dossier utilisateur, ou sur `--data-dir`). Elles fonctionnent aussi pendant que le serveur tourne.

### Réglages, chaînes et sorties baseband

Le serveur, les chaînes et leurs sorties se règlent dans la page **Réglages** (`/settings`, réservée aux admins), sans redémarrer le service. Ils sont enregistrés dans `config.json`, dans le dossier de données :

```json
{
  "name": "Pulse CG",
  "bind": "0.0.0.0:8080",
  "publicOutputs": true,
  "timezone": "Europe/Paris",
  "channels": [
    {
      "id": "studio-a", "name": "Studio A", "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 },
      "projectId": "journal-20h",
      "outputs": {
        "st2110": [{ "name": "CG1", "fill": "239.100.1.1:5004", "key": "239.100.1.2:5004", "interface": "10.10.0.21" }],
        "sdi": [{ "name": "CG1-SDI", "device": 0, "externalKey": true }]
      }
    },
    { "id": "regie-sport", "name": "Régie sport", "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 }, "projectId": "match", "outputs": { "st2110": [], "sdi": [] } }
  ]
}
```

Les SDP se récupèrent sur `GET /api/channels/<chaîne>/outputs/CG1/fill.sdp` et `/key.sdp` (à importer dans le contrôleur NMOS ou le récepteur).

## Utilisation

### Projets
Un **projet** correspond à une émission : ses templates, ses widgets et son rundown. La page **Projets** permet de créer un projet (dans le format de son choix), de le dupliquer, de l'exporter ou de l'importer (`.pulsecg.json`), de le supprimer et de le charger sur une chaîne.

### Chaînes de sortie
Une **chaîne** est un programme indépendant, par exemple une par studio ou par régie. Chaque chaîne a son format vidéo, sa propre horloge de playout, ses graphiques à l'antenne, ses sorties ST 2110 / SDI et sa page HTML5 `/output/<id>`. On charge un projet sur une chaîne. Un projet conçu dans un autre format est mis à l'échelle (letterbox), et ses animations gardent leur durée, par exemple un projet 25p sur une chaîne 50p.

### Formats multiples (16:9, 9:16, 1:1…)
Un projet peut avoir plusieurs **formats**, par exemple le 16:9 de l'antenne et un 9:16 pour les réseaux sociaux.

- **Ajouter un format** (bouton **+** à côté des formats, dans le Designer) : chaque template reçoit automatiquement une première mise en page.
  - Chaque élément garde son ancrage (coin, bord, centre).
  - Les bandeaux pleine largeur s'étirent avec leur contenu.
  - Les tailles s'adaptent à la zone de sécurité, et les animations sont conservées.
- **Affiner** : on bascule sur le format, puis on déplace, redimensionne ou ré-anime les éléments. Ces changements ne valent **que pour ce format** : une pastille sur la propriété permet de revenir à la mise en page principale, et *Re-adapt* régénère la mise en page. Les textes, les données et les nouveaux calques sont communs à tous les formats.
- **Diffusion** : une chaîne peut avoir des **déclinaisons** (Réglages → chaîne → *Autres formats*), chacune avec sa page HTML5 `/output/<chaîne>/<format>` et ses sorties ST 2110 / SDI. **Un seul TAKE** joue partout, et chaque image utilise le format du projet le plus proche de ses proportions. Le moniteur Program de l'opérateur passe d'un format à l'autre.

### Rédaction (MOS)
Pulse CG est un **MOS device 2.8** pour Saga (Fonn Group), iNews, ENPS, Octopus…

- Les journalistes placent les habillages dans leurs sujets avec le plugin HTML5 `/mos/plugin`.
- Chaque conducteur envoyé par la rédaction devient une playlist du projet.

Mise en service : [`docs/MOS.md`](docs/MOS.md).

### Utilisateurs et droits
| Rôle | Peut |
| --- | --- |
| **Admin** | tout : utilisateurs, chaînes, réglages du serveur |
| **Designer** | créer et modifier des projets et des templates, et opérer |
| **Operator** | charger un projet sur une chaîne, jouer les graphiques, modifier le rundown et ses données |
| **Viewer** | consulter les projets et les monitors program |

Pour chaque utilisateur (hors admin), on peut limiter l'accès à **certains projets** et à **certaines chaînes**. Les mots de passe sont hachés avec Argon2 (`users.json`). Le navigateur garde la session dans un cookie HttpOnly. L'automation peut utiliser `Authorization: Bearer <token>` (jeton renvoyé par `POST /api/auth/login`). Les pages `/output/<chaîne>` restent accessibles sans connexion pour les browser sources ; l'option se désactive dans les Réglages.

### Designer
- Barre d'outils : rectangle, ellipse, texte, image, groupe (avec masque *clip*), et le menu **Widgets**.
- **Widgets préfabriqués** : ils sont rendus à l'identique en HTML5 et par le moteur Rust, animables (position, opacité, crop…) et reliables aux champs de données `{{clé}}` :
  - **Horloge** (heure dans n'importe quel fuseau, date) ;
  - **Compte à rebours** vers une heure ou une date ;
  - **Minuteur** et **chronomètre** qui démarrent au take ;
  - **Horloge analogique** ;
  - **Ticker / crawl** horizontal ;
  - **Générique** défilant verticalement ;
  - **Rotator** (messages en fondu enchaîné) ;
  - **Machine à écrire** ;
  - **Compteur animé** (scores, résultats, montants) ;
  - **Barre de progression** ;
  - **Graphique en barres / sondage** ;
  - **Diaporama** d'images ;
  - **QR code**.
- **Scène** : sélection, déplacement, poignées de redimensionnement, zones de sécurité, fond studio, transparent ou noir.
- **Inspecteur** : chaque propriété a un **chronomètre** (comme dans After Effects) qui active l'animation. Ensuite, toute modification à la tête de lecture crée ou met à jour une keyframe (auto-key). Les flèches ◀ ◆ ▶ permettent de naviguer entre les keyframes. Faire glisser le libellé d'un champ modifie la valeur (Maj = ×10, Alt = ×0,1). Les champs numériques acceptent des expressions (`1920/2`).
- **Timeline** : règle avec scrub, keyframes déplaçables (multi-sélection avec Maj), easing par keyframe (linéaire, easy ease, bezier libre, back, elastic, bounce, hold) avec aperçu de la courbe, marqueurs *Pause* (vert) et *Out* (rouge) déplaçables, zoom, boucle, mode *Playout preview* qui s'arrête sur les pauses.
- **Données** : champs de template (texte, multiligne, nombre, couleur, image), syntaxe `{{clé}}` dans les textes, bindings de propriétés (couleur ou nombre) vers un champ.
- Raccourcis : `Espace` lecture, `Ctrl+Z` / `Ctrl+Maj+Z`, `Ctrl+D` dupliquer, `Suppr` supprimer (calques ou keyframes), flèches = nudge, `,` / `.` image par image.
- Sauvegarde automatique.

### Opérateur
- **Chaîne** : choix de la chaîne opérée et du projet chargé dessus ; lien vers sa sortie HTML5.
- **Zones** : chaque projet découpe l'écran en zones, par exemple *Bas d'écran*, *Bug haut gauche*, *Ticker*, *Plein écran*.
  - Une zone n'affiche qu'**un template à la fois**, et les zones passent à l'antenne indépendamment les unes des autres.
  - Prendre un template dans une zone occupée fait d'abord sortir le graphique en place (animation de sortie), puis entrer le nouveau. En mode *Cut*, le remplacement est immédiat.
  - Le tableau des zones montre, pour chacune, le graphique à l'antenne et celui qui attend son tour, avec Continue / Out / Clear par zone.
- **Rundown** : liste d'éléments (template + données + couche de playout), tally *ON AIR*.
- **Preview / Program** : la preview affiche l'élément cué, le program affiche ce qui est réellement à l'antenne.
- **TAKE** (`F1` / `Entrée`), **CONTINUE** (`F2` / `Espace`), **OUT** (`F3`), **UPDATE** à chaud, **CLEAR ALL** (`F12`).
- Plusieurs graphiques à l'antenne simultanément, sur des couches différentes.

## API de contrôle (automation)

| Méthode | Route | Rôle |
| --- | --- | --- |
| `POST` | `/api/auth/login` · `/api/auth/logout` | session (cookie et jeton Bearer) |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/users[/{id}]` | utilisateurs (admin) |
| `GET` / `POST` | `/api/projects` · `/api/projects/import` | liste, création (ou duplication avec `from`), import |
| `GET` / `PUT` / `DELETE` | `/api/projects/{id}` · `/export` | projet complet, réglages, suppression, export |
| `PUT` / `DELETE` | `/api/projects/{id}/templates/{tid}` | créer, mettre à jour ou supprimer un template |
| `GET` | `/api/projects/{id}/templates/{tid}/thumbnail.png?frame=` | rendu serveur d'un template |
| `PUT` | `/api/projects/{id}/rundown` | playlist |
| `GET` | `/api/channels` · `/api/channels/{id}/state` · `/preview.png` | chaînes, état et rendu du program |
| `PUT` | `/api/channels/{id}/project` | charger un projet sur une chaîne |
| `POST` | `/api/channels/{id}/command` | commandes de playout (voir ci-dessous) |
| `GET` / `PUT` | `/api/assets` · `/api/assets/{nom}` | médias |
| `GET` | `/api/health` | état public (supervision, app de la barre des menus) |
| `GET` / `POST` | `/api/system/update` · `/check` · `/install` · `/upload` · `/rollback` | mises à jour OTA (admin) |
| `PUT` | `/api/projects/{id}/zones` | zones d'écran du projet |
| `WS` | `/ws` · `/ws?channel={id}` | évènements temps réel et commandes |

```bash
TOKEN=$(curl -s localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"automation","password":"…"}' | jq -r .token)
curl -X POST localhost:8080/api/channels/main/command -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"take","zone":"lower-third","templateId":"lower-third","data":{"name":"Ada Lovelace"}}'
# actions : take | continue | takeOut | update | clear — ciblées par "zone" (ou "layer")
# un take sans zone joue dans la zone par défaut du template
```

## Arborescence

```
crates/
  cg-core     modèle, keyframes et easing, widgets, logique de playout (sans I/O)
  cg-render   moteur de rendu logiciel (tiny-skia, texte vectoriel)
  cg-output   ST 2110-20 (RFC 4175, fill + key, SDP), SDI DeckLink
  cg-server   axum : REST, WebSocket, chaînes, projets, utilisateurs, UI embarquée, services OS
assets/fonts  polices Inter (OFL) embarquées : rendu identique sur tous les OS
packaging/   scripts d'installation Linux / macOS / Windows
web/          React + TypeScript : Projets, Designer, Opérateur, Réglages, Utilisateurs, sortie HTML5
docs/         architecture, exemples de configuration
```

## Tests

```bash
cargo test --workspace
cargo run --release -p cg-render --example bench_render       # environ 1,5 ms par frame 1080p
cargo run --release -p cg-output --example bench_packetize    # environ 7 ms par frame 1080p
cd web && npm run build
```
