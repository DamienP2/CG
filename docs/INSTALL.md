# Installer le serveur Pulse CG

Le serveur tient dans **un seul exécutable**, `cg-server`. Il contient le moteur de rendu, l'API, la web app (Designer, Opérateur, sortie HTML5) et les polices Inter. Il n'a besoin ni de Node, ni de navigateur, ni de runtime à installer sur le serveur.

| OS | Paquet | Service | Données | Journaux |
| --- | --- | --- | --- | --- |
| Linux x86_64 / arm64 (toutes distributions, binaire statique) | `pulse-cg-<version>-linux-*.tar.gz` | systemd `pulse-cg` (compte système dédié) | `/var/lib/pulse-cg` | `journalctl -u pulse-cg -f` |
| macOS 11 ou plus récent (Apple Silicon / Intel) | **`PulseCG-<version>-macos-universal.pkg`** ou `pulse-cg-<version>-macos-*.tar.gz` | launchd `com.pulsecg.server` | `/Library/Application Support/PulseCG` | `/Library/Logs/PulseCG/cg-server.log` |
| Windows Server 2016 ou plus récent / Windows 10+ x64 | **`PulseCG-<version>-windows-x64.msi`** ou `pulse-cg-<version>-windows-x86_64.zip` | service Windows `pulse-cg` (démarrage auto, redémarrage sur échec) | `C:\ProgramData\PulseCG` | `C:\ProgramData\PulseCG\logs\cg-server.log` |

Les paquets sont produits par la CI (`.github/workflows/release.yml`) à chaque tag `v*`.

## Windows : installateur MSI (recommandé)

Double-cliquez sur **`PulseCG-<version>-windows-x64.msi`**. Le MSI :
- copie le binaire dans `C:\Program Files\PulseCG` et l'ajoute au `PATH` ;
- crée le service `pulse-cg` (démarrage automatique, redémarrage en cas d'échec) et le démarre ;
- ajoute la règle de pare-feu et les raccourcis *Pulse CG Designer* / *Operator* dans le menu Démarrer ;
- se met à jour en installant simplement une version plus récente (données conservées) ; se désinstalle depuis *Paramètres → Applications*.

Déploiement silencieux (GPO, Intune, SCCM) :
```powershell
msiexec /i PulseCG-0.1.0-windows-x64.msi /qn PORT=8080 LISTEN_ADDR=0.0.0.0
```
Lors d'une mise à jour silencieuse, repassez `PORT` si vous l'aviez changé.

## macOS : installateur .pkg (recommandé)

Double-cliquez sur **`PulseCG-<version>-macos-universal.pkg`** (Apple Silicon et Intel) et suivez l'assistant. Le binaire va dans `/usr/local/pulse-cg` ; le service launchd est enregistré et démarré à la fin. Une mise à jour conserve les données.

> Tant que le paquet n'est pas signé avec un certificat Apple *Developer ID* et notarisé, macOS affiche « développeur non identifié » : faites **clic droit → Ouvrir**, ou *Réglages Système → Confidentialité et sécurité → Ouvrir quand même*. La CI signe et notarise automatiquement dès que les secrets `MACOS_CERTS_P12`, `MACOS_CERTS_PASSWORD`, `MACOS_APP_IDENTITY`, `MACOS_INSTALLER_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID` et `APPLE_APP_PASSWORD` sont configurés dans le dépôt.

Désinstallation : `sudo /usr/local/pulse-cg/uninstall.sh` (`--purge` pour supprimer aussi les données).

## Linux

```bash
tar xzf pulse-cg-*-linux-x86_64.tar.gz && cd pulse-cg-*/
sudo ./install.sh                      # options : --bind 0.0.0.0:80 --data-dir /srv/pulse-cg
```
Le binaire est copié dans `/opt/pulse-cg` (lien `/usr/local/bin/cg-server`) ; le service tourne sous l'utilisateur `pulse-cg`, en priorité élevée (`Nice=-10`), et peut écouter sur un port < 1024.
Désinstallation : `sudo ./uninstall.sh` (`--purge` pour supprimer aussi les données).

## Archives sans installateur (macOS / Windows)

Les archives `.tar.gz` / `.zip` restent disponibles pour une installation scriptée : `sudo ./install.sh` sur macOS, `install.cmd` ou `.\install.ps1` (PowerShell administrateur) sur Windows.

## Après l'installation

- Designer : `http://<serveur>:8080/designer`
- Opérateur : `http://<serveur>:8080/operator`
- Sortie HTML5 (OBS, vMix, CasparCG) : `http://<serveur>:8080/output`

Pour configurer les sorties ST 2110 / SDI, copiez `outputs.example.json` vers `outputs.json` dans le dossier de données, adaptez-le, puis redémarrez le service.

## Gérer le service

Les mêmes commandes fonctionnent sur les trois OS (avec `sudo` ou dans un terminal administrateur) :

```
cg-server service status
cg-server service stop
cg-server service start
cg-server service uninstall
cg-server service install --bind 0.0.0.0:8080 --data-dir <dossier>
```

## Lancer sans installer

```
cg-server                       # données dans le profil utilisateur
cg-server --data-dir ./data     # ou dans un dossier choisi
```
Le dossier utilisateur par défaut est `~/.local/share/pulsecg` (Linux), `~/Library/Application Support/com.PulseCG.Pulse-CG` (macOS) ou `%APPDATA%\PulseCG\Pulse CG\data` (Windows). Les variables `CG_BIND`, `CG_DATA_DIR` et `CG_WEB_DIR` remplacent les options équivalentes.

## Notes pour la production broadcast

- **ST 2110** : la machine doit être synchronisée en PTP. Sous Linux, utilisez `ptp4l` + `phc2sys`. Sous Windows Server 2019 ou plus récent, utilisez le service PTP de Windows ou l'agent du fabricant de la carte réseau. Sous macOS, le PTP n'est pas disponible nativement : préférez Linux pour le 2110.
- **SDI** : installez le pilote Blackmagic Desktop Video. La sortie DeckLink nécessite un binaire compilé avec la feature `decklink` (voir `docs/ARCHITECTURE.md`).
- **Multicast** : sur une machine qui a plusieurs interfaces, renseignez `interface` dans `outputs.json` pour choisir la carte du réseau média.
