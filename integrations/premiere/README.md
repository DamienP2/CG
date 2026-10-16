# Panneau Pulse CG pour Adobe Premiere Pro

Ce panneau permet d'utiliser les habillages Pulse CG en post-production. Le monteur :

1. choisit un template d'un projet Pulse CG ;
2. remplit ses champs (l'aperçu se met à jour) ;
3. indique la durée à l'antenne ;
4. clique sur **Render & insert at playhead**.

Le serveur rend alors le graphique au format et à la cadence de la séquence active : animation d'entrée, maintien à l'antenne, animation de sortie. Il produit un fichier QuickTime, codec PNG avec couche alpha. Le panneau enregistre ce fichier dans `Documents/Pulse CG Renders/<projet>/`, l'importe dans le chutier *Pulse CG* et le pose sur la piste choisie à la tête de lecture. Le bouton **Bin** importe sans poser.

Si la séquence est verticale (9:16), c'est la mise en page 9:16 du projet qui est utilisée, à condition qu'elle existe.

## Installation

Le panneau fonctionne avec Premiere Pro 2020 (14.0) et les versions suivantes, sur macOS et Windows.

1. Télécharger `pulse-cg-premiere-panel.zip` depuis la release, puis le décompresser.
2. Lancer le script d'installation :
   - **macOS** : `./install/install-mac.sh` dans le Terminal ;
   - **Windows** : clic droit sur `install\install-windows.ps1` → *Exécuter avec PowerShell*.
3. Redémarrer Premiere Pro, puis ouvrir **Fenêtre → Extensions → Pulse CG**.
4. Dans le panneau, cliquer sur ⚙ et renseigner :
   - l'adresse du serveur, par exemple `http://cg-server:8080` ;
   - une **clé d'API** (Pulse CG → Utilisateurs → API keys), d'un compte designer ou opérateur.

Le script active `PlayerDebugMode`, qui autorise les extensions non signées par Adobe Exchange. Pour une diffusion à grande échelle, le panneau peut être signé en `.zxp` avec `ZXPSignCmd`.

## Remarques

- **Durée** : le rendu est fait par le serveur, avec le moteur Rust (le même que pour le SDI et le ST 2110). Il tient environ ×3 le temps réel en 1080p sur un serveur courant.
- **Fichiers** : un clip PNG/alpha de 10 secondes en 1080p fait environ 15 à 30 Mo. Premiere, After Effects, Resolve et Avid lisent ce format avec la transparence.
- **Débogage** : avec le panneau ouvert, ouvrir `http://localhost:8095` dans Chrome.
