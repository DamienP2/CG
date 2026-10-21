# Installer le serveur Strata

Le serveur tient dans **un seul exécutable**, `cg-server`. Il contient le moteur de rendu, l'API, la web app (Designer, Opérateur, sortie HTML5) et les polices Inter. Il n'a besoin ni de Node, ni de navigateur, ni de runtime à installer sur le serveur.

| OS | Paquet | Service | Données | Journaux |
| --- | --- | --- | --- | --- |
| Ubuntu 22.04 ou plus récent x86_64 (serveur, sans interface graphique) | **`Strata-<version>-ubuntu-x64.tar.gz`** | systemd `pulse-cg` (compte système dédié) | `/var/lib/pulse-cg` | `journalctl -u pulse-cg -f` |
| macOS 11 ou plus récent (Apple Silicon / Intel) | **`Strata-<version>-macos-universal.dmg`** (ou le `.pkg` seul) | launchd `com.pulsecg.server` | `/Library/Application Support/PulseCG` | `/Library/Logs/PulseCG/cg-server.log` |
| Windows Server 2016 ou plus récent / Windows 10+ x64 | **`Strata-<version>-windows-x64.msi`** | service Windows `pulse-cg` (démarrage auto, redémarrage sur échec) | `C:\ProgramData\PulseCG` | `C:\ProgramData\PulseCG\logs\cg-server.log` |

Les paquets sont produits par la CI (`.github/workflows/release.yml`) à chaque tag `v*`, avec le panneau Premiere Pro (`Strata-Premiere-<version>-macos.pkg` et `-windows.msi`) et les paquets de mise à jour (`Strata-<version>-<plateforme>`, le serveur seul) que les serveurs installés téléchargent.

## Windows : installateur MSI (recommandé)

Double-cliquez sur **`Strata-<version>-windows-x64.msi`**. Le MSI :
- copie le binaire dans `C:\Program Files\PulseCG` et l'ajoute au `PATH` ;
- crée le service `pulse-cg` (démarrage automatique, redémarrage en cas d'échec) et le démarre ;
- ajoute la règle de pare-feu et les raccourcis *Strata Designer* / *Operator* dans le menu Démarrer ;
- se met à jour en installant simplement une version plus récente (données conservées) ; se désinstalle depuis *Paramètres → Applications*, le raccourci *Uninstall Strata* du menu Démarrer ou le menu de l'icône Strata.

Déploiement silencieux (GPO, Intune, SCCM) :
```powershell
msiexec /i Strata-0.1.0-windows-x64.msi /qn PORT=8080 LISTEN_ADDR=0.0.0.0
```
Lors d'une mise à jour silencieuse, repassez `PORT` si vous l'aviez changé.

## macOS : image disque .dmg (recommandé)

1. Ouvrez **`Strata-<version>-macos-universal.dmg`** (Apple Silicon et Intel).
2. Double-cliquez sur **Install Strata <version>.pkg** et suivez l'assistant (en français ou en anglais selon la langue du Mac).

L'installateur range tout dans **Applications ▸ Strata** :
- **Strata** : l'application de la barre des menus (état du serveur, Designer, Opérateur, Réglages) ;
- **Désinstaller Strata** : supprime Strata en proposant de garder ou d'effacer les données.

Le serveur tourne comme service système (launchd) et démarre avec le Mac ; l'application de la barre des menus démarre à l'ouverture de session. Une mise à jour s'installe par-dessus et conserve les données.

> Tant que le paquet n'est pas signé avec un certificat Apple *Developer ID* et notarisé, macOS affiche « développeur non identifié » : ouvrez *Réglages Système → Confidentialité et sécurité* et cliquez sur **Ouvrir quand même**, ou installez en ligne de commande : `sudo installer -pkg "/Volumes/Strata <version>/Install Strata <version>.pkg" -target /`. La CI signe et notarise automatiquement dès que les secrets `MACOS_CERTS_P12`, `MACOS_CERTS_PASSWORD`, `MACOS_APP_IDENTITY`, `MACOS_INSTALLER_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID` et `APPLE_APP_PASSWORD` sont configurés dans le dépôt.

Désinstallation : **Applications ▸ Strata ▸ Désinstaller Strata**, le menu *Uninstall Strata…* de l'icône, ou en ligne de commande `sudo /usr/local/pulse-cg/uninstall.sh` (`--purge` pour effacer aussi les données).

## Ubuntu (serveur)

```bash
tar xzf Strata-*-ubuntu-x64.tar.gz && cd Strata-*/
sudo ./install.sh                      # options : --bind 0.0.0.0:80 --data-dir /srv/pulse-cg
```
Le binaire est copié dans `/opt/pulse-cg` (lien `/usr/local/bin/cg-server`) ; le service tourne sous l'utilisateur `pulse-cg`, en priorité élevée (`Nice=-10`), et peut écouter sur un port < 1024.
Désinstallation : `sudo ./uninstall.sh` (`--purge` pour supprimer aussi les données).

## Archives sans installateur (macOS / Windows)


## L'application « Strata » (macOS et Windows)

Les installateurs `.pkg` et `.msi` ajoutent l'application **Strata** : une icône dans la barre des menus (macOS) ou la zone de notification (Windows). Elle démarre à l'ouverture de session et donne :

- l'état du serveur (nom, port, en marche ou arrêté) ;
- l'accès direct au **Designer**, à l'**Opérateur**, aux **Réglages** et à la sortie HTML5 ;
- **Redémarrer le moteur**, **Démarrer / Arrêter le serveur** (le mot de passe administrateur est demandé).

Elle se trouve aussi dans *Applications* (macOS) et dans le menu Démarrer (Windows). L'ouvrir depuis ces emplacements ouvre directement le Designer.

## Réglages du serveur

Toute la configuration se fait dans la page **Réglages** (`http://<serveur>:8080/settings`) et s'applique sans réinstaller : le moteur redémarre en une seconde environ.

- **Serveur** : nom, interface réseau et port d'écoute de l'interface web et de l'API (la page vous suit sur le nouveau port), fuseau horaire par défaut des horloges, accès libre ou non aux pages de sortie HTML5.
- **Chaînes de sortie** : une par studio ou par régie, chacune avec :
  - son **format vidéo** : 1080p 25/29.97/50/59.94/60, 720p, 2160p (UHD) ;
  - ses **sorties ST 2110** : destinations multicast fill et key, choix de la carte du réseau média, TTL ; liens vers les fichiers SDP ;
  - ses **sorties SDI** (DeckLink) : périphérique et mode de keying.
- **Système** : version, dossier de données, durée de fonctionnement, liens utiles.

Ces réglages sont enregistrés dans `config.json`, dans le dossier de données. Les réglages d'une version 0.1 (`outputs.json`, `project.json`) sont migrés automatiquement.

La page **Réglages** est réservée aux administrateurs. Les comptes se gèrent dans la page **Utilisateurs**.

## Après l'installation

1. Ouvrez `http://localhost:8080` **sur le serveur** et créez le compte administrateur. Sur un serveur sans écran, lancez plutôt `sudo cg-server user add admin` (dans un terminal administrateur sous Windows).
2. Dans **Utilisateurs**, créez les comptes des designers et des opérateurs, avec si besoin les projets et les chaînes auxquels ils ont accès.
3. Dans **Réglages**, créez une chaîne par studio ou par régie, avec ses sorties.

Adresses utiles :

- Web app (projets, designer, opérateur) : `http://<serveur>:8080/`
- Sortie HTML5 d'une chaîne (OBS, vMix, CasparCG) : `http://<serveur>:8080/output/<chaîne>`, par exemple `/output/main`

Les sorties ST 2110 / SDI se configurent dans la page **Réglages** (`/settings`).

## Mettre à jour sans désinstaller (OTA)

La carte **Mises à jour** de la page **Réglages** (admins) met le serveur à jour sur place : les données, les comptes et les réglages ne bougent pas.

- **En ligne** : *Vérifier* interroge les releases GitHub du projet. Le dépôt étant privé, il faut saisir une fois un **token GitHub fine-grained** avec l'accès en lecture seule *Contents* sur ce dépôt. Le token reste sur le serveur, dans `<données>/update/`. La vérification automatique (toutes les 6 heures) ne fait que signaler une nouvelle version ; l'installation reste toujours une décision manuelle.
- **Hors ligne** : téléchargez le paquet de mise à jour de votre plateforme depuis la page de la release (`Strata-<version>-macos-arm64.tar.gz`, `-macos-x86_64.tar.gz`, `-windows-x86_64.zip` ou `-linux-x86_64.tar.gz` : le serveur seul), puis déposez-le avec *Importer un paquet*. Les installateurs (`.pkg`, `.msi`) et le paquet Ubuntu sont acceptés aussi : le serveur en extrait le programme (avec `pkgutil` sur macOS, une installation administrative de `msiexec` sur Windows) sans rien installer d'autre.

Le serveur :

1. vérifie l'empreinte SHA-256 publiée par GitHub ;
2. lance le nouveau programme pour s'assurer qu'il fonctionne sur cette machine ;
3. garde l'ancien programme à côté (`cg-server.previous`) ;
4. redémarre : les graphiques à l'antenne sont coupés quelques secondes.

Si la nouvelle version n'arrive pas à démarrer trois fois de suite, l'ancienne est **restaurée automatiquement**. Le bouton *Revenir à …* permet aussi de revenir en arrière à la main.

Sous Linux, l'installateur donne au compte de service le droit d'écrire dans `/opt/pulse-cg`. Une installation antérieure à la 0.3 doit relancer une fois `sudo ./install.sh`. La mise à jour web remplace le serveur, qui embarque l'interface web. L'application de la barre des menus se met à jour avec l'installateur `.pkg` / `.msi`.

L'API correspondante : `GET /api/system/update`, `POST /api/system/update/check`, `POST /api/system/update/install`, `POST /api/system/update/upload` (corps = l'archive), `POST /api/system/update/rollback`.

## Gérer le service

Les mêmes commandes fonctionnent sur les trois OS (avec `sudo` ou dans un terminal administrateur) :

```
cg-server service status
cg-server service stop
cg-server service start
cg-server service uninstall
cg-server service install --bind 0.0.0.0:8080 --data-dir <dossier>
```

## ffmpeg (flux vidéo, entrées, vidéos)

Les sorties **Stream** (SRT, UDP, RTMP, HLS), les **entrées en direct** (sauf NDI) et la conversion des vidéos passent par **ffmpeg**. Les installateurs et les archives l'embarquent dans `bin/` à côté du serveur (`C:\Program Files\PulseCG\bin\ffmpeg.exe`, `/usr/local/pulse-cg/bin/ffmpeg`, `/opt/pulse-cg/bin/ffmpeg`). Une installation antérieure le reçoit avec sa prochaine mise à jour par le web.

Le serveur cherche ffmpeg dans cet ordre : la variable `FFMPEG_PATH`, `ffmpeg` ou `bin/ffmpeg` à côté de `cg-server`, puis le `PATH`. Il le relit à chaque lancement : inutile de redémarrer, cliquez sur *Appliquer* dans **Flux vidéo** (les entrées réessayent seules).

Il faut un ffmpeg avec **libx264** (et libx265 pour le HEVC) et les protocoles **srt** et **rtmp**. Pour vérifier :
```bash
ffmpeg -hide_banner -protocols | grep -E "^ +(srt|rtmp)$"
ffmpeg -hide_banner -encoders  | grep -E "libx264|libx265"
```

### Installer ffmpeg à la main sur macOS

Le service launchd ne voit pas le `PATH` de votre session (ni `/opt/homebrew/bin`) : placez ffmpeg dans `/usr/local/pulse-cg/bin/`.

**Avec Homebrew** :
```bash
brew install ffmpeg
ffmpeg -hide_banner -protocols | grep -w srt || brew install ffmpeg-full   # s'il manque SRT
sudo mkdir -p /usr/local/pulse-cg/bin
sudo ln -sf "$(command -v ffmpeg)" /usr/local/pulse-cg/bin/ffmpeg
```
(`ffmpeg-full` est installé à part : remplacez alors `$(command -v ffmpeg)` par `$(brew --prefix ffmpeg-full)/bin/ffmpeg`.)

**Sans Homebrew** : téléchargez un ffmpeg statique pour macOS, par exemple sur https://ffmpeg.martin-riedl.de (*arm64* pour Apple Silicon, *amd64* pour Intel, version *release*), puis :
```bash
cd ~/Downloads && unzip ffmpeg.zip
sudo mkdir -p /usr/local/pulse-cg/bin
sudo mv ffmpeg /usr/local/pulse-cg/bin/ffmpeg
sudo chmod 755 /usr/local/pulse-cg/bin/ffmpeg
sudo xattr -d com.apple.quarantine /usr/local/pulse-cg/bin/ffmpeg 2>/dev/null
/usr/local/pulse-cg/bin/ffmpeg -version | head -1
```

### Linux et Windows à la main
- Linux : `sudo apt install ffmpeg` (ou un binaire statique dans `/opt/pulse-cg/bin/ffmpeg`).
- Windows : un build « gpl » de https://github.com/BtbN/FFmpeg-Builds/releases, et son `ffmpeg.exe` copié dans `C:\Program Files\PulseCG\bin\`.

ffmpeg est un programme séparé, sous licence GPL pour ces builds (voir `bin/FFMPEG-NOTICE.txt`).

## Lancer sans installer

```
cg-server                       # données dans le profil utilisateur
cg-server --data-dir ./data     # ou dans un dossier choisi
```
Le dossier utilisateur par défaut est `~/.local/share/pulsecg` (Linux), `~/Library/Application Support/com.PulseCG.Pulse-CG` (macOS) ou `%APPDATA%\PulseCG\Strata\data` (Windows). Les variables `CG_BIND`, `CG_DATA_DIR` et `CG_WEB_DIR` remplacent les options équivalentes.

## Notes pour la production broadcast

- **ST 2110** : la machine doit être synchronisée en PTP. Sous Linux, utilisez `ptp4l` + `phc2sys`. Sous Windows Server 2019 ou plus récent, utilisez le service PTP de Windows ou l'agent du fabricant de la carte réseau. Sous macOS, le PTP n'est pas disponible nativement : préférez Linux pour le 2110.
- **SDI** : installez le pilote Blackmagic Desktop Video. La sortie DeckLink nécessite un binaire compilé avec la feature `decklink` (voir `docs/ARCHITECTURE.md`).
- **Multicast** : sur une machine qui a plusieurs interfaces, choisissez la carte du réseau média de chaque sortie dans la page **Réglages**.
- **Mot de passe perdu** : `cg-server user passwd <nom>` sur le serveur.
