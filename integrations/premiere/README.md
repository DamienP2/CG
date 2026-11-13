# Panneau Strata pour Adobe Premiere Pro

Ce panneau permet d'utiliser les habillages Strata en post-production : pas d'opérateur, la timeline de Premiere fait référence. Ce que l'opérateur ferait en direct (lancer un chrono, appuyer sur un bouton d'un widget, quitter une pause) devient un instant dans le clip.

Le panneau est fait des composants de l'application elle-même : il charge la feuille de style de l'application depuis le serveur (`<serveur>/premiere/app.css`), puis la sienne (`ui/panel.css`), qui ne fait que les disposer dans une colonne étroite.

## Séquence

L'écran d'accueil : la séquence active (nom, nombre de graphiques, format), puis un graphique par clip Strata de la séquence, dans l'ordre du temps, comme le conducteur de l'Opérateur :

- le carré donne la piste (**V3**) : un clic place la tête de lecture de Premiere sur le clip et le sélectionne ;
- le texte principal du clip (sa première valeur texte), la zone, le modèle et le timecode du début du clip ;
- la mini-timeline : entrée, à l'antenne, sortie ;
- à droite, un point orange quand le clip est à rendre de nouveau : sa durée a changé dans Premiere (« Durée du clip changée : 12,0 s → 9,5 s ») ou son modèle a été publié depuis ce rendu ; pendant un rendu, sa progression (« 42 % »).

Un clic sur la ligne ouvre le clip. **TOUT METTRE À JOUR** rend de nouveau les clips marqués, à la durée qu'ils ont dans la séquence, et les remplace à la même place. La liste suit la séquence en continu ; sélectionner un clip Strata dans la timeline l'ouvre dans le panneau. **+** ouvre les modèles.

## Modèles

Le projet (un clic sur son nom en choisit un autre), puis ses modèles : image fixe rendue par le serveur, nom, zone. **+** (ou un glisser vers la séquence) pose le modèle tel quel à la tête de lecture ; un clic ouvre un nouveau clip.

## Le clip

- **Aperçu** : le graphique animé (le moteur HTML5 du serveur, `/embed/preview`), en boucle ; un clic l'arrête ou le relance, l'œil le masque.
- **Placement** (nouveau clip, quand la séquence a un point d'entrée et un point de sortie) : **Tête de lecture** ou **Entrée → Sortie** ; le clip dure alors la plage.
- **Durée** : le champ de durée du Designer (minutes:secondes:images, et 3 s à 30 s). Pour un clip de la séquence, c'est sa durée dans Premiere.
- **Déroulé** : la timeline du clip, comme dans le Designer. **IN** (vert) jusqu'à l'arrivée du graphique ; **OUT** (rouge) à la fin : l'animation de sortie finit toujours avec le clip. Chaque pause du modèle (orange) se glisse : c'est l'instant où le graphique la quitte. Les actions (gris) se glissent aussi, et chacune a son temps sous la règle :
  - **Départ · <calque>** pour un calque qui attend Continue ou un déclencheur (par défaut à l'arrivée du graphique) ;
  - **+ Action** : un bouton d'un widget du modèle (autant de fois qu'il faut, × pour en retirer un).
- **Valeurs** : les valeurs du modèle, et pour un modèle avec un jeu de données, la ligne choisie.

**METTRE À JOUR** rend le clip de nouveau et le remplace à la même place, sur la même piste. **INSÉRER** le pose sur la première piste vidéo libre au-dessus de V1 (affichée sur le bouton). Pour un modèle avec un jeu de données, **TOUTES LES LIGNES** pose un clip par ligne sur les marqueurs de la séquence à partir de la tête de lecture (la ligne 1 sur le premier marqueur, etc. ; au-delà des marqueurs, les clips se suivent), avec la même durée et le même déroulé.

Le serveur rend le clip au format et à la cadence de la séquence (QuickTime, codec PNG avec couche alpha) : `POST /api/render/jobs`, dont le panneau suit la progression. Un graphique identique déjà rendu est réutilisé. Si la séquence est verticale (9:16), c'est la mise en page 9:16 du projet qui est utilisée, à condition qu'elle existe.

Chaque clip rendu garde ce qui l'a fait dans un fichier `<clip>.mov.pcg.json` à côté de lui : projet, modèle (et son empreinte), valeurs, lignes des jeux de données, actions, heure des horloges (figée au premier rendu), timeline et durée rendue. Un nouveau rendu donne donc la même image.

## Réglages

Depuis la pastille de connexion : adresse du serveur, clé d'API (**Coller**), **Tester la connexion**, version du panneau et **Vérifier** (puis **Mettre à jour** ou **Recharger**).

## Installation

Le panneau fonctionne avec Premiere Pro 2020 (14.0) et les versions suivantes, sur macOS et Windows. Il s'installe pour l'utilisateur courant, sans droits d'administrateur.

**Installateurs** (dans la release) :

- **macOS** : `Strata-Premiere-<version>-macos.pkg` ;
- **Windows** : `Strata-Premiere-<version>-windows.msi`. En déploiement silencieux, le serveur peut être fixé : `msiexec /i Strata-Premiere.msi /qn SERVER=http://strata-server:8080`.

**Depuis le serveur** : Strata → Utilisateurs → API keys → **Premiere panel** télécharge un zip déjà réglé sur ce serveur. Le décompresser, puis lancer `./install-mac.sh` dans le Terminal (macOS) ou clic droit sur `install-windows.ps1` → *Exécuter avec PowerShell* (Windows). Les deux scripts acceptent aussi l'adresse du serveur en argument.

Ensuite :

1. Redémarrer Premiere Pro, puis ouvrir **Fenêtre → Extensions → Strata**.
2. Dans le panneau, ouvrir les réglages (la pastille de connexion, en haut à droite) et renseigner :
   - l'adresse du serveur, si l'installateur ne l'a pas déjà mise, par exemple `http://strata-server:8080` ;
   - une **clé d'API** (Strata → Utilisateurs → API keys), d'un compte designer ou opérateur.

Les rendus vont dans `Documents/Strata Renders/<projet>/`.

L'installation active `PlayerDebugMode`, qui autorise les extensions non signées par Adobe Exchange. Pour une diffusion à grande échelle, le panneau peut être signé en `.zxp` avec `ZXPSignCmd`.

## Mises à jour

Le panneau suit le serveur, comme l'application : seul un petit lanceur (`loader.js`) est installé, et l'interface du panneau (`ui/`, `host/premiere.jsx`) est chargée depuis le serveur Strata à chaque ouverture. Mettre le serveur à jour met donc à jour tous les panneaux.

- **Hors ligne** : la dernière version chargée est gardée (avec la feuille de style de l'application), puis, à défaut, celle installée.
- **Lanceur** : quand le serveur a un lanceur plus récent, la pastille de connexion indique **Mise à jour**. Dans les réglages, **Mettre à jour** réécrit l'extension dans le dossier de l'utilisateur et recharge le panneau ; si le manifeste a changé, il faut redémarrer Premiere.
- La version chargée est indiquée dans les réglages ; **Vérifier** la compare à celle du serveur.

Pour les développeurs : toute modification de `loader.js`, `index.html` ou `CSXS/manifest.xml` doit incrémenter `LOADER_VERSION` dans `loader.js`, sinon les panneaux déjà installés ne la recevront pas.

## Remarques

- **Durée** : le rendu est fait par le serveur, avec le moteur Rust (le même que pour le SDI et le ST 2110). Il tient environ ×3 le temps réel en 1080p sur un serveur courant.
- **Fichiers** : un clip PNG/alpha de 10 secondes en 1080p fait environ 15 à 30 Mo. Premiere, After Effects, Resolve et Avid lisent ce format avec la transparence.
- **Aspect** : le panneau a exactement l'aspect de l'application à partir de Premiere Pro 2022 (CEP 11). Les versions 2020 et 2021 ont un Chromium plus ancien : tout fonctionne, mais certains espacements de la feuille de style de l'application n'y sont pas appliqués.
- **Débogage** : avec le panneau ouvert, ouvrir `http://localhost:8095` dans Chrome.
