# Architecture

## Ce qu'on reprend de chaque produit

| | MXMZ | Singular.live | Flowics | **Pulse CG** |
| --- | --- | --- | --- | --- |
| Création | Timeline et keyframes façon AE, stop points | Composer web, animations par états | Templates paramétrables | Timeline et keyframes AE dans le navigateur, marqueurs pause et out |
| Rendu | Moteur natif, sortie SDI | Navigateur (HTML5) | Navigateur (HTML5) | **Un seul modèle de scène, deux moteurs** : Rust (baseband) et DOM (HTML5) |
| Sorties | SDI, NDI | Overlay URL | Overlay URL | HTML5, SDI (DeckLink), **ST 2110-20 fill + key** |
| Exploitation | Playlist | Control app | Data sources, automation | Rundown, couches de playout, API REST et WebSocket |

## Vue d'ensemble

```
             ┌──────────── Web app (React/TS) ─────────────┐
             │ Designer      Opérateur      /output (HTML5)│
             └──────┬──────────────┬───────────────▲───────┘
                REST│ (templates)  │WS (commandes) │WS (état 50 Hz)
             ┌──────▼──────────────▼───────────────┴───────┐
             │                 cg-server (axum)            │
             │  project store ─ ChannelState ─ horloge fps │
             └───────────────────────┬─────────────────────┘
                                     │ (Project, ChannelState) par frame
                             ┌───────▼────────┐
                             │   cg-render    │  tiny-skia, texte vectoriel
                             └───────┬────────┘
                                     │ Frame RGBA prémultipliée
                   ┌─────────────────┼──────────────────┐
             ┌─────▼─────┐   ┌───────▼───────┐   ┌──────▼──────┐
             │ ST 2110-20 │   │ ST 2110-20    │   │ DeckLink SDI│
             │   fill     │   │   key         │   │ fill + key  │
             └────────────┘   └───────────────┘   └─────────────┘
```

### `cg-core` : le contrat
- **Modèle** (`model.rs`) : `Project`, puis `Template`, puis `Layer` (group, rect, ellipse, text, image), avec ses `props` statiques, ses `tracks` de keyframes et ses `bindings` vers des champs de données. Le modèle est sérialisé en JSON camelCase ; il a un miroir TypeScript dans `web/src/engine/types.ts`.
- **Animation** (`anim.rs`, `easing.rs`) : chaque keyframe porte l'easing du segment qui en part (sémantique After Effects). Les fonctions d'easing sont implémentées à l'identique en Rust et en TypeScript (`web/src/engine/evaluate.ts`), y compris les bezier façon CSS.
- **Playout** (`playout.rs`) : logique MXMZ. *Take* joue jusqu'à la première pause, *Continue* jusqu'à la suivante (ou jusqu'au marqueur out), *Take out* saute au marqueur out puis joue jusqu'à la fin, après quoi le graphique est retiré. Les commandes s'appliquent par **couche de playout**, ce qui permet d'avoir plusieurs graphiques simultanément.

### Conventions de rendu (communes aux deux moteurs)
- `x` et `y` désignent le coin haut-gauche de la boîte dans le repère du parent ; les enfants d'un groupe sont relatifs au groupe.
- La rotation et l'échelle se font autour de l'ancre (`anchorX` et `anchorY` en fraction de la boîte, au centre par défaut).
- `crop*` est un masque de révélation (wipes) ; un groupe en `clip` découpe ses enfants.
- Texte : `font-size` en em, `line-height` à 1,2, `white-space: pre`.

Le test `cg-render::tests::renders_demo_lower_third` et les captures comparatives garantissent que le rendu Rust et le rendu HTML5 restent alignés.

### `cg-render`
Rasteriseur CPU (tiny-skia) : headless, déterministe, environ 1,5 ms par frame 1080p pour la démo. Le texte est converti en chemins vectoriels (ab_glyph vers tiny-skia) : il reste net sous n'importe quelle transformation. Les polices sont cherchées dans le système et dans `data/assets/fonts`.

### `cg-output`
- **ST 2110-20** : YCbCr 4:2:2 10 bits BT.709 (narrow range), RFC 4175 avec un segment de ligne par paquet de 1 200 octets, marker bit en fin de frame, horloge RTP à 90 kHz dérivée de l'heure système, SDP générés. Le fill et la key sont deux flux, chacun avec son thread et sa socket ; les paquets sont étalés sur la période trame (modèle d'émetteur proche de 2110-21 « wide »). Débit mesuré : 50 i/s en 1080p fill + key sur 4 vCPU.
- **SDI** : interface `DeckLinkOutput` (BGRA prémultiplié vers le keyer externe de la carte). Le pont FFI vers le SDK Blackmagic est à brancher derrière la feature `decklink`, car le SDK n'est pas redistribuable.
- **HTML5** : la page `/output` reçoit l'état du canal par WebSocket et rend avec le moteur DOM. Elle est transparente, s'adapte à la taille de la fenêtre (ou reste en 1:1 avec `?scale=1`) et convient aux browser sources.

### `cg-server`
axum et tokio. L'horloge de playout tourne à la cadence du projet ; l'état est diffusé à tous les clients WebSocket ; le rendu baseband se fait sur un thread dédié (une frame est abandonnée plutôt que d'accumuler de la latence). Le projet est persisté en JSON avec une écriture atomique.

## Feuille de route

**Moteur et sorties**
- [ ] Verrouillage PTP natif (lecture de la PHC de la carte réseau) et alignement des timestamps RTP sur l'epoch SMPTE 2059.
- [ ] Émission haute performance : `sendmmsg` / UDP GSO, puis DPDK ou NVIDIA Rivermax pour l'UHD et le 2110-21 « narrow ».
- [ ] ST 2110-40 (ANC), ST 2022-7 (redondance), enregistrement NMOS IS-04 / IS-05.
- [ ] Pont FFI DeckLink (C++), genlock sur la référence de la carte, NDI.
- [ ] Backend GPU (wgpu) derrière la même API `Renderer` : flous, ombres, dégradés, effets.
- [ ] Interlacé (1080i50/59.94) : rendu par trame.

**Designer**
- [ ] Éditeur de courbes de valeur et de vitesse (graph editor), poignées bezier dans la timeline.
- [ ] Ombres, dégradés, flou, modes de fusion, masques par calque (track matte).
- [ ] Animations de texte par caractère, texte auto-fit et ticker / crawl.
- [ ] Séquences d'images et vidéo (alpha), compositions imbriquées (pré-compositions).
- [ ] Import de fichiers Lottie / After Effects (bodymovin).

**Exploitation et données**
- [ ] Sources de données (Google Sheets, JSON/HTTP polling, CSV, webhooks) avec mapping vers les champs, comme dans Flowics.
- [ ] MOS (iNews, ENPS, Octopus), Companion / Stream Deck, raccourcis configurables.
- [ ] Multi-canaux, multi-utilisateurs, droits (designer / opérateur / lecture seule), journal de diffusion.
- [ ] Versionnage des templates, import et export de packages.
