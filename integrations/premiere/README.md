# Panneau Strata pour Adobe Premiere Pro

Ce panneau permet d'utiliser les habillages Strata en post-production.

## Graphics

1. Choisir un template : recherche, filtres par zone, favoris (étoile).
2. Remplir ses valeurs. L'**aperçu** est animé et suit la saisie : c'est le moteur HTML5 du serveur (`/embed/preview`). La barre IN · à l'antenne · OUT permet de se placer dans l'animation, avec Play.
   - Fonds au choix : l'image sous la tête de lecture, le damier alpha, ou du noir. Un bouton affiche les zones de sécurité.
   - Un texte trop long pour sa case est signalé.
   - Les valeurs déjà utilisées sont proposées sous chaque champ.
3. Choisir la durée à l'antenne : une durée fixe, les points **In → Out** de la séquence, ou la longueur du **clip sélectionné**. Le total s'affiche (IN + antenne + OUT).
4. **Insert** : le serveur rend le graphique au format et à la cadence de la séquence (QuickTime, codec PNG avec couche alpha). Le panneau pose le clip sur la première piste vidéo libre au-dessus de V1, ou sur la piste choisie. **Bin** importe le clip sans le poser.

## Modifier un clip déjà posé

Chaque clip rendu garde ses valeurs dans un fichier `<clip>.mov.pcg.json` à côté de lui. Il suffit de sélectionner le clip dans la timeline pour que le panneau le recharge (bandeau « Editing »). Le bouton devient **Update clip** : le graphique est rendu à nouveau et remplace le clip, à la même place et sur la même piste.

## From markers

Chaque marqueur de la séquence peut donner un graphique : son nom et son commentaire remplissent les champs choisis. Tous les graphiques sont créés d'un coup, chacun à la position de son marqueur.

## Renders

La file des rendus montre ce qui attend, ce qui est en cours et ce qui est terminé. Les rendus se font un par un, et on peut continuer à travailler pendant ce temps. Un graphique identique, avec les mêmes valeurs, la même durée et le même format, est réutilisé sans nouveau rendu (badge « cached »).

Si la séquence est verticale (9:16), c'est la mise en page 9:16 du projet qui est utilisée, à condition qu'elle existe.

## Installation

Le panneau fonctionne avec Premiere Pro 2020 (14.0) et les versions suivantes, sur macOS et Windows.

1. Télécharger `pulse-cg-premiere-panel.zip` depuis la release, puis le décompresser.
2. Lancer le script d'installation :
   - **macOS** : `./install/install-mac.sh` dans le Terminal ;
   - **Windows** : clic droit sur `install\install-windows.ps1` → *Exécuter avec PowerShell*.
3. Redémarrer Premiere Pro, puis ouvrir **Fenêtre → Extensions → Strata**.
4. Dans le panneau, cliquer sur ⚙ et renseigner :
   - l'adresse du serveur, par exemple `http://cg-server:8080` ;
   - une **clé d'API** (Strata → Utilisateurs → API keys), d'un compte designer ou opérateur ;
   - si besoin, le dossier des rendus (par défaut `Documents/Strata Renders/<projet>/`).

Le script active `PlayerDebugMode`, qui autorise les extensions non signées par Adobe Exchange. Pour une diffusion à grande échelle, le panneau peut être signé en `.zxp` avec `ZXPSignCmd`.

## Remarques

- **Durée** : le rendu est fait par le serveur, avec le moteur Rust (le même que pour le SDI et le ST 2110). Il tient environ ×3 le temps réel en 1080p sur un serveur courant.
- **Fichiers** : un clip PNG/alpha de 10 secondes en 1080p fait environ 15 à 30 Mo. Premiere, After Effects, Resolve et Avid lisent ce format avec la transparence.
- **Image sous la tête de lecture** : utilise l'export d'image de Premiere (2019 et suivants). Sinon, le fond alpha est utilisé.
- **Débogage** : avec le panneau ouvert, ouvrir `http://localhost:8095` dans Chrome.
