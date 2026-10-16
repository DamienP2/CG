# Installer le serveur Pulse CG

Le serveur tient dans **un seul exécutable**, `cg-server`. Il contient le moteur de rendu, l'API, la web app (Designer, Opérateur, sortie HTML5) et les polices Inter. Il n'a besoin ni de Node, ni de navigateur, ni de runtime à installer sur le serveur.

| OS | Paquet | Service | Données | Journaux |
| --- | --- | --- | --- | --- |
| Linux x86_64 / arm64 (toutes distributions, binaire statique) | `pulse-cg-<version>-linux-*.tar.gz` | systemd `pulse-cg` (compte système dédié) | `/var/lib/pulse-cg` | `journalctl -u pulse-cg -f` |
| macOS 11 ou plus récent (Apple Silicon / Intel) | `pulse-cg-<version>-macos-*.tar.gz` | launchd `com.pulsecg.server` | `/Library/Application Support/PulseCG` | `/Library/Logs/PulseCG/cg-server.log` |
| Windows Server 2016 ou plus récent / Windows 10+ x64 | `pulse-cg-<version>-windows-x86_64.zip` | service Windows `pulse-cg` (démarrage auto, redémarrage sur échec) | `C:\ProgramData\PulseCG` | `C:\ProgramData\PulseCG\logs\cg-server.log` |

Les paquets sont produits par la CI (`.github/workflows/release.yml`) à chaque tag `v*`.

## Linux

```bash
tar xzf pulse-cg-*-linux-x86_64.tar.gz && cd pulse-cg-*/
sudo ./install.sh                      # options : --bind 0.0.0.0:80 --data-dir /srv/pulse-cg
```
Le binaire est copié dans `/opt/pulse-cg`, avec un lien `/usr/local/bin/cg-server`. Le service tourne sous l'utilisateur `pulse-cg`, avec une priorité augmentée (`Nice=-10`) ; il peut écouter sur un port inférieur à 1024.
Désinstallation : `sudo ./uninstall.sh` (ajoutez `--purge` pour supprimer aussi les données).

## macOS

```bash
tar xzf pulse-cg-*-macos-arm64.tar.gz && cd pulse-cg-*/
sudo ./install.sh
```
Le binaire est copié dans `/usr/local/pulse-cg`. Le script retire l'attribut de quarantaine Gatekeeper, car le paquet n'est pas encore signé ni notarisé. Le service démarre au boot.
Désinstallation : `sudo ./uninstall.sh [--purge]`.

## Windows

1. Dézippez l'archive.
2. Double-cliquez sur **`install.cmd`** (une élévation administrateur est demandée), ou lancez dans un PowerShell administrateur :
   ```powershell
   .\install.ps1 -Bind 0.0.0.0:8080
   ```
Le binaire est copié dans `C:\Program Files\PulseCG`. Le script crée le service `pulse-cg` (compte LocalSystem, démarrage automatique, redémarrage en cas d'échec) et ajoute une règle de pare-feu entrante pour l'exécutable.
Désinstallation : `.\uninstall.ps1 [-Purge]`.

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
