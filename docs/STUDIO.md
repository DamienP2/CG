# Strata Studio : proposition de départ

> Statut : **proposition**, à discuter. Rien n'est encore implémenté.

**Strata Studio** est un serveur de **réalisation automatique** pour les studios de type podcast filmé ou radio filmée. Il capte les caméras et les micros du plateau, comprend qui parle et choisit le plan. Il compose le programme, l'enregistre et le diffuse sans réalisateur. Un opérateur peut reprendre la main à tout moment.

Studio rejoint Strata Graphics dans la galaxie Strata. Il reprend les mêmes principes : un exécutable par plateforme, une interface web, un moteur en Rust, les sorties NDI, SRT, SDI et ST 2110, et les mêmes comptes.

---

## 1. Le principe : le son commande l'image

Dans un podcast, **le meilleur indice du bon plan est le micro qui parle**. Studio part donc de l'audio, ensuite seulement de l'image.

```
 Micros ──► Analyse audio ─┐                                         ┌─► Programme (NDI · SRT · SDI · 2110)
 (1 par     niveau, voix,  │                                         │
 intervenant) micro dominant│    ┌───────────────┐   ┌──────────────┐ ├─► Enregistrement (PGM + ISO + pistes)
                            ├──► │  Réalisateur  │──►│  Mélangeur   │─┤
 Caméras ──► Analyse image ─┘    │  (décisions)  │   │ (exécution)  │ ├─► Tally, PTZ
 (fixes,    visages, présence,   └───────▲───────┘   └──────────────┘ │
  PTZ)      cadre                        │                            └─► Strata Graphics (qui parle → synthés)
                                 Opérateur : forcer, verrouiller, mode assisté
```

Les trois étages sont séparés :

1. **Perception** : des mesures continues sur chaque micro et chaque caméra.
2. **Décision** : le *Réalisateur*, qui transforme ces mesures en plans.
3. **Exécution** : le mélangeur interne, ou un mélangeur externe piloté (ATEM, vMix, OBS).

---

## 2. Perception

### 2.1 Audio (dès la première version)

Pour chaque micro, toutes les 10 ms :

| Mesure | Rôle |
| --- | --- |
| **Niveau** (RMS et crête, puis LUFS court terme) | vumètres et seuils |
| **Activité vocale (VAD)** | distinguer une voix d'un bruit (verre posé, rire bref, souffle). Modèle Silero VAD (ONNX, licence MIT), exécuté avec `tract` ou `ort`, déjà présents dans Strata |
| **Micro dominant** | qui parle *vraiment* : chaque micro capte aussi ses voisins (repisse). On compare les niveaux entre micros, avec un écart minimal (6 dB par exemple), une hystérésis et une matrice de repisse apprise pendant le réglage |
| **Chevauchement** | deux personnes ou plus parlent en même temps (débat, rire général) |

Sources audio : carte son (Dante Virtual Soundcard, interface USB), **AES67 / ST 2110-30** (Strata Graphics sait déjà en émettre), audio embarqué NDI ou SDI.

### 2.2 Image (dans un second temps)

- **Présence** : la personne est-elle dans son plan ? Le segmenteur de personnes de Strata Graphics (`people_net`) sait déjà le faire.
- **Visages et regard** : détection de visages, orientation de la tête. Cela confirme qui parle et propose des plans de réaction (quelqu'un qui écoute et réagit).
- **Qualité du plan** : un plan flou, vide ou dont la PTZ bouge n'est pas pris.

---

## 3. Le Réalisateur

C'est le cœur de Studio et ce qui le distinguera. Il doit couper **comme un humain**, pas comme un détecteur de voix.

### 3.1 Le plateau décrit

L'opérateur décrit son plateau une fois :

- les **intervenants** (nom, fonction, micro, place) ;
- les **plans** : chaque caméra (ou chaque preset de PTZ) a des plans typés, *serré* sur un intervenant, *deux-shot*, *large*, *ambiance* ou *détail* ;
- la **matrice** : quels plans montrent quel intervenant.

### 3.2 Les règles de base

| Règle | Exemple de réglage |
| --- | --- |
| Un intervenant parle seul → son plan serré | après 0,6 s de parole continue |
| Durée minimale d'un plan | 2,5 s (pas de « ping-pong ») |
| Durée maximale d'un plan | 12 s → plan de coupe : large, ou réaction d'un écoutant |
| Chevauchement → plan à deux ou large | si plus de 1 s |
| Silence → on garde le plan | puis le large après 4 s |
| Interjections courtes (« oui », « hum ») | ignorées sous 0,8 s |
| Variété | pondération aléatoire entre plans équivalents ; pas deux fois le même plan de coupe de suite |
| PTZ | jamais de mouvement sur une caméra à l'antenne (tally) |

Ces règles forment un **profil de réalisation**. Studio en livrerait plusieurs : *Podcast posé*, *Débat*, *Interview 1-1*, *Radio filmée* (plus large, plus lent). Chaque profil est réglable.

### 3.3 L'anticipation

Un réalisateur humain coupe souvent **avant** que la personne parle, parce qu'il voit qu'elle va parler. Un automate qui attend 0,6 s de voix coupe toujours en retard.

La solution : **retarder l'image et le son du programme** de quelques centaines de millisecondes (réglable, de 0 à 1 s). Le Réalisateur décide sur le direct et le mélangeur applique la décision sur le programme retardé. La coupe tombe alors au début de la phrase. Ce retard ne gêne pas un podcast ni même un direct sur le web. Strata Graphics fait déjà la même chose pour le suivi de caméra (`mixer_delay`).

### 3.4 Un moteur pur et rejouable

Le Réalisateur est une **fonction pure** :

```rust
/// Ce que Studio perçoit à un instant donné.
pub struct Perception {
    pub t: Instant,
    pub mics: Vec<MicState>,       // niveau, voix, dominance
    pub cams: Vec<CamState>,       // présence, visages, qualité, tally, PTZ en mouvement
}

/// Ce que l'opérateur impose.
pub enum Override { None, Hold, Force(ShotId), Pause, Assisted }

pub struct Director { /* profil, plateau, mémoire des derniers plans */ }

impl Director {
    /// Appelé à chaque image du programme.
    pub fn tick(&mut self, p: &Perception, o: &Override) -> Vec<Decision>;
}

pub enum Decision {
    Cut { shot: ShotId, reason: Reason },
    Mix { shot: ShotId, frames: u32, reason: Reason },
    Preset { camera: CamId, preset: u8 },   // préparer une PTZ hors antenne
    Speaker { who: Option<PersonId> },      // pour les synthés de Strata Graphics
}
```

Comme les widgets de Strata Graphics, le Réalisateur ne dépend ni de l'horloge ni du matériel. On peut donc :

- **enregistrer** les perceptions d'une vraie émission (un fichier JSON lines de quelques Mo par heure) ;
- **rejouer** cette émission avec un autre profil et comparer les montages ;
- **tester** les règles sans caméra (tests de non-régression sur des émissions de référence).

Chaque décision porte sa **raison** (« Alice parle depuis 0,8 s », « plan tenu 12 s, coupe sur le large »). L'interface l'affiche et le journal la garde.

---

## 4. Exécution

### 4.1 Mélangeur interne (recommandé pour commencer)

Studio décode ses entrées, compose le programme et l'envoie sur les sorties. Une grande partie existe déjà dans Strata Graphics :

| Besoin | Déjà dans Strata Graphics |
| --- | --- |
| Entrées NDI, SRT, RTMP, RTSP, ffmpeg, lissage, reconnexion | `cg-server/src/inputs.rs` |
| Sorties NDI, SRT, RTMP, HLS, SDI, ST 2110 | `cg-output` |
| Audio AES67 / ST 2110-30, mixage | `cg-output/src/audio.rs` |
| Retard d'image au mélangeur | `cg-server/src/people.rs` (`mixer_delay`) |
| Horloge, PTP, genlock | `cg-server/src/sync.rs`, `docs/SYNC.md` |
| Inférence ONNX GPU ou CPU | `cg-server/src/people_net.rs` |
| Comptes, droits, SSO, service, mises à jour, appli de la barre des menus | `auth.rs`, `sso.rs`, `service.rs`, `update.rs`, `cg-tray` |

Transitions : la **coupe**, puis le fondu court. Les habillages de Strata Graphics sont incrustés par Studio (fill + key reçus en NDI ou en ST 2110).

### 4.2 Mélangeurs externes (deuxième temps)

Beaucoup de studios ont déjà un mélangeur. Studio garde alors son Réalisateur et ne fait que piloter, derrière une interface commune `Switcher` :

- **Blackmagic ATEM** (protocole UDP) : le cas le plus fréquent en podcast ;
- **vMix** (API TCP/HTTP), **OBS** (obs-websocket) ;
- plus tard Ross, TriCaster ou d'autres.

### 4.3 Caméras PTZ et tally

- Presets par plan, appelés **hors antenne** et à l'avance (VISCA over IP, Panasonic AW, NDI PTZ).
- Tally rouge et vert vers les caméras et les voyants du plateau (HTTP, GPIO, TSL UMD).
- Plus tard : recadrage automatique doux avec la PTZ (suivi du visage), uniquement hors antenne.

---

## 5. Enregistrement : le livrable du podcast

Un podcast est souvent remonté. Studio enregistre donc plus que le programme :

- le **programme** (PGM) ;
- chaque caméra en **ISO** ;
- chaque micro sur sa **piste** (WAV multipiste) ;
- la **liste des coupes** du Réalisateur, à importer dans un logiciel de montage (FCPXML, XML Premiere, EDL, OpenTimelineIO). Le monteur reçoit un montage déjà fait, qu'il peut retoucher plan par plan.

Strata Graphics a déjà un panneau Premiere (`integrations/premiere`), qui pourrait importer ces montages.

Plus tard : transcription, chapitres et extraits verticaux 9:16 recadrés sur l'intervenant qui parle. Les formats multiples de Strata Graphics savent déjà produire du 9:16.

---

## 6. Lien avec Strata Graphics

| Studio → Graphics | Graphics → Studio |
| --- | --- |
| *Intervenant actif* poussé comme source de données (`/api/data/sources/{id}/value`) : synthé automatique au nom de celui qui prend la parole pour la première fois | fill + key incrustés par le mélangeur de Studio |
| Temps de parole par intervenant (widget barres, compteur) | déclencheurs (`trigger`) : jingle, générique de fin → plan large |
| Évènements de coupe (habillage qui suit le plan) | |

Les deux serveurs partagent les comptes, les rôles et la page *Système*.

---

## 7. Interface web

| Page | Contenu |
| --- | --- |
| **Plateau** | intervenants, micros, caméras, plans, matrice intervenant ↔ plan, calibrage de la repisse (« chacun parle 10 s ») |
| **Régie** | multiview avec tally, vumètres et voyant de parole par micro, plan suivant proposé, raison de la dernière coupe, frise des plans ; commandes **Auto / Assisté / Manuel**, *Forcer*, *Tenir*, *Pause* |
| **Réalisation** | profils et réglages (durées, seuils, anticipation, variété) ; **rejouer** une émission enregistrée avec un autre profil |
| **Enregistrements** | sessions, fichiers, export du montage |
| **Système** | identique à Strata Graphics : performances, journal, utilisateurs, API |

En mode **Assisté**, le Réalisateur propose et l'opérateur valide d'une touche ou d'un bouton de Stream Deck. Ce mode aide à gagner la confiance des équipes avant de passer en automatique.

Les surfaces de contrôle (Companion, Stream Deck, OSC) utilisent la même API que Strata Graphics : `/api/v1/{studio}/auto`, `/force/{plan}`, `/hold`…

---

## 8. Organisation du code

Proposition : **même dépôt, même workspace, binaire séparé** (`strata-studio`). Studio réutilise les briques de Graphics sans rien embarquer du moteur d'habillage.

```
crates/
  cg-core, cg-render, cg-output, cg-server, cg-tray   (Strata Graphics, inchangés)
  strata-common     extrait de cg-server : comptes, SSO, service, mises à jour, perf, journaux
  strata-io         extrait de cg-server : entrées vidéo (ffmpeg, NDI, DeckLink), entrées audio
  studio-core       Réalisateur : plateau, profils, règles, décisions (pur, sans I/O, testé par rejeu)
  studio-sense      perception : VAD, dominance, repisse ; plus tard visages
  studio-server     binaire strata-studio : axum, mélangeur, enregistrement, PTZ, tally, API
web/                l'interface partagée, avec une entrée « studio »
```

L'extraction de `strata-common` et de `strata-io` est le seul chantier qui touche Strata Graphics. Elle peut se faire progressivement, module par module, sans changer son comportement.

---

## 9. Étapes proposées

**Étape 0 : la preuve par le son (2 à 3 semaines)**
- `studio-core` et `studio-sense` seuls : VAD, micro dominant, règles de base.
- Entrée : des fichiers WAV multipistes d'une vraie émission. Sortie : une EDL.
- But : juger la qualité des coupes sur pièce, avant toute vidéo.

**Étape 1 : MVP en direct**
- 4 micros et 4 caméras (NDI ou SRT), audio par carte son ou AES67.
- Mélangeur interne en coupes seules, sortie NDI et SRT, enregistrement du programme et des coupes.
- Pages Plateau et Régie, modes Auto, Assisté et Manuel.

**Étape 2 : studio réel**
- Presets PTZ, tally, pilotage ATEM, vMix et OBS.
- Enregistrement ISO et multipiste, export FCPXML, XML Premiere et OTIO.
- Liens avec Strata Graphics (intervenant actif, incrustation).
- Analyse d'image : présence, visages, plans de réaction.

**Étape 3 : au-delà**
- Recadrage PTZ automatique, extraits 9:16, transcription et chapitres.
- SDI et ST 2110 en entrée et en sortie, plusieurs studios par serveur.

---

## 10. Risques identifiés

| Risque | Parade |
| --- | --- |
| Repisse entre micros : la mauvaise personne est détectée | calibrage au réglage, comparaison relative, VAD par micro, puis confirmation par l'image |
| Montage « robotique » | règles de durée, variété pondérée, anticipation, plans de réaction ; rejeu pour régler les profils |
| Décodage de N flux 1080p (NDI coûte cher) | décodage à la résolution utile pour l'analyse, mesures de capacité comme dans Graphics |
| Synchronisation image et son | un seul retard appliqué à tout le programme ; mesure du décalage par entrée |
| Confiance des équipes | mode Assisté, raisons affichées, reprise en main immédiate |

---

## 11. Questions ouvertes

1. **Mélangeur** : Studio compose-t-il l'image lui-même (proposé), ou pilote-t-il d'abord un ATEM existant ?
2. **Direct ou enregistré** : les émissions sont-elles diffusées en direct, ou seulement enregistrées puis publiées ? En enregistré, l'anticipation peut être bien plus longue, et le montage peut même être recalculé après coup.
3. **Plateau type** : combien d'intervenants et de caméras ? Caméras fixes ou PTZ ? Quels modèles ?
4. **Audio** : les micros arrivent-ils par une console (Dante, AES67, USB) ou directement ?
5. **Dépôt** : Studio dans ce dépôt (proposé), ou dans un dépôt à part qui dépend des crates partagées ?
