# Réseau et synchronisation

Strata ne discipline pas l'horloge de la machine lui-même : c'est le système qui
le fait (NTP, ou PTP avec linuxptp). Strata lit leur état, cale ses canaux
dessus et prévient quand la synchro est perdue (page **Performance**). Les
réglages sont dans **Matériel › Réseau** et **Matériel › Synchronisation**.

## Rôles réseau

Chaque rôle désigne une carte réseau par son nom (`eth1`, `en0`…). Ce nom ne
change pas quand l'adresse IP change.

| Rôle | Effet |
|---|---|
| **Contrôle** | L'interface web et l'API n'écoutent que sur cette carte (plus `127.0.0.1`, pour que la machine elle-même garde l'accès). Sans effet quand une adresse est imposée en ligne de commande (`--bind`). |
| **NDI** | NDI n'envoie et ne cherche des sources que sur cette carte. Strata écrit `ndi-config.v1.json` dans `<données>/ndi/` et y fait pointer le runtime (`NDI_CONFIG_DIR`). Le runtime NDI ne lit ce fichier qu'au démarrage : un changement s'applique au **redémarrage du serveur**. |
| **Serveur de découverte NDI** | Adresse(s) d'un NDI Discovery Server (séparées par des virgules). Vide : découverte mDNS. |
| **Média rouge / Média bleu** | Réseaux ST 2110 primaire et secondaire (SMPTE 2022-7). Un flux sans interface choisie part sur la carte du rôle. Les deux rôles doivent être deux cartes différentes. |
| **PTP** | La carte sur laquelle tourne `ptp4l` (pour mémoire et pour la configuration linuxptp ci-dessous). |

## ST 2110 : redondance SMPTE 2022-7

Dans **Matériel › ST 2110**, un flux peut avoir des destinations **bleues** en
plus des rouges. Chaque paquet part alors sur les deux réseaux, avec les mêmes
numéros de séquence et les mêmes horodatages : le récepteur reconstitue le
flux même si un réseau tombe. Le SDP du flux décrit les deux chemins
(`a=group:DUP primary secondary`, RFC 7104).

Les horodatages RTP comptent le temps **TAI** (ST 2110-10) : l'heure système
(UTC) plus l'écart TAI − UTC, 37 s depuis 2017 (réglable dans
Synchronisation).

## Référence d'horloge des canaux

Dans **Matériel › Synchronisation**, la référence par défaut ; chaque canal
peut en choisir une autre.

- **Libre** : les images sont comptées depuis le démarrage du canal, sur
  l'horloge de la machine. Suffisant pour NDI, les flux SRT/RTMP/HLS et la
  sortie HTML5.
- **PTP** : les images tombent sur la grille SMPTE ST 2059-1 (un multiple de la
  durée d'image depuis l'époque PTP). Tous les équipements calés sur le même
  grand maître montrent leurs images aux mêmes instants. Il faut que l'horloge
  système suive le PTP (voir linuxptp ci-dessous).
- **DeckLink** : le canal suit les tops image de sa première sortie SDI, donc
  la référence (genlock) branchée sur la carte.

## Mettre en place PTP (Linux)

Sur une carte réseau avec horodatage matériel (`ethtool -T eth2` doit
afficher `hardware-transmit` et `hardware-receive`) :

```sh
sudo apt install linuxptp

# /etc/linuxptp/ptp4l.conf : profil SMPTE ST 2059-2
[global]
domainNumber            127
logAnnounceInterval     -2
logSyncInterval         -3
logMinDelayReqInterval  -3
announceReceiptTimeout  3
time_stamping           hardware
slaveOnly               1

sudo ptp4l -i eth2 -f /etc/linuxptp/ptp4l.conf
# L'horloge système suit l'horloge de la carte (et prend l'écart UTC/TAI) :
sudo phc2sys -s eth2 -c CLOCK_REALTIME -w -n 127
```

En production, lancez-les en services (`ptp4l@eth2`, `phc2sys@eth2` selon la
distribution). **Ne laissez pas NTP (chrony, timesyncd) régler la même
horloge** : désactivez-le ou réservez-le aux machines sans PTP.

Strata lit l'état avec `pmc` (paquet linuxptp) toutes les 10 s : état du port
(`SLAVE`), grand maître, écart au maître. Le canal est considéré verrouillé
quand le port est esclave d'un grand maître et que l'écart est sous 10 µs.
`pmc` parle à `ptp4l` par `/var/run/ptp4l` : lancez Strata avec un compte qui
y a accès (root ou le groupe du socket).

macOS et Windows n'ont pas de linuxptp : la référence PTP y aligne bien les
images sur l'horloge système, mais Strata ne peut pas dire si elle est
verrouillée.

## NTP

Sans PTP, l'horloge doit au moins être à l'heure (horloges à l'antenne,
déclenchements programmés). Strata indique si elle est synchronisée :

- Linux : `chronyc tracking` (source, écart), sinon `timedatectl` ;
- Windows : `w32tm /query /status` ;
- macOS : `systemsetup -getusingnetworktime` (n'aboutit qu'avec des droits
  administrateur).

## DeckLink

Les cartes Blackmagic se pilotent avec le pilote **Desktop Video** installé
sur la machine : Strata embarque les en-têtes du SDK (licence libre de
Blackmagic) et charge la bibliothèque du pilote à l'ouverture d'une sortie
ou d'une entrée. Un canal en référence **DeckLink** cale ses images sur les
tops de sa première sortie SDI : la carte suit la référence (genlock)
branchée sur son entrée REF, sinon son propre quartz. Si la carte ne donne
plus de tops, le canal continue sur l'horloge de la machine.

Le paquet Ubuntu (glibc) charge le pilote comme les installateurs macOS et
Windows ; un serveur compilé en statique (musl) ne le peut pas. Voir `crates/cg-output/src/sdi.rs`.
