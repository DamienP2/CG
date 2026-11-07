# Strata Studio : proposition de départ (v2)

> Statut : **proposition**, à discuter. Rien n'est encore implémenté.
> Ce document vit ici en attendant le dépôt `Strata-Studio`.

**Strata Studio** rend un studio de podcast ou de radio filmée **autonome**. Un journaliste prépare et lance son émission depuis une **tablette en Wi-Fi** : lumière, enregistrement, direct, ON AIR. Une **IA locale** commute le mélangeur (ATEM ou vMix) et prépare les caméras PTZ. Il n'y a pas de réalisateur. Un réalisateur peut **reprendre la main** à tout moment, sur la régie ou à distance.

Studio est un **système de contrôle**. Il pilote le nodal, le mélangeur, les caméras, la lumière et les enregistreurs, mais **aucune image ne passe par lui**. S'il s'arrête, le studio reste dans son dernier état et l'antenne continue.

---

## 0. Les décisions prises

| Sujet | Décision |
| --- | --- |
| Réalisation | **Automatique** par une IA interne et locale ; reprise en main possible par un réalisateur |
| Mélangeur | **Piloté** : Blackmagic ATEM ou vMix (pas de mélangeur interne) |
| Direct et enregistré | les deux, **au travers d'un nodal piloté par Studio** |
| Caméras | 4 PTZ **Sony FR7 ou BRC-AM7** |
| Intervenants | jusqu'à **5** |
| Micros | **Dante** |
| Code | **dépôt à part**, sur le modèle de Strata Multiview |
| Priorité | le **contrôle**, et la **tablette des journalistes** |

---

## 1. Le studio piloté

```
                          ┌──────────────── Strata Studio (serveur, GPU) ────────────────┐
  Tablette Wi-Fi ───WS───►│  Scénarios d'émission · IA de commutation · Reprise en main  │◄── Réalisateur
  (journaliste)           │  Pilotes : mélangeur · nodal · PTZ · lumière · enregistreurs │    (régie ou distant)
                          └──┬────────┬─────────┬─────────┬──────────┬──────────┬────────┘
              contrôle seul  │        │         │         │          │          │
                     ┌───────▼──┐ ┌───▼────┐ ┌──▼─────┐ ┌─▼──────┐ ┌─▼───────┐ ┌▼────────────────┐
                     │  Nodal   │ │ ATEM / │ │ 4 PTZ  │ │Lumière │ │Enregis- │ │ Strata Graphics │
                     │ (routes) │ │ vMix   │ │FR7·AM7 │ │DMX     │ │treurs   │ │ Multiview       │
                     └───▲──────┘ └──▲─────┘ └──┬─────┘ └────────┘ └─────────┘ │ OnAir Studio    │
  signal :               │           │          │                               └─────────────────┘
  caméras ──────────────►├──────────►│ PGM ────►├──► diffusion, encodeurs, enregistreurs
                         └───────────┘          │
  micros Dante ──► console / DSP ──► programme  │
            └──► copie AES67 ──► Studio (analyse seulement)
  caméras ──► flux IP basse définition ──► Studio (analyse seulement)
```

Studio reçoit deux choses pour **analyser** : une copie des micros en AES67 et un flux réduit de chaque caméra. Il **envoie** des commandes et lit les retours d'état des appareils.

---

## 2. Ce que Studio pilote

| Appareil | Protocole | Ce que Studio fait | Base existante |
| --- | --- | --- | --- |
| **ATEM** | UDP 9910 | programme et preview, cut et mix, macros, SuperSource, keyers, aux, enregistrement et stream (modèles ISO) ; lit le tally et **détecte une action humaine sur le pupitre** | client ATEM de Strata Multiview (`tally/atem.rs`, en lecture : à étendre aux commandes) |
| **vMix** | API TCP 8099 | cut, fondu, inputs, overlays, enregistrement, stream ; état et tally | à écrire |
| **Nodal** | selon le modèle : Videohub (TCP 9990), SW-P-08 (Probel), NMOS IS-05, Ember+ | routes par émission (salves) : PGM vers la diffusion et les enregistreurs, retours, multiview | IS-05 et Ember+ dans Strata Multiview |
| **Sony FR7 / BRC-AM7** | VISCA over IP, CGI HTTP ; OpenTrackIO (FR7) | presets, pan, tilt, zoom, vitesses, mise au point, exposition ; position réelle de la tête ; suivi automatique intégré si le modèle et le firmware l'ont (à vérifier) | OpenTrackIO dans Strata Graphics (`tracking.rs`) |
| **Micros Dante** | AES67 (SAP, RTP L24 48 kHz) ou carte son Dante | copie de chaque micro pour l'analyse ; présence du signal pour le contrôle avant antenne | `dante.rs` de Strata Multiview |
| **Lumière** | Art-Net, sACN (E1.31) ; OSC ou MIDI vers une console | scènes : préparation, antenne, pause, extinction ; intensité générale | à écrire |
| **Enregistreurs** | ATEM ISO, HyperDeck (TCP 9993), vMix | démarrer, arrêter, nommer les fichiers, vérifier l'espace libre | à écrire |
| **ON AIR, chrono** | API REST d'OnAir Studio | voyant ON AIR, chrono d'antenne, parties | API existante d'OnAir Studio |
| **Habillage** | API de Strata Graphics | noms des invités, synthé de celui qui parle, jingles | API existante |
| **Multiview** | TSL 5.0, API | UMD : « IA · Cam 2 · Alice », « MANUEL · Paul » | Strata Multiview lit déjà le TSL |

Chaque pilote est derrière une interface commune (`Switcher`, `Router`, `Camera`, `Lights`, `Recorder`, `Signal`) et a un **simulateur**. Studio se teste et se démontre sans matériel.

### 2.1 État voulu, état réel

Studio garde l'**état voulu** de chaque appareil (routes, scène lumière, presets, enregistrement). Il le compare en continu à l'**état réel** lu sur l'appareil.

- Un appareil qui redémarre ou se reconnecte retrouve l'état voulu.
- Une différence inattendue (une route changée à la main, un enregistreur arrêté) lève une alerte sur la tablette et dans la régie.
- Toutes les commandes sont **idempotentes** : une commande répétée parce que le Wi-Fi a hésité ne fait rien de plus.

---

## 3. La tablette des journalistes

C'est l'outil principal. Une application web installable (iPad ou Android), servie par Studio en Wi-Fi. Elle est pensée pour quelqu'un qui n'est **pas technicien**.

### 3.1 Le déroulé

| Écran | Ce que fait le journaliste | Ce que Studio fait |
| --- | --- | --- |
| **Accueil** | choisit son émission (ou le créneau du planning) | charge le scénario de l'émission |
| **Préparation** | place les noms des invités sur le plan du plateau (places 1 à 5) | lumière « préparation », presets PTZ, routes du nodal, noms vers Strata Graphics |
| **Vérification** | chaque invité dit une phrase | contrôle automatique : chaque micro a du signal et la bonne personne est détectée, les caméras répondent, l'enregistreur a de la place, le nodal et le mélangeur sont connectés. Tout est vert ou on sait quoi faire |
| **Antenne** | **ENREGISTRER** ou **DIRECT** | lumière « antenne », enregistrements, routes de diffusion, ON AIR, chrono, jingle, IA en marche |
| **Pendant** | quelques boutons simples, si l'émission les autorise : *Plan large*, *Jingle*, *Synthé*, *Pause* | l'IA en tient compte et ne fait pas de coupe absurde |
| **Fin** | **TERMINER** (appui long pour confirmer) | arrêt propre, lumière « fin », fichiers nommés et déposés, résumé : durée, fichiers, alertes |

Chaque émission a un **scénario** réglé une fois par un admin : ses états (préparation, prêt, antenne, pause, fin) et, pour chacun, la **salve** d'actions à lancer.

### 3.2 La fiabilité en Wi-Fi

- La tablette est une **télécommande, pas un cerveau** : l'état vit dans Studio. Perdre la tablette, la fermer ou perdre le Wi-Fi n'arrête rien.
- Reconnexion automatique ; l'écran se recale sur l'état réel.
- Les actions irréversibles (arrêter un enregistrement, couper le direct) demandent un **appui long**.
- Plusieurs tablettes peuvent suivre le même studio ; une seule a la main à la fois.
- Secours physique dans le studio : un Stream Deck avec les mêmes actions.

### 3.3 Sécurité

- La tablette est **appairée** au studio, comme les postes de production de Strata Graphics (`stations.rs`).
- Chaque journaliste se reconnaît par un code court ou par l'annuaire de l'entreprise (SSO).
- Le Wi-Fi des tablettes n'atteint que Studio, pas les appareils. Studio est le seul à parler au nodal, au mélangeur et aux caméras.

---

## 4. L'IA de commutation

### 4.1 Locale

Tout tourne **sur le serveur Studio**, avec sa carte graphique NVIDIA. Aucun son, aucune image ni aucun texte ne sort du studio. Les modèles s'exécutent avec ONNX Runtime (CUDA ou TensorRT), comme le segmenteur de personnes de Strata Graphics (`people_net.rs`).

### 4.2 Trois couches

| Couche | Délai | Rôle | Modèles envisagés |
| --- | --- | --- | --- |
| **Perception** | 10 à 40 ms | qui parle : voix sur chaque micro (VAD), micro dominant malgré la repisse ; visages, lèvres qui bougent, orientation de la tête sur chaque caméra ; **locuteur actif** en croisant le son et l'image | Silero VAD (MIT), détection de visages MediaPipe (Apache 2.0), modèle de locuteur actif audio-vidéo |
| **Anticipation** | 100 à 500 ms | **qui va parler** : fin d'une question, regard vers un invité, prise de souffle, main levée | modèle de prise de parole (*turn-taking*), entraîné sur les émissions du studio |
| **Compréhension** | 0,5 à 2 s, optionnelle | ce qui se dit : une question adressée à quelqu'un par son nom, un rire général, un changement de sujet | transcription locale (Whisper, MIT) et petit modèle de langage local |

### 4.3 Pourquoi l'anticipation est centrale

Le signal passe par l'ATEM ou par vMix. Studio **ne peut pas retarder l'image** pour couper au bon moment. Ajouter un retard dans le nodal décalerait tout le studio, retours compris. Une IA qui attend d'entendre la voix coupe donc toujours en retard d'une demi-seconde.

La solution est de **prédire** :

- la coupe vers l'invité qui va répondre tombe au début de sa réponse ;
- la PTZ qui n'est pas à l'antenne est **déjà cadrée** sur lui.

En **enregistré**, l'IA peut de plus refaire le montage après coup, avec tout le recul, à partir des ISO.

### 4.4 Quatre caméras pour cinq personnes

Avec un plan large et trois PTZ pour cinq personnes, toutes ne peuvent pas avoir leur plan serré prêt. L'IA **répartit les caméras en continu** :

- une caméra est à l'antenne ;
- les autres se cadrent sur les **personnes les plus probables ensuite**, ou sur un plan à deux ;
- une caméra à l'antenne **ne bouge jamais**, sauf en recadrage lent si le profil l'autorise ;
- le large est le plan de repli quand rien d'autre n'est prêt.

### 4.5 Des règles comme garde-fous, l'IA pour choisir

La décision a deux étages :

1. **Les règles** fixent ce qui est **interdit ou obligatoire** : durée minimale et maximale d'un plan, pas de plan en mouvement, pas de caméra sans personne, pas deux fois le même plan de coupe. Elles sont lisibles et réglables par profil (*Podcast posé*, *Débat*, *Interview*, *Radio filmée*).
2. **L'IA classe les plans permis** à chaque image : qui parle, qui va parler, qui réagit, la qualité du cadre, la variété.

Au départ, le classement est une formule réglée à la main. Il devient un modèle appris dès qu'il y a des données (§ 5.3).

Le Réalisateur reste une **fonction pure**, des perceptions vers les décisions. On peut enregistrer les perceptions d'une émission et la **rejouer** avec un autre profil ou un autre modèle. Chaque coupe porte sa **raison** (« Alice répond à la question de Paul », « plan tenu 12 s, coupe sur le large »).

---

## 5. La reprise en main

### 5.1 Trois façons de reprendre la main

| Comment | Effet |
| --- | --- |
| **Toucher le pupitre ATEM ou vMix** | Studio voit une coupe qu'il n'a pas commandée : l'IA **se suspend aussitôt**. C'est la reprise la plus naturelle pour un réalisateur |
| **« Prendre la main »** sur la page Régie (sur place ou à distance) ou sur un Stream Deck | idem, avec le nom de celui qui a la main |
| **Reprise partielle** | verrouiller une caméra (l'IA ne la prend plus et ne la bouge plus), interdire un plan, forcer un plan pendant N secondes, figer les PTZ |

**« Rendre la main à l'IA »** est un geste explicite. L'IA repart du plan en cours, sans couper aussitôt.

Partout, l'état est visible : tablette, page Régie, UMD du multiview. Par exemple « IA », « MANUEL · Paul » ou « IA · Cam 3 verrouillée ».

### 5.2 Les priorités

**Réalisateur > Journaliste (tablette) > IA.** Par défaut, le journaliste ne coupe pas ; il peut demander un plan large si le scénario le permet. Ce qui touche la sécurité (arrêt du direct, extinction) suit les droits de chacun.

### 5.3 Le mode « ombre » et l'apprentissage

- **Mode ombre** : l'IA tourne, décide, mais ne commande pas. On compare ses choix à ceux d'un réalisateur humain sur de vraies émissions. C'est la meilleure façon de la mettre au point et de gagner la confiance des équipes, avant de lui confier l'antenne.
- **Chaque reprise en main est une leçon** : ce que le réalisateur a fait, au moment où l'IA aurait fait autre chose, est gardé (en local) pour entraîner le classement des plans.

---

## 6. Architecture logicielle

Dépôt **`Strata-Studio`**, organisé comme Strata Multiview : un workspace Rust, des crates propres à l'application, un exécutable par plateforme, une interface web.

```
crates/
  strata-studio-core      modèle (studio, émissions, scénarios, appareils), Réalisateur (pur), règles, profils
  strata-studio-sense     perception : AES67, VAD, dominance, vision (visages, lèvres), transcription
  strata-studio-devices   pilotes et simulateurs : atem, vmix, videohub, swp08, nmos, ember, visca, sony-cgi,
                          artnet/sacn, hyperdeck, onair-studio, strata-graphics, tsl
  strata-studio-server    exécutable strata-studio : axum, API REST et WS, scénarios et salves,
                          état voulu / réel, journal, comptes, tablettes appairées
  strata-studio-tray      appli de la zone de notification / barre des menus
web/
  régie et administration (ordinateur)
  tablette (application web installable)
```

### Repris des autres applications Strata

| Brique | Source |
| --- | --- |
| comptes, SSO, service natif, mises à jour, performances, journaux, appli de la barre des menus | Strata Graphics (`auth.rs`, `sso.rs`, `service.rs`, `update.rs`, `perf.rs`, `logs.rs`, `cg-tray`) |
| postes appairés (pour les tablettes) | Strata Graphics (`stations.rs`) |
| inférence ONNX sur GPU ou CPU | Strata Graphics (`people_net.rs`) |
| OpenTrackIO (position des FR7) | Strata Graphics (`tracking.rs`) |
| client ATEM, TSL | Strata Multiview (`tally/`) |
| Dante / AES67 et découverte SAP | Strata Multiview (`dante.rs`) |
| NMOS IS-05, Ember+, salves | Strata Multiview (`nmos.rs`, `ember.rs`, `salvos.rs`) |
| voyant ON AIR, chrono | OnAir Studio, par son API |

### Serveur

Une machine Linux avec une carte NVIDIA, sur le réseau de contrôle et sur le réseau Dante. Les tablettes arrivent par un Wi-Fi séparé qui ne voit que Studio. La puissance nécessaire (décodage de 4 flux caméra réduits, modèles de vision, transcription de 5 micros) sera mesurée à l'étape 0.

---

## 7. Étapes proposées

**Étape 0 : le socle de contrôle et l'IA en ombre**
- Pilotes ATEM et vMix (cut, preview, macros, tally, détection d'une action humaine) et leurs simulateurs.
- Presets VISCA sur FR7 et AM7.
- Réception des micros Dante en AES67, VAD et micro dominant.
- Réalisateur sur l'audio seul, en **mode ombre** sur de vraies émissions, avec une mesure de l'accord entre l'IA et le réalisateur humain.

**Étape 1 : le studio autonome**
- Tablette : scénarios d'émission, préparation, vérification, antenne, fin.
- Lumière (Art-Net / sACN), enregistreurs, ON AIR et chrono (OnAir Studio), nodal (pilote selon le modèle).
- IA aux commandes, avec répartition dynamique des PTZ.
- Page Régie et reprise en main.

**Étape 2 : l'IA qui voit et qui anticipe**
- Vision : visages, lèvres, locuteur actif audio-vidéo.
- Prédiction de la prise de parole.
- Noms et synthés dans Strata Graphics ; UMD dans Strata Multiview.
- Montage refait après coup pour l'enregistré (ISO et export FCPXML, XML Premiere, OTIO).

**Étape 3 : l'IA qui comprend et qui apprend**
- Transcription et modèle de langage locaux.
- Classement des plans appris sur les reprises en main.
- Plusieurs studios par serveur.

---

## 8. Risques identifiés

| Risque | Parade |
| --- | --- |
| L'IA coupe en retard (le signal ne peut pas être retardé) | prédiction de la prise de parole, PTZ prêtes à l'avance, plans de repli larges |
| Repisse entre micros | calibrage à la vérification, comparaison relative, confirmation par l'image |
| Wi-Fi instable | la tablette n'est qu'une télécommande, commandes idempotentes, Stream Deck de secours |
| Un appareil change d'état à l'insu de Studio | état voulu / réel, alertes |
| Confiance des équipes | mode ombre, raisons affichées, reprise en main par le simple pupitre |
| Puissance de calcul | flux réduits pour l'analyse, mesures dès l'étape 0 |

---

## 9. Questions ouvertes

1. **Nodal** : quelle marque et quel modèle ? SDI ou IP (ST 2110, NDI) ? Quel protocole de contrôle ?
2. **Mélangeur** : quel modèle d'ATEM (ISO ? SuperSource ?) ou quelle version de vMix ? L'un des deux d'abord ?
3. **Lumière** : projecteurs DMX pilotés directement (Art-Net / sACN), ou une console à déclencher ?
4. **Audio** : qui fait le mélange du programme (console, DSP) ? Studio doit-il piloter des coupures de micro (toux) ?
5. **Tablette** : iPad ? Comment les journalistes s'identifient-ils (code, badge, SSO) ?
6. **Destinations** : où vont le direct (encodeurs, plateformes) et les enregistrements (NAS, MAM) ?
7. **OnAir Studio** : faut-il s'appuyer dessus pour le voyant ON AIR et le chrono ?
8. **Dépôt** : créer `DamienP2/Strata-Studio` (je ne peux pas créer de dépôt depuis cette session).
