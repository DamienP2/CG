# Strata — serveur d'habillage broadcast

Générateur de caractères (CG) temps réel qui combine :

- **le designer façon MXMZ / After Effects** : timeline, keyframes, courbes d'easing, stop points (pause / out) ;
- **la simplicité web de Singular.live** : tout se pilote dans le navigateur, sortie HTML5 prête pour OBS / vMix / CasparCG ;
- **la logique data-driven de Flowics** : champs de données, bindings, API de contrôle pour l'automation.

Le moteur est écrit en **Rust**. Il produit trois types de sortie : **HTML5**, **SDI** (DeckLink) et **SMPTE ST 2110-20** (fill + key).

Architecture, choix techniques et feuille de route : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Installation sur un serveur (Linux, macOS, Windows)

Le serveur est distribué sous la forme d'**un exécutable autonome** par plateforme : il embarque l'UI web, les polices et le moteur. Il s'installe en **service natif** : systemd sous Linux, launchd sous macOS, service Windows.

- **Windows** : installateur `.msi` avec l’app **Strata Graphics** (zone de notification) (service, pare-feu, menu Démarrer, déploiement silencieux `msiexec /qn`).
- **macOS** : installateur `.pkg` universel (Apple Silicon + Intel) avec l’app **Strata Graphics** (barre des menus).
- **Linux** : archive avec binaire statique et `sudo ./install.sh` (systemd).

Les mises à jour suivantes se font **sans désinstaller**, depuis **Réglages → Mises à jour** : en ligne (releases GitHub) ou en déposant l'archive de la version (serveurs hors ligne), avec retour automatique à la version précédente si la nouvelle ne démarre pas.

Les commandes `strata-server service install | uninstall | start | stop | status` sont identiques sur les trois OS. Le guide complet est dans [`docs/INSTALL.md`](docs/INSTALL.md).

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

- la page d'accueil, ouverte **sur le serveur lui-même** (`http://localhost:8080`), propose de créer le compte administrateur. À distance, utilisez `strata-server user add admin` ;
- un projet de démo est créé dans `<data>/projects/` : lower third, score bug et un exemple de chaque widget ;
- une chaîne de sortie `main` (1080p50) est créée.

Une installation 0.1 est migrée automatiquement : `project.json` devient le premier projet, et `outputs.json` (ou les `outputs` de `config.json`) passe dans la première chaîne.

### Options du serveur

| Option | Variable | Défaut |
| --- | --- | --- |
| `--bind` | `CG_BIND` | `0.0.0.0:8080` |
| `--data-dir` | `CG_DATA_DIR` | dossier de données de l'utilisateur ; pour le service : `/var/lib/strata-graphics`, `/Library/Application Support/Strata Graphics` ou `%ProgramData%\Strata Graphics` |
| `--web-dir` | `CG_WEB_DIR` | UI embarquée (option utile pour servir `web/dist` en développement) |

### Comptes utilisateurs en ligne de commande

```bash
strata-server user add <nom> [--role admin|designer|operator|viewer]   # demande le mot de passe
strata-server user list
strata-server user passwd <nom>
strata-server user delete <nom>
```

Ces commandes agissent sur le dossier de données du service s'il existe (sinon sur le dossier utilisateur, ou sur `--data-dir`). Elles fonctionnent aussi pendant que le serveur tourne.

### Réglages, chaînes et sorties vidéo

Le serveur se règle dans la page **Settings** (Général, Réseau, Mises à jour, Système), les chaînes, leurs sorties et les entrées vidéo dans la page **Flux vidéo** (`/outputs`, réservée aux admins). Tout est enregistré dans `config.json`, dans le dossier de données ; *Apply* redémarre les sorties sans redémarrer le service :

```json
{
  "name": "Strata",
  "bind": "0.0.0.0:8080",
  "publicOutputs": true,
  "timezone": "Europe/Paris",
  "locations": [{ "id": "studio-a", "name": "Studio A" }, { "id": "web", "name": "Web desk" }],
  "channels": [
    {
      "id": "news", "name": "News", "location": "studio-a",
      "width": 1920, "height": 1080, "frameRate": { "num": 50, "den": 1 },
      "projectId": "journal-20h",
      "outputs": {
        "html5": [{ "id": "html5-1", "name": "Web page", "background": "" }],
        "st2110": [{ "id": "st2110-1", "name": "CG1", "encoding": "fillKey", "fill": "239.100.1.1:5004", "key": "239.100.1.2:5004", "interface": "10.10.0.21" }],
        "sdi": [{ "id": "sdi-1", "name": "CG1-SDI", "device": 0, "externalKey": true, "fillOnly": false, "genlock": true }],
        "ndi": [{ "id": "ndi-1", "name": "STRATA NEWS", "groups": "", "alpha": true }],
        "streams": [{ "id": "stream-1", "name": "Web", "protocol": "srt", "url": "srt://0.0.0.0:9000", "listen": true, "bitrate": 8000, "codec": "h264", "background": "#000000", "audio": true }]
      },
      "renditions": [{ "id": "vertical", "name": "Vertical 9:16", "width": 1080, "height": 1920, "outputs": { "st2110": [], "sdi": [], "ndi": [{ "id": "ndi-2", "name": "STRATA NEWS 9:16", "groups": "", "alpha": true }] } }]
    }
  ],
  "inputs": [
    { "id": "input-1", "name": "Caméra 1", "kind": "srt", "url": "srt://0.0.0.0:10000", "listen": true, "width": 1920, "height": 1080, "fps": 25 },
    { "id": "input-2", "name": "Régie", "kind": "ndi", "ndiSource": "REGIE (Program)" }
  ]
}
```

Les SDP se récupèrent sur `GET /api/channels/<chaîne>/outputs/<id de la sortie>/fill.sdp` et `/key.sdp` (à importer dans le contrôleur NMOS ou le récepteur). `GET /api/outputs/status` donne l'état de chaque sortie.

## Utilisation

### Projets
Un **projet** correspond à une émission : ses templates, ses widgets et son rundown. La page d'accueil a les onglets **Projects**, **Assets**, **Data**, **Flux vidéo** (Video streams), **MOS**, **Users**, **API** et **Settings** (*Flux vidéo*, *MOS*, *Users* et *Settings* pour les admins ; *Data* pour les designers). Chacun suit la même mise en page : une liste à gauche, la page à droite. La page **Projects** permet de créer un projet (dans le format de son choix ; il démarre avec un template vide, et garde toujours au moins un template), de le dupliquer, de l'exporter ou de l'importer (`.strata.json`) et de le supprimer (menu *…* de la carte).

Les projets se rangent dans des **dossiers** (colonne de gauche : créer, renommer, supprimer un dossier ; glisser une carte sur un dossier, ou *… > Move to*). Supprimer un dossier ne supprime pas ses projets. Recherche et tri par nom ou nombre de templates.

**Actions groupées** : la case en haut à droite d'une carte (ou *Select*) sélectionne des projets ; `Maj`+clic prend tous ceux entre deux, `Ctrl+A` tous ceux affichés, `Échap` vide la sélection. La barre de sélection permet de les **supprimer** (une seule confirmation, qui liste les chaînes où ils sont chargés), de les **déplacer** dans un dossier ou à la racine, ou de **créer un dossier** et les y mettre. Glisser un projet sélectionné sur un dossier y emmène toute la sélection.

Chaque carte de projet montre son nom, sa description, son format d'origine, ses templates et les chaînes qui le jouent, un aperçu de son premier template, et cinq accès : **Designer**, **Operator**, **Data**, **Media** et **Settings**. Un projet s'ouvre dans son propre onglet du navigateur (le rouvrir réutilise le même onglet), sous `/project/<id>/designer|operator|data|media|settings`. *Settings* y règle le nom, la description et le format d'origine. L'*Operator* d'un projet s'ouvre même sans sortie (préparation du rundown et preview ; Take désactivé). Le menu de sortie range les chaînes en *This project*, *Free* et *Used by another project* (avec le nom du projet) ; en choisir une libre ou d'un autre projet y charge ce projet (avec confirmation dans le second cas). Toutes les pages d'un projet se mettent à jour en temps réel pour tous les utilisateurs (templates, rundown, données, médias, sorties). L'indicateur *On air* n'apparaît que dans l'Operator.

### Médias (Assets)
Deux bibliothèques : les **ressources partagées** (onglet *Assets* de l'accueil, `/assets/<fichier>`), utilisables par tous les projets, et les **ressources du projet** (onglet *Assets* du projet, `/assets/projects/<id>/<fichier>`). La colonne de gauche filtre par type (images, vidéos, audio, autres) avec leur nombre et montre l'espace occupé ; les **polices**, communes à tous les projets, ont leur propre entrée dans la bibliothèque partagée. On y importe images, vidéos, sons et polices (bouton *Upload* ou glisser-déposer, jusqu'à 2 Go par fichier, avec progression), on cherche, on trie (nom, date, taille), on copie l'URL, on télécharge ou on supprime. Le sélecteur d'image du Designer propose les deux bibliothèques et importe dans celle du projet ; les images d'un import After Effects y vont aussi. Dupliquer un projet copie ses médias, le supprimer les supprime.

### Langue de l'interface
Le sélecteur **FR | EN** à côté du nom de l'utilisateur (en haut à droite, et sur la page de connexion) change la langue de toute l'interface. Chaque utilisateur garde sa langue sur le serveur (`PUT /api/me/lang`) ; tant qu'il n'en a pas choisi, c'est celle du navigateur. Ce qui passe à l'antenne (textes des templates, formats d'heure…) ne dépend pas de la langue de l'interface. Les textes français sont dans `web/src/i18n/fr/`, et `node web/scripts/i18n-check.mjs` liste ceux qui manquent.

### Flux vidéo : sorties et entrées (page Flux vidéo)
La page a deux modes, **SORTIES** et **ENTRÉES**.

#### Sorties
Une **chaîne** est un programme indépendant : son format vidéo, sa propre horloge de playout, ses graphiques à l'antenne. Les chaînes se rangent par **lieu** (un studio, un car, la cellule web…) dans la colonne de gauche. On charge un projet sur une chaîne. Un projet conçu dans un autre format est mis à l'échelle (letterbox), et ses animations gardent leur durée, par exemple un projet 25p sur une chaîne 50p.

Chaque chaîne se règle sur un **canvas de nodes** : *Program* (la chaîne) → *Pictures* (l'image principale et d'autres tailles du même programme, 9:16, 1:1…) → *Destinations*. On ajoute des nodes avec les boutons du haut, ou en tirant un fil depuis la sortie d'une *Picture* jusque dans le vide (un menu propose HTML5, SDI, ST 2110, NDI ou Stream). Les fils se tirent à la souris : de la sortie d'une Picture vers une destination pour l'alimenter, ou de l'entrée d'une destination vers une autre Picture. On déplace les nodes (positions gardées par navigateur), on sélectionne un node pour le régler à droite, puis *Apply*. Chaque node affiche son état (en marche, ou pourquoi il ne tourne pas).

- **HTML5** : lien web `/output/<chaîne>[/<picture>]` (fond transparent, noir ou vert), pour OBS, vMix, CasparCG, un lecteur web ou un écran.
- **SDI** : carte Blackmagic DeckLink, Fill + Key (keyer externe), keyer interne ou Fill seul ; les cartes et le rôle de chaque connecteur se déclarent dans **Matériel › SDI**. Nécessite le pilote Desktop Video sur la machine (Strata le charge au démarrage d'une sortie). Les installateurs macOS et Windows et le paquet Ubuntu pilotent les cartes.
- **ST 2110** : Fill + Key (deux flux ST 2110-20 YCbCr 4:2:2 10 bits + KEY), RGBA (un flux 4:4:4:4 8 bits) ou YCbCrA (un flux 4:2:2:4 10 bits) ; interface réseau, multicast, TTL, SDP. Le serveur doit être discipliné en PTP.
- **NDI** : nom de source, groupes, avec ou sans alpha. Le runtime NDI est installé avec Strata (installeurs macOS et Windows : `lib/libndi.dylib` à côté du serveur sur macOS, `Processing.NDI.Lib.x64.dll` sur Windows) et utilisé directement. Le champ *NDI runtime* d'un node NDI (ou `NDI_LIB_PATH`) force une autre bibliothèque si besoin. Le paquet Ubuntu n'embarque pas le runtime NDI : installez-le (NDI SDK ou NDI Tools) ou indiquez son chemin. NDI® est une marque déposée de Vizrt NDI AB (https://ndi.video) ; le runtime est redistribué selon la licence du NDI SDK. Le détail de l'état de la sortie liste les emplacements essayés.
- **Stream** (SRT, UDP, RTMP, HLS) : l'image est posée sur une couleur de fond (ces formats n'ont pas d'alpha) et encodée en H.264 (ou HEVC) par ffmpeg, à débit choisi, avec une piste audio AAC muette si on le souhaite (la plupart des plateformes RTMP l'exigent). SRT en *caller* ou en *listener* (`srt://0.0.0.0:9000`), UDP en unicast ou multicast (MPEG-TS), RTMP / RTMPS (YouTube, Twitch, Facebook…), HLS servi par Strata sur `/hls/<chaîne>/<picture>/<sortie>/index.m3u8`. Si ffmpeg s'arrête (récepteur parti, réseau coupé), il est relancé après 2 s et la raison s'affiche sur le node.

#### Entrées
Les **entrées en direct** (SRT en *appelant* ou en *écoute*, RTMP tiré ou reçu) sont des vidéos qui arrivent sur le serveur, pour le widget **Vidéo** des templates : **SRT** (caller ou listener), **UDP** (unicast ou multicast), **RTMP** (Strata écoute, l'encodeur pousse), **HLS**, **RTSP**, toute **URL** que lit ffmpeg, et **NDI** (source choisie dans la liste du réseau, *Chercher les sources*). Chaque entrée est décodée à la taille et à la cadence choisies (au besoin par la carte graphique, option *Décodage matériel*). Un **tampon de lissage** (2 images par défaut, réglable de 0 à 5) remet les images à intervalle régulier quand le réseau les livre par à-coups : le mouvement reste fluide, au prix de ce retard ; le moteur dessine sur chaque sortie l'image dont c'est le moment. La page montre une vignette de chaque entrée (5 images/s, la dernière image reste grisée quand le signal tombe), son état (réception, attente de l'émetteur, erreur), ses images/s reçues et ses pertes. Une entrée qui tombe se reconnecte seule. Les entrées **SDI** passent par une carte DeckLink (connecteur déclaré dans Matériel) : la carte suit le format qui arrive quand elle sait le détecter.

ffmpeg est nécessaire pour les sorties Stream, les entrées (sauf NDI) et la conversion des vidéos. Les installateurs l'embarquent (`bin/ffmpeg` à côté du serveur) ; sinon le serveur prend `FFMPEG_PATH`, puis celui du `PATH` (installation à la main, notamment sur macOS : [docs/INSTALL.md](docs/INSTALL.md#ffmpeg-flux-vidéo-entrées-vidéos)).

### Performances (page Performances)
La barre **CPU** à côté du nom de l'utilisateur (page d'accueil et dans chaque projet) montre l'occupation des processeurs de la machine ; survolée, elle détaille la mémoire, la part de Strata et de ffmpeg, et, dans un projet, les images/s de ses chaînes. Les cartes des projets à l'antenne affichent la cadence et la charge de rendu de leur chaîne.

La page **Performances** (admins) a trois parties :
- **Vue d'ensemble** : machine, avertissements (rendu en retard, images perdues par une sortie, entrée qui reçoit moins que prévu, cadence d'entrée qui ne tombe pas juste sur celle de la chaîne…), puis par chaîne : cadence réelle de chaque image (*picture*), temps de rendu moyen et maximum, charge en % du temps d'une image, images répétées ; par sortie : images/s, pertes, cœurs utilisés (ffmpeg compris) ; par entrée : images/s reçues, tampon, pertes, cœurs.
- **Capacité** : combien de rendus, de sorties (Stream, NDI, ST 2110, SDI) et d'entrées la machine peut encore prendre. Le budget est de 80 % des processeurs ; le coût d'un élément est mesuré sur ce serveur dès qu'un élément de ce type tourne (sinon une valeur typique), ramené au format de la chaîne.
- **Journal** : les journaux du serveur en direct (filtre par niveau, recherche, pause, téléchargement).

API : `GET /api/system/metrics` (chiffres de la page, rafraîchis chaque seconde) et `GET /api/system/logs?after=<n>&level=warn` (admins).

Ordres de grandeur mesurés (version optimisée, Xeon 2,8 GHz) : rendu d'une image 1080p50 avec un bandeau animé ≈ 0,45 cœur (davantage pour des habillages chargés) ; sortie Stream H.264 1080p50 ≈ 1,6 cœur ; entrée 720p25 ≈ 0,15 cœur (1080p25 ≈ 0,3) ; sortie NDI ≈ 0,35 cœur ; ST 2110 en logiciel : plusieurs cœurs par flux 1080p50 (préférez une carte réseau dédiée). Les sorties HTML5 sont dessinées par le navigateur qui les affiche.

**Fluidité** : chaque chaîne a sa propre horloge, qui vise des instants absolus (pas de dérive, pas d'images groupées). Chaque image est calculée une image à l'avance : si un rendu est en retard, les sorties reçoivent la précédente plutôt qu'un trou, et gardent une cadence régulière. Chaque sortie envoie depuis son propre fil : une sortie lente ne ralentit ni le rendu ni les autres. La sortie HTML5 fait avancer les animations à la fréquence de l'écran entre deux messages du serveur.

### Réseau et synchronisation (page Matériel)
- **Rôles réseau** : une carte pour le **contrôle** (interface web et API, plus `127.0.0.1`), une pour **NDI** (et un serveur de découverte NDI facultatif), le **média rouge** et le **média bleu** pour le ST 2110, la carte **PTP**.
- **ST 2110 en SMPTE 2022-7** : un flux avec des destinations bleues part sur les deux réseaux (mêmes paquets) ; le SDP décrit les deux chemins. Horodatages RTP en temps TAI.
- **Référence d'horloge** des canaux : *Libre*, *PTP* (images calées sur la grille ST 2059 de l'horloge système disciplinée par linuxptp) ou *DeckLink* (genlock de la carte). Réglage par défaut dans Matériel, modifiable par canal.
- **État** : NTP (chrony, timedatectl, w32tm) et PTP (`pmc` de linuxptp : état du port, grand maître, écart) ; une alerte dans Performances quand un canal PTP ou DeckLink perd sa référence, ou quand l'horloge n'est plus synchronisée.

Mise en place de linuxptp et détails : [docs/SYNC.md](docs/SYNC.md).

### Formats multiples (16:9, 9:16, 1:1…)
Un projet peut avoir plusieurs **formats**, par exemple le 16:9 de l'antenne et un 9:16 pour les réseaux sociaux.

- **Ajouter un format** (bouton **+** à côté des formats, dans le Designer) : chaque template reçoit automatiquement une première mise en page.
  - Chaque élément garde son ancrage (coin, bord, centre).
  - Les bandeaux pleine largeur s'étirent avec leur contenu.
  - Les tailles s'adaptent à la zone de sécurité, et les animations sont conservées.
- **Affiner** : on bascule sur le format, puis on déplace, redimensionne ou ré-anime les éléments. Ces changements ne valent **que pour ce format** : une pastille sur la propriété permet de revenir à la mise en page principale, et *Re-adapt* régénère la mise en page. Les textes, les données et les nouveaux calques sont communs à tous les formats.
- **Diffusion** : une chaîne peut avoir des **déclinaisons** (Réglages → chaîne → *Autres formats*), chacune avec sa page HTML5 `/output/<chaîne>/<format>` et ses sorties ST 2110 / SDI. **Un seul TAKE** joue partout, et chaque image utilise le format du projet le plus proche de ses proportions. Le moniteur Program de l'opérateur passe d'un format à l'autre.

### Rédaction (MOS)
Strata est un **MOS device 2.8** pour Saga (Fonn Group), iNews, ENPS, Octopus…

- Les journalistes placent les habillages dans leurs sujets avec le plugin HTML5 `/mos/plugin`.
- Chaque conducteur envoyé par la rédaction devient une playlist du projet.

L'onglet **MOS** de l'accueil (admins) règle la connexion (identifiants MOS / NCS, ports, projet qui reçoit les conducteurs) et montre son état, les conducteurs reçus et l'adresse du plugin des journalistes. Mise en service : [`docs/MOS.md`](docs/MOS.md).

### Post-production (Adobe Premiere Pro)
Le panneau Premiere Pro rend un habillage au format et à la cadence de la séquence, en QuickTime avec alpha, puis le pose à la tête de lecture. Voir [`integrations/premiere/README.md`](integrations/premiere/README.md). La même fonction est disponible pour tout outil via `POST /api/render`.

### Données (connecteurs et liaisons)
Onglet **Data** : les sources de données du serveur, relues à intervalle régulier ou poussées par l'automation.
- **JSON API** (scores, météo, élections…, avec en-têtes pour une clé d'API), **CSV / Google Sheets** (un lien de feuille partagée « à toute personne disposant du lien » suffit), **flux RSS / Atom** (titres pour un ticker), **XML** (flux sportifs), **Push** : la valeur est envoyée par `PUT /api/data/sources/{id}/value` (JSON, CSV ou XML) ou en déposant un fichier.
- Chaque source est convertie en JSON et affichée en arbre : un clic sur une valeur donne son chemin.
- Dans le Designer, chaque champ de données peut être **lié** à une source (*Link to data*) : choix de la source, chemin pris dans l'arbre, valeur en direct. Chemins : `match.home.score`, `items[0].title`, `items[-1]`, `items[*].title` (tous, un par ligne, pour un ticker), `rows[{row}].name` (l'opérateur choisit la ligne avec un champ `row`), `players[number={num}].name`, `items.length`.
- À l'antenne, le serveur remplit les champs liés et **met à jour le graphique dès que la source change** (un but marqué change le score sans intervention). Dans l'Opérateur, les champs liés sont affichés en lecture seule avec leur valeur en direct.

### Utilisateurs et droits
| Rôle | Peut |
| --- | --- |
| **Admin** | tout : utilisateurs, chaînes, réglages du serveur |
| **Designer** | créer et modifier des projets et des templates, et opérer |
| **Operator** | charger un projet sur une chaîne, jouer les graphiques, modifier le rundown et ses données |
| **Viewer** | consulter les projets et les monitors program |

L'onglet **Users** liste les comptes en cartes, filtrées par rôle à gauche. Pour chaque utilisateur (hors admin), on peut limiter l'accès à **certains projets** et à **certaines chaînes**. Les mots de passe sont hachés avec Argon2 (`users.json`). Le navigateur garde la session dans un cookie HttpOnly. L'automation peut utiliser `Authorization: Bearer <token>` (jeton renvoyé par `POST /api/auth/login`). Les pages `/output/<chaîne>` restent accessibles sans connexion pour les browser sources ; l'option se désactive dans les Réglages.

### Designer
- **Insertion** (au-dessus de la colonne *Layers* de la timeline) : rectangle, ellipse, trait, texte, image, groupe (avec masque *clip*), et le bouton **+** qui ouvre les *Basics* et les *Strata widgets*.
- **Widgets** (bouton **+** de la timeline) : ils sont rendus à l'identique en HTML5 et par le moteur Rust, animables (position, opacité, crop…), et leurs réglages peuvent être reliés aux données (canevas *Data*) :
  - **Formes** : rectangle (*quad*), polygone, ellipse, plume (tracé libre), avec dégradés ;
  - **Texte** : une ligne, multiligne, défilement horizontal (ticker) ou vertical (générique), styles par mot (gras, couleur…) ;
  - **Image** (et séquences GIF / APNG) ;
  - **Vidéo** : posée tout de suite avec un emplacement réservé ; à droite, on choisit soit un **fichier** dans les ressources (fenêtre de la bibliothèque, import possible ; la vidéo est jouée image par image, alpha conservé, une minute au plus), soit une **entrée en direct** de la page Flux vidéo, avec son aperçu et son état ;
  - **Animation (Lottie)** : posée avec un emplacement réservé ; le fichier (`.json`, `.lottie`, `.zip`) se choisit à droite et devient des calques ajustés au cadre ;
  - **Horloge** (heure, date, villes ; noms des jours et des mois en français, anglais, allemand, espagnol, italien, portugais ou néerlandais, dans la langue du projet par défaut) ; dans *Style*, l'aspect **Chiffres** ou **Horloge analogique** (cadran, graduations, chiffres, aiguilles, trotteuse fluide ou par saut ; les anciennes horloges analogiques sont converties) ;
  - **Temps** (chronomètre et compte à rebours, lancement à l'envoi, à la main ou à une heure, déclencheur à zéro ; les réglages avancés sous *Plus de réglages*). Les deux sont des calques `clock` : le mode (`timerMode`) dit lequel des deux widgets les dessine, les anciens « Chrono » s'ouvrent donc dans l'un ou l'autre sans conversion ;
  - **Tableau** (classements, résultats, couleurs par ligne venant des données) ;
  - **Bandeau défilant**, **Générique**, **Machine à écrire** ;
  - **Compteur animé**, **Barre de progression** (qui peut suivre un autre widget) ;
  - **Graphique** (barres, lignes, camembert…), **Carte**, **QR code**, **Tableau des scores** ;
  - **Iframe** (URL ou HTML ; seule la sortie HTML5 l'affiche). Les sites qui refusent d'être affichés dans une autre page passent par le relais du serveur (`/api/web/proxy`, option *Via le serveur*, activée par défaut) : seules les adresses publiques sont relayées, et la page est isolée (sandbox).
- **Scène** : sélection, déplacement, poignées de redimensionnement, zones de sécurité, fond studio, transparent ou noir.
- **Panneau de droite, Properties** (à la manière d'After Effects) : groupes repliables *Transform* (Position, Scale, Dimensions, Anchor, Rotation, Opacity), *Contents* (couleurs, contour, rayon, typographie, cadrage d'image) et *Reveal mask*. Chaque ligne a ◀ ◆ ▶ (keyframe précédente / à la tête de lecture / suivante), le bouton d'animation (allumé quand la propriété est animée) et ses champs X / Y avec leur unité. Le cadenas de *Scale* garde les proportions (aussi dans la timeline).
- **Panneau de gauche, sous les templates** : l'onglet du calque sélectionné montre ce qu'il affiche (texte et variables `{{clé}}`, réglages du widget, image) et les propriétés pilotées par une variable (*Expose a property…*) ; l'onglet *Variables* liste les variables du template (ce que l'opérateur remplit, ou ce qu'une source de données alimente).
- **Animation** : comme dans After Effects, le bouton d'animation d'une propriété l'anime ; ensuite, toute modification à la tête de lecture crée ou met à jour une keyframe (auto-key). La navigation entre keyframes (◀ ◆ ▶) se fait dans la timeline. Faire glisser le libellé d'un champ modifie la valeur (Maj = ×10, Alt = ×0,1). Les champs numériques acceptent des expressions (`1920/2`).
- **Timeline** (toute la largeur de la page) : la colonne *Layers* liste les calques (renommer par double-clic, dupliquer, supprimer, masquer, verrouiller, glisser-déposer). Déplier un calque affiche *Transform* et ses propriétés (Position, Size, Scale, Rotation, Opacity, puis les propriétés animées) avec leur valeur à la tête de lecture, modifiable, et ◀ ◆ ▶ pour naviguer et poser une keyframe ; les keyframes d'une propriété sont reliées par un trait. Le zoom par défaut fait tenir tout le template dans la largeur visible (bouton *Fit* pour y revenir). Règle avec scrub, keyframes déplaçables (multi-sélection avec Maj), easing par keyframe (linéaire, easy ease, bezier libre, back, elastic, bounce, hold) avec aperçu de la courbe, marqueurs : un seul marqueur **On air | Out** par template (le take s'y arrête, *Take out* repart de là jusqu'à la fin ; il ne se supprime pas) et autant de **Pause** que voulu (bouton *Pause*), avant On air pour construire le graphique par étapes ou après pour arrêter l'animation de sortie. Un clic sur un marqueur l'édite : temps, nom, et reprise d'une pause — par l'opérateur (*Continue*), automatiquement après un délai, ou sur un **déclencheur** nommé (bouton dans l'Opérateur, API `{"action":"trigger","name":…}`, Companion). Pendant un déplacement, le marqueur affiche son temps. La lecture se comporte comme à l'antenne : elle s'arrête sur les pauses et sur On air (une pause minutée repart seule) ; `Espace` relance, et repart du début une fois la fin atteinte. *Loop* joue en continu sans s'arrêter. Les templates des versions précédentes sont convertis : leur dernier arrêt devient le marqueur On air et les images jamais jouées jusqu'à l'ancien Out sont retirées.
- **Logic (relations entre valeurs, façon MXMZ)** : bouton *Logic* de la barre d'outils. Un canevas de nœuds reliés : sources (propriété d'un calque, taille mesurée d'un texte, champ de données, nombre), opérations (maths, min/max, clamp, **conditions** si/alors/sinon) et cibles qui fixent, ajoutent ou multiplient une propriété. Exemple : la largeur d'une plaque qui suit la longueur du nom, plus une marge, avec un minimum (préréglage *Fit a box to a text*). Les valeurs s'affichent en direct ; le graphe est évalué à l'identique par le rendu HTML5 et par le moteur Rust. Une propriété pilotée porte une pastille verte dans l'inspecteur.
- **Import After Effects** : icône d'import du panneau *Templates*. Une composition exportée avec Bodymovin / LottieFiles (`.json`, `.zip`, `.lottie`) devient un template : formes, solides, textes reliés à des champs de données, images, parentage, précomps et keyframes avec leur easing. Les `.mogrt` et `.aep` sont des formats binaires fermés (voir [docs/AFTER_EFFECTS.md](docs/AFTER_EFFECTS.md)).
- Les panneaux du Designer (templates et données, propriétés, timeline) se redimensionnent en tirant leurs bords (double-clic = taille par défaut).
- **Zones à l'écran** : un nouveau projet a une seule zone, *Full screen*, et un nouveau template s'y place. Les zones du projet sont dessinées sur la scène, dans le format édité. La zone du template est mise en avant ; on déplace une zone par son étiquette et on la redimensionne par ses poignées (`Maj` = pas de 1 %). Le bouton *Zones* les masque, *…* ouvre leur gestion.
- Champs numériques : un clic, puis la molette de la souris ou du trackpad ajuste la valeur (`Maj` ×10, `Alt` ×0,1), comme les flèches. Même chose pour les champs nombre de l'Opérateur.
- Raccourcis : `Espace` lecture / reprise, `Ctrl+Z` / `Ctrl+Maj+Z`, `Ctrl+D` dupliquer, `Suppr` supprimer (calques ou keyframes), flèches = nudge, `,` / `.` image par image.
- Sauvegarde automatique, dans un **brouillon** : l'Opérateur, les sorties et le playout gardent la version publiée. Le bouton **Publish to Operator** la met à l'antenne (révision v1, v2…) ; l'icône ↺ abandonne le brouillon et revient à la version publiée. *Live in Operator · vN* indique qu'il n'y a rien à publier.
- **Verrou d'édition** : un template ouvert par un designer est en lecture seule pour les autres : la page est voilée, ses modifications s'affichent en direct dessous, et une boîte qu'on ne peut pas fermer propose *Take over* (après confirmation). Le menu du haut et la liste des templates restent utilisables. Celui qui éditait passe en lecture seule et est prévenu. Le verrou se libère à la fermeture de l'onglet, ou 45 s après sa dernière activité.

### Opérateur
- **Chaîne** : choix de la chaîne opérée et du projet chargé dessus ; lien vers sa sortie HTML5.
- **Zones** : chaque projet découpe l'écran en zones, par exemple *Bas d'écran*, *Bug haut gauche*, *Ticker*, *Plein écran*.
  - Une zone n'affiche qu'**un template à la fois**, et les zones passent à l'antenne indépendamment les unes des autres.
  - Prendre un template dans une zone occupée fait d'abord sortir le graphique en place (animation de sortie), puis entrer le nouveau. En mode *Cut*, le remplacement est immédiat.
  - Le tableau des zones montre, pour chacune, le graphique à l'antenne et celui qui attend son tour, avec Continue / Out / Clear par zone.
- **Rundown** : liste d'éléments (template + données + couche de playout), tally *ON AIR*.
- **Preview / Program** : la preview affiche l'élément cué, le program affiche ce qui est réellement à l'antenne.
- **Animations internes** : la carte de zone d'un graphique à l'antenne liste ses widgets animés (minuteur, chronomètre, ticker, générique, compteur, barre de progression, rotator, machine à écrire, diaporama, graphique) avec ▶ / ⏸ et ⟲ (repartir de zéro). Dans le Designer, *Start manually* fait attendre le widget jusqu'au ▶ de l'opérateur. Par l'API : `{"action":"widget","zone":"ticker","target":"Crawl","control":"toggle"}` (`start`, `pause`, `toggle`, `reset`, `restart` ; `target` = nom ou id du calque, `*` pour tous).
- **TAKE** (`F1` / `Entrée`), **CONTINUE** (`F2` / `Espace`), **OUT** (`F3`), **UPDATE** à chaud, **CLEAR ALL** (`F12`).
- Plusieurs graphiques à l'antenne simultanément, sur des couches différentes.

## API de contrôle (automation)

| Méthode | Route | Rôle |
| --- | --- | --- |
| `POST` | `/api/auth/login` · `/api/auth/logout` | session (cookie et jeton Bearer) |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/users[/{id}]` | utilisateurs (admin) |
| `PUT` | `/api/me/lang` | langue de l'interface de l'utilisateur connecté (`{"lang":"fr"}`) |
| `GET` / `POST` | `/api/projects` · `/api/projects/import` | liste, création (ou duplication avec `from`), import |
| `GET` / `PUT` / `DELETE` | `/api/projects/{id}` · `/export` | projet complet, réglages, suppression, export |
| `PUT` / `DELETE` | `/api/projects/{id}/templates/{tid}[?publish=true]` | enregistrer le brouillon d'un template (publié aussitôt avec `?publish=true`), ou le supprimer |
| `POST` / `DELETE` | `/api/projects/{id}/templates/{tid}/publish` · `/draft` | publier vers l'Opérateur, abandonner le brouillon |
| `POST` / `DELETE` | `/api/projects/{id}/templates/{tid}/lock` · `GET /api/projects/{id}/locks` | verrou d'édition (en-tête `X-Strata-Client`, `force` pour reprendre la main) |
| `GET` | `/api/projects/{id}/templates/{tid}/thumbnail.png?frame=` | rendu serveur d'un template |
| `GET` / `PUT` / `DELETE` | `/api/media[/{nom}]` · `/api/projects/{id}/media[/{nom}]` | médias partagés, médias d'un projet |
| `GET` / `PUT` | `/api/folders` | dossiers de la liste des projets |
| `PUT` | `/api/projects/{id}/rundown` | playlist |
| `GET` | `/api/channels` · `/api/channels/{id}/state` · `/preview.png` | chaînes, état et rendu du program |
| `PUT` | `/api/channels/{id}/project` | charger un projet sur une chaîne |
| `POST` | `/api/channels/{id}/command` | commandes de playout (voir ci-dessous) |
| `GET` | `/api/asrun?from=&to=&channel=&actions=&actors=&kinds=&q=&limit=` · `/api/asrun.csv` | journal d'antenne (as-run) : chaque action à l'antenne, qui, quand, avec quelles valeurs ; export CSV |
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

### Surfaces de contrôle (Bitfocus Buttons / Companion)

Chemins courts sous `/api/v1/{canal}/…` (POST, clé d'API en `Authorization: Bearer pcg_…`) : un canal par id ou nom, un graphique du conducteur par id, nom ou position (1 = premier), une zone ou un template par id ou nom. Page *API › Bitfocus Buttons* : URL du serveur, clé, actions à copier, connexion Buttons à télécharger.

| Action | Chemin |
| --- | --- |
| take · cue | `take/{item}` (valeurs en JSON ou en query) · `cue/{item}` |
| NEXT (comme l'Opérateur) | `next` (`?playlist=`) |
| continue · out · clear | `continue/{zone}` · `out[/{zone}]` · `clear/{zone}` |
| valeurs | `update/{zone}` · `value/{zone}/{clé}` (corps = valeur) |
| undo · trigger | `undo` · `trigger/{nom}` |
| widgets · rangées | `widget/{zone}/{widget}/{start\|pause\|toggle\|reset\|…}` · `row/{zone}/{next\|prev\|n}` |

Retours : `GET /api/v1/status` (tally `off|cue|pvw|pgm` de chaque graphique, zones, comptes à rebours, widgets, verrous, santé) et le WebSocket `/api/v1/feedback?key=pcg_…` (statut à la connexion puis à chaque changement). Sans HTTP, activés dans *API › Bitfocus Buttons* (admin) ou `config.json` → `control` : OSC sur UDP 9000 (`/strata/main/take/2`, `/strata/main/value/lower/name "Marie Curie"`) et texte sur TCP 9001 (`main take 2` → `OK …` / `ERR …`, `status`, `watch`), limités aux adresses de `allow` (vide = toutes).

## Arborescence

```
crates/
  cg-core     modèle, keyframes et easing, widgets, logique de playout (sans I/O)
  cg-render   moteur de rendu logiciel (tiny-skia, texte vectoriel)
  cg-output   ST 2110-20 (RFC 4175, fill + key, SDP), SDI DeckLink
  cg-server   axum : REST, WebSocket, chaînes, projets, utilisateurs, UI embarquée, services OS
assets/fonts  polices Inter (OFL) embarquées : rendu identique sur tous les OS
packaging/   scripts d'installation Linux / macOS / Windows
web/          React + TypeScript : Projets, Designer, Opérateur, Réglages, Utilisateurs, sortie HTML5 ; i18n/ (FR / EN)
docs/         architecture, exemples de configuration
```

## Tests

```bash
cargo test --workspace
cargo run --release -p cg-render --example bench_render       # environ 1,5 ms par frame 1080p
cargo run --release -p cg-output --example bench_packetize    # environ 7 ms par frame 1080p
cd web && npm run build
```
