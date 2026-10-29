# FeedMe

Un bureau Windows avec vos widgets et un espace de conversation pour vos agents
OpenClaw via le protocole WebSocket avec approbation d’appareil, et Hermes ou
les autres passerelles via leur API compatible Chat Completions.

## Utilisation

Ouvrir `dist/FeedMe.exe`, puis l’onglet **Agents**. Ajouter une connexion avec son
nom, son adresse et son agent / modèle. Pour OpenClaw, saisir le mot de passe
de la passerelle puis utiliser **Connecter / vérifier**. Pour Hermes ou une API
compatible, renseigner le jeton puis **Tester**. Ces boutons n’envoient aucune
tâche à l’agent.

Une connexion peut avoir plusieurs conversations. Le bouton **+** de la barre
des conversations démarre un fil indépendant. Les messages et réponses sont
conservés localement, y compris les réponses partielles en cas d’erreur réseau.
Les réponses sont affichées en texte brut, sans exécuter du HTML distant.

Dans un chat OpenClaw, le sélecteur **Modèle** au-dessus du message affiche les
modèles de la passerelle. Choisir un modèle puis **Changer** envoie la commande
native `/model fournisseur/modèle` dans le même fil, avec la confirmation
d’OpenClaw dans le chat. Cela permet de basculer lorsqu’un modèle atteint sa
limite, sans perdre l’historique ni le brouillon. **Par défaut de l’agent**
rétablit sa sélection par défaut ; le bouton **↻** relit la liste.

Pour OpenClaw, le menu **Parler à** liste les agents réellement accessibles
sur la passerelle via `agents.list` : leurs noms et identifiants ne sont pas
à saisir manuellement. Changer d’agent ouvre un nouveau fil avec cet agent.
Le menu des conversations affiche les fils du destinataire sélectionné ;
chaque fil conserve son agent d’origine. Le bouton à côté du sélecteur permet
de relire le catalogue. Les appels d’outils, résultats d’outils et blocs de
raisonnement sans texte visible ne créent pas de bulles vides.

## Connecter OpenClaw

Renseigner votre passerelle, par exemple `wss://openclaw.example.com` (port 443).
FeedMe se connecte à la passerelle WebSocket ; il n’utilise jamais `/v1` pour
OpenClaw. L’API HTTP Chat Completions doit rester désactivée sur une passerelle
exposée publiquement via Tailscale Funnel.

1. Ouvrir **Agents → Configurer cet agent**, saisir le mot de passe de la
   passerelle et enregistrer. Agent : `default` ou un identifiant d’agent.
2. Cliquer sur **Connecter / vérifier**. FeedMe crée et conserve une paire de
   clés Ed25519 propre à cette installation. Il signe le nonce et l’horodatage
   du défi `connect.challenge`, puis envoie `connect` avec le mot de passe,
   l’identité signée, le rôle `operator` et seulement les scopes
   `operator.read` et `operator.write`.
3. À la première connexion, FeedMe affiche **Approbation requise** avec son
   identifiant d’appareil et, lorsqu’il est fourni, l’identifiant de demande.
   Côté OpenClaw, vérifier l’appareil nommé **FeedMe** et approuver sa demande.
   La CLI permet aussi de consulter `openclaw devices list`, puis
   `openclaw devices approve <requestId>`. FeedMe n’approuve pas lui-même
   l’appareil et ne demande aucun droit d’administration ou d’appairage.
4. Cliquer de nouveau sur **Connecter / vérifier**. Après l’approbation, le
   jeton d’appareil est chiffré et mémorisé avec ses droits. Les reconnexions
   utilisent cette identité et ce jeton, sans repasser le mot de passe.

Enregistrer un nouveau mot de passe remet la connexion en mode bootstrap
avec la même identité ; cela ne change aucun réglage ou droit côté serveur.

La discussion utilise `chat.history`, `chat.send` avec une clé d’idempotence
persistée avant chaque envoi, et `chat.message.get` pour récupérer le dernier
message complet lorsque la méthode est disponible. Les événements `chat`
arrivent sur la même connexion. Les remplacements de texte, réponses finales,
erreurs, coupures et écarts de séquence sont traités explicitement.
Chaque fil conserve sa clé de session et le `sessionId` retourné par OpenClaw.
L’actualisation lit l’historique distant ; elle ne renvoie jamais une tâche.

La connexion implémente les enveloppes communes aux protocoles 3 et 4,
les signatures d’appareil v3 et les événements texte cumulatifs ou incrémentaux.
Les demandes d’approbation sont revérifiées sur action de l’utilisateur.

Références officielles : [handshake](https://docs.openclaw.ai/gateway/protocol/handshake),
[authentification](https://docs.openclaw.ai/gateway/protocol/auth),
[transport](https://docs.openclaw.ai/gateway/protocol/transport),
[WebChat](https://docs.openclaw.ai/web/webchat),
[schémas](https://github.com/openclaw/openclaw/tree/main/packages/gateway-protocol/src/schema).

## Connecter Hermes

Sur le serveur, dans `~/.hermes/.env`, activer l’API avec un jeton personnel :

```dotenv
API_SERVER_ENABLED=true
API_SERVER_KEY=<votre-jeton>
```

Démarrer ou redémarrer `hermes gateway`. L’API écoute habituellement sur
`127.0.0.1:8642`. L’API est distincte du serveur de l’interface `hermes serve`.
Dans FeedMe, choisir **Hermes**, renseigner l’adresse et le jeton,
puis `hermes-agent` comme modèle (ou le nom annoncé par votre profil).
Les adresses avec préfixe de profil sont acceptées :
`https://agents.exemple.fr/p/travail/v1`.

FeedMe fournit un identifiant de session par conversation, une clé de mémoire
par connexion et un identifiant par envoi. L’historique textuel complet est aussi
transmis pour les versions compatibles qui ne prennent pas ces en-têtes en charge.

[Documentation officielle Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)

## Accès à un VPS

OpenClaw utilise une adresse WSS dont le proxy accepte les connexions WebSocket,
comme Tailscale Funnel. Hermes utilise HTTPS avec les réponses SSE, de préférence
sur un accès privé. Un tunnel SSH local est également possible :

```sh
ssh -N -L 18789:127.0.0.1:18789 utilisateur@serveur
```

Dans FeedMe, adresse `ws://127.0.0.1:18789` pour OpenClaw. Pour Hermes, remplacer les deux
ports par `8642` et utiliser `http://127.0.0.1:8642`. Les adresses WS/HTTP distantes sont refusées pour éviter de
transmettre le jeton sans chiffrement. Aucun réglage du VPS n’est modifié
automatiquement par FeedMe.

## Stockage et limites

La version bureau chiffre mots de passe, clés privées et jetons avec le stockage
sécurisé Windows. Les secrets ne sont jamais retournés à l’interface, stockés dans
le navigateur ni journalisés. L’identité Ed25519 et les jetons d’appareil résident
chiffrés dans `openclaw-device.json`. Les mots de passe et jetons des connexions
sont chiffrés dans `agents-store.json`. Ces fichiers ne sont pas inclus dans l’exécutable.
En mode Node seul, OpenClaw requiert la version bureau pour le stockage sécurisé ;
les nouveaux jetons Hermes restent en mémoire jusqu’à l’arrêt du serveur.
L’historique local reste lisible dans `agents-store.json` du dossier de données
FeedMe. En version portable compilée, ce dossier est sous les données utilisateur
Electron ; en développement, il est dans le projet.

**Arrêter** interrompt la réception ; cela ne garantit pas
l’arrêt des outils déjà lancés sur le VPS. FeedMe ne renvoie jamais une tâche
automatiquement après une coupure. Supprimer un fil ou une connexion supprime
ses données dans FeedMe ; les sessions du serveur restent sur le serveur.
Cette version crée ses propres sessions API et n’importe pas les anciennes
conversations Telegram, CLI ou des interfaces natives des agents.

## Développement

Les sources sont fournies sans données personnelles, jetons, caches ni exécutables.
Les données JSON locales sont créées au premier usage et ignorées par Git.
Pour Spotify, copier `spotify-app.example.json` vers `spotify-app.json` et renseigner
votre identifiant client public, ou définir `SPOTIFY_CLIENT_ID`.

Node 22 ou ultérieur. Dépendances existantes :

```sh
npm ci
npm run widget
npm test
npm run build
```

`npm start` lance l’interface dans un serveur local sur le port 3777 (ou le suivant
disponible). `PORT` et `FEEDME_DATA_DIR` permettent d’isoler une session de test.
Le serveur est lié uniquement à `127.0.0.1`.

Le module `agents.js` gère stockage, connexions et flux. `openclaw.js` possède
le coffre d’identité, les signatures et le client WebSocket natif de Node.
Electron fournit le chiffrement Windows. L’interface est dans `public/agents.js` et `public/agents.css`.
La navigation conserve les widgets et suspend leurs sondages réguliers quand
l’espace Agents est visible. Aucun nouveau framework ou SDK n’est ajouté.

Les tests utilisent des passerelles simulées : routage, historique, jetons,
contrôle d’origine, décodage SSE, signatures Ed25519, attente d’approbation,
persistance chiffrée, reprises de session et absence de renvoi automatique.
La connexion à vos vrais serveurs nécessite leurs identifiants et, pour
OpenClaw, l’approbation de l’appareil côté passerelle.

## Organisation du dossier

- `electron.js`, `preload.js`, `appbar.js`, `winmetrics.js` : l’application bureau.
- `server.js` et ses modules (`agents.js`, `openclaw.js`, `agent-*.js`, `ai*.js`, `direct-usage.js`) : le serveur local.
- `public/` : l’interface (widgets dans `public/widgets/`).
- `tests/` : `npm test`.
- `build/icon.ico` : l’icône de l’exe.
- Fichiers `*.json` à la racine (`feeds.json`, `boards.json`, `spotify.json`, `agents-store.json`…) :
  données de la version de développement (`npm start`). L’exe range les siennes dans
  `%APPDATA%\feedme\FeedMe-data`. `spotify.json` contient un jeton personnel : ne pas partager ce dossier tel quel.
- `dist/FeedMe.exe` : l’app à lancer, produite par `npm run build`. `dist/win-unpacked`
  est l’étape intermédiaire du build, recréée à chaque fois. Fermer FeedMe avant de
  relancer un build, sinon il attend que l’exe soit libéré.
