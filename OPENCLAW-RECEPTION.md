# La messagerie OpenClaw dans FeedMe

Agents affiche une seule ligne par agent, avec son dernier message et le total de ses non-lus. Les différentes sessions techniques et les anciens échanges sont regroupés dans son historique. En fenêtre étroite, la flèche revient à la liste. En grande fenêtre, les deux restent visibles.

Le fil visible est regroupé par agent et par connexion. Ses anciens échanges sont conservés et triés dans le même historique. Leur provenance OpenClaw reste mémorisée en interne : le bouton Répondre sous un message permet de reprendre précisément son contexte d'origine, tandis qu'un message sans réponse ciblée utilise la conversation principale de l'agent. Aucune session distante n'est supprimée ou fusionnée sur le serveur.

Le bouton « ⋯ » en haut du fil, ou un clic droit sur l'agent dans la liste, ouvre sa fiche. Nom affiché, photo et couleur sont personnalisables uniquement dans FeedMe, avec possibilité de rétablir le profil d'origine. Les photos sélectionnées sont recadrées localement et réduites avant enregistrement. Ces préférences sont conservées dans agent-profiles.json dans le dossier de données de FeedMe, sans appel de modification à OpenClaw.

Les messages reçus pendant l'affichage d'un fil apparaissent dans ses bulles et sont marqués comme lus après leur affichage. Ceux des autres fils alimentent leurs compteurs de non-lus. Les outils, heartbeats et exécutions privées des crons ne sont pas présentés comme des conversations.

## News de 8h et autres messages programmés

Le résultat d'un cron doit être annoncé dans une conversation : il y apparaît alors comme un message normal, et la réponse reprend son contexte. Une exécution interne de cron n'est pas, à elle seule, un message adressé à l'utilisateur.

Les crons existants gardent leurs destinations. Si un cron annonce déjà son résultat dans une conversation Telegram conservée par OpenClaw, FeedMe retrouve cette même conversation et son résultat. Une future livraison uniquement dans FeedMe nécessite d'adapter la destination du job côté OpenClaw et ses éventuelles instructions d'envoi direct à Telegram.

Attention aux conversations ayant déjà une route Telegram mémorisée : retirer seulement les coordonnées explicites d'un job ne garantit pas une livraison uniquement dans FeedMe. Pour une destination FeedMe sans route externe, créer le job depuis une conversation dédiée sans route Telegram, puis vérifier sa livraison avant de désactiver l'ancien job. Ne pas définir `delivery.channel: "webchat"` : WebChat n'est pas un canal externe. Changer simplement le `sessionKey` d'un job ne déplace pas sa liaison immuable à la conversation créatrice.

Les réponses utilisateur passent par `chat.send` avec une clé d'idempotence et `deliver: false` : FeedMe n'active pas de renvoi automatique sur Telegram. La session distante et son historique restent néanmoins les mêmes lorsqu'on ouvre une conversation existante.

## Réception en arrière-plan

Fermer la fenêtre laisse FeedMe près de l'horloge Windows. Double-cliquer sur l'icône pour ouvrir les messages ; clic droit → Quitter FeedMe pour arrêter complètement l'app. Les notifications dépendent des réglages Windows et restent silencieuses si FeedMe est au premier plan. L'app ne démarre pas automatiquement avec Windows.

Après une coupure ou un arrêt complet, FeedMe relit l'historique conservé par OpenClaw. Les lectures sont bornées : découverte de 1 000 sessions, import initial des 100 dernières lignes par session, rattrapage de 1 000 lignes maximum par session et par lecture. Les historiques supprimés par le serveur ne peuvent plus être récupérés. Le trombone du champ de message (ou Ctrl+V, ou un glisser-déposer) joint jusqu'à 4 photos ou fichiers, 10 Mo chacun, envoyés via le champ `attachments` de `chat.send`. Les pièces jointes reçues depuis d'autres canaux et les envois externes sans transcription ne sont pas encore affichés.

Connexion exclusivement WebSocket avec l'appareil FeedMe approuvé et les droits operator.read/operator.write. Aucun endpoint /v1 n'est activé. Les secrets existants restent chiffrés par Windows. Aucun cron n'est modifié automatiquement.

Documentation : [clients Gateway](https://docs.openclaw.ai/gateway/clients), [livraison des crons](https://docs.openclaw.ai/automation/cron-jobs/delivery).
