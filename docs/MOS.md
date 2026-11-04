# Connecter un système de rédaction (MOS)

Strata est un **MOS device** (MOS 2.8.5). Il fonctionne avec Saga (Fonn Group), iNews, ENPS, Octopus, Dina, etc.

- Les journalistes placent les habillages dans leurs sujets avec le **plugin HTML5** de Strata.
- Le système de rédaction envoie les **conducteurs** (running orders) à Strata.
- Chaque conducteur devient une **playlist** du projet, avec un élément par habillage, dans l'ordre des sujets. L'opérateur les joue depuis la page Opérateur, avec les boutons Take / Out des lignes ou par l'automation.

## 1. Côté Strata

1. **Onglet MOS** de l'accueil (admins) :
   - cocher *Accept newsroom connections* ;
   - **MOS ID** : `strata.mos` par défaut, c'est l'identifiant à déclarer dans la rédaction ;
   - **Ports** : 10540 (bas : objets, profils 0-1) et 10541 (haut : conducteurs, profil 2) ;
   - **Projet** : celui qui reçoit les conducteurs. En mode *Automatique*, c'est le projet des habillages.
   - **État renvoyé à la rédaction** : adresse du système de rédaction et son port haut (10541 par défaut). Strata y envoie l'état de chaque habillage (voir plus bas). Vide : rien n'est envoyé.

   Enregistrer : le moteur redémarre et les ports s'ouvrent. L'état (*Listening* ou *Connected*) et le nombre de connexions s'affichent en haut de la page ; *Running orders* liste les conducteurs reçus.
2. **Utilisateurs** : créer un compte `saga-plugin` de rôle **Operator**, limité aux projets des émissions concernées, puis une **clé d'API** pour ce compte (onglet **API** → *API keys*, en la faisant agir en tant que ce compte).
3. Le pare-feu du serveur doit autoriser les ports 10540-10541 et 8080 depuis le réseau de la rédaction.

## 2. Côté Saga (Fonn Group)

À faire par l'administrateur Saga (les intitulés varient selon la version) :

1. **Déclarer le MOS device** :
   - MOS ID `strata.mos` ;
   - adresse IP du serveur Strata ;
   - ports bas / haut 10540 / 10541 ;
   - profils 0, 1 et 2 ;
   - encodage UCS-2 (UTF-16), standard MOS. Strata accepte aussi l'UTF-8.
2. **Déclarer le plugin HTML5** de ce MOS device :
   ```
   http://<serveur-strata>:8080/mos/plugin?key=pcg_…
   ```
   La clé est celle du compte `saga-plugin`. Le plugin communique avec Saga par `postMessage` (`<ncsItem>`, MOS 2.8.5) et accepte aussi le **glisser-déposer** de l'élément dans le texte du sujet.
3. Activer l'envoi des conducteurs (MOS « running order ») vers ce device pour les émissions concernées.

## 3. Utilisation

**Journaliste**, dans le sujet, ouvre le plugin Strata :
- choisit le template et remplit les champs ; l'aperçu se met à jour en direct ;
- clique sur **Add to the story**, ou glisse l'élément dans le texte.

Rouvrir un élément existant recharge ses valeurs, et le bouton devient **Update the item**.

**Opérateur** :
- la playlist du conducteur apparaît dans la page Opérateur (onglet au nom du conducteur), et se met à jour à chaque modification dans Saga ;
- les éléments suivent l'ordre des sujets ;
- les autres éléments MOS (vidéo, prompteur…) sont ignorés.

## Messages pris en charge

| Port | Messages |
| --- | --- |
| bas (10540) | `heartbeat`, `reqMachInfo` → `listMachInfo`, `mosReqAll` / `mosReqObj` → `mosListAll` (les templates comme objets MOS) |
| haut (10541) | `roCreate`, `roReplace`, `roDelete`, `roMetadataReplace`, `roElementAction` (INSERT / REPLACE / MOVE / DELETE / SWAP de sujets et d'éléments), `roReadyToAir`, `roReq`, `roItemCue`, `roCtrl` (accusés) |

Chaque message reçoit sa réponse sur la même connexion (`roAck` / `mosAck`). Les conducteurs sont conservés dans `<données>/mos/` et survivent aux redémarrages.

### État renvoyé à la rédaction

Quand l'adresse du système de rédaction est renseignée, Strata ouvre une connexion vers son port haut et y envoie `roElementStat` (`element="ITEM"`, avec `roID`, `storyID`, `itemID`, `objID` et `itemChannel` de l'élément) :

| État | Quand |
| --- | --- |
| `READY` | Le conducteur est reçu et le template de l'habillage existe dans le projet. |
| `NOT READY` | Le template de l'habillage n'existe pas dans le projet. |
| `PLAY` | L'habillage passe à l'antenne (sur n'importe quel canal). |
| `STOP` | Il sort de l'antenne. |

Chaque message attend son `roAck` ; une connexion perdue est rouverte au message suivant. L'état de la liaison (connecté, erreur, dernier état envoyé) s'affiche dans l'onglet MOS. Le `ncsID` est celui des réglages, sinon celui que la rédaction utilise ; l'encodage est celui de la rédaction (UTF-16 par défaut).

Format des éléments créés par le plugin (`mosExternalMetadata`, schéma `https://stratagraphics.io/mos/v1`) :

```xml
<mosPayload>
  <strata project="demo" template="lower-third" zone="lower-third">
    <field key="name">Ada Lovelace</field>
    <field key="title">Mathématicienne</field>
  </strata>
</mosPayload>
```

## Limites actuelles

- **Profils 3 à 7 non pris en charge.** Il n'y a pas d'objets créés côté device ni de contrôle de playout par la rédaction (`roCtrl` est seulement accusé). Le Take reste chez l'opérateur, ou passe par l'API (`POST /api/channels/{id}/items/{item}/take`).
- **Système de rédaction en cloud.** MOS est du TCP non chiffré, ouvert par la rédaction vers Strata : un système en cloud doit passer par un VPN ou par sa passerelle MOS installée sur site.
- **Validation sur une vraie Saga à faire.** L'intégration a été testée avec un simulateur MOS, pas avec Saga elle-même : la première mise en service doit être faite avec l'administrateur Saga.
