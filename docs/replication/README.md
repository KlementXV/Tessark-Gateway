# Reprise de la réplication Harbor

La réplication du contenu est asynchrone. Une liaison `ACTIVE` signifie que sa configuration
et sa connectivité ont été vérifiées, pas que toutes les images sont déjà présentes chez le
pair. Le panneau du cluster affiche séparément les exécutions Harbor, le rattrapage suivi par
le Gateway et les erreurs de nettoyage.

## Fonctionnement

- Une opération `REPLICATION_SYNC` reste en file si la passe retourne une liaison en échec.
  Les tentatives automatiques respectent un délai de 30 secondes, doublé jusqu'à une heure.
  Les actions manuelles peuvent forcer une nouvelle vérification.
- Chaque nouvelle liaison demande un rattrapage complet. Cela couvre les deux directions
  lors de l'arrivée d'un membre, y compris ses images préexistantes, et l'activation de la
  réplication sur des registres déjà remplis.
- Une liaison réparée redemande un rattrapage. Une passe périodique de sécurité couvre aussi
  les interruptions de transfert qui n'ont laissé aucune opération administrative en file.
- L'identifiant d'exécution est persisté dès que Harbor accepte la demande. Le Gateway
  interroge cette exécution jusqu'à son résultat terminal. Une erreur de lecture conserve
  l'identifiant ; un résultat échoué programme une nouvelle tentative. Une exécution purgée
  chez Harbor est signalée comme inconnue et entraîne une nouvelle demande.
- Après un arrêt entre le POST Harbor et l'enregistrement en base, une exécution manuelle
  encore en cours est adoptée. Harbor ne fournit pas de clé d'idempotence pour ce POST : si
  elle s'est déjà terminée, une seconde passe peut avoir lieu. Ce n'est pas une garantie
  d'exécution exactement une fois.
- Les politiques supprimées sont recréées ; les endpoints et politiques adoptés après un
  conflit de nom sont mis à jour avant de déclarer la liaison active.
- Un retrait enregistre d'abord un nettoyage durable, puis enlève la liaison. Le nettoyage
  désactive la politique, la supprime, puis supprime l'endpoint. Il reste en file si une étape
  échoue, même après suppression du registre dans le Gateway. Les coordonnées de connexion
  sont chiffrées avec la clé existante et supprimées avec le travail terminé. Tant qu'un
  ancien nettoyage subsiste, la même direction ne peut pas être recréée.

Le scan de l'onglet Activité et `GET /api/registries/orphans` exposent aussi les nettoyages
restants, y compris ceux dont les registres ont quitté le Gateway. Une source inaccessible
peut conserver sa politique active jusqu'à ce que la désactivation soit possible.

## Traitement périodique et configuration

Le serveur Node démarre le worker via l'instrumentation Next.js. Il ne dépend ni d'une page
ouverte, ni d'un CronJob Kubernetes. Chaque processus évite les ticks superposés ; les
mutations du maillage, les reprises, les changements d'appartenance et le nettoyage utilisent
un verrou transactionnel PostgreSQL commun. Un autre pod diffère son travail si le verrou
est occupé. Les actions administratives peuvent alors demander une nouvelle tentative.

Le worker traite les clusters successivement. La configuration du maillage est limitée à
trois sources simultanées ; le suivi traite au maximum 20 liaisons et le nettoyage 50 lignes
par passe. Les transferts de blobs restent exécutés par Harbor, en dehors des transactions
Gateway. Une opération Gateway conserve au maximum 30 minutes son contexte transactionnel ;
ce mécanisme suppose des opérations administratives finies et une base disponible. Il ne
constitue pas un protocole de consensus ou de fencing distribué en cas de partition PostgreSQL.
Le pool PostgreSQL doit permettre au moins deux connexions par processus (le chart en prévoit
cinq) : une pour le verrou et une pour les écritures métier.

| Variable | Défaut | Champ Helm sous `config` |
| --- | --- | --- |
| `REPLICATION_WORKER_ENABLED` | `true` | `replicationWorkerEnabled` |
| `REPLICATION_POLL_SECONDS` | `60` | `replicationPollSeconds` |
| `REPLICATION_VERIFY_SECONDS` | `300` | `replicationVerifySeconds` |
| `REPLICATION_CATCHUP_SECONDS` | `3600` | `replicationCatchupSeconds` |

`REPLICATION_CATCHUP_SECONDS=0` désactive seulement le rattrapage périodique de sécurité.
Les rattrapages initiaux et demandés après réparation restent actifs. Si le worker est
désactivé, les demandes de copie restent enregistrées mais ne sont plus avancées automatiquement.

## Limites de cohérence

Harbor ne réplique les suppressions que par événement. Les exécutions manuelles et planifiées
ne rejouent pas les suppressions manquées : un artefact resté sur un pair peut donc être
réintroduit lors d'un rattrapage. La rétention locale et la suppression propagée ne constituent
pas une sauvegarde. Voir la [documentation Harbor](https://goharbor.io/docs/edge/administration/configuring-replication/create-replication-rules/).

Le maillage conserve `override: true`. Deux écritures concurrentes sur le même tag n'ont pas
d'ordre global ni de résolution de conflit. Pour un contenu déterministe, utiliser des tags
immuables ou un seul écrivain par tag et consommer les images par digest. Le rattrapage ne
compare pas exhaustivement les inventaires de tous les pairs : une exécution réussie est une
confirmation Harbor de cette passe, pas une preuve que tous les registres sont identiques.

## Installation et validation

Appliquer `20260906160000_replication_recovery` avec `prisma migrate deploy` avant de lancer
la nouvelle version. Le chart possède déjà un Job de migration. La migration est additive ;
elle marque les liaisons existantes pour un premier rattrapage au démarrage du worker.

Vérifications automatisées :

- `npm test` : échec partiel conservé en file, rattrapage initial et périodique, résultat
  terminal, coupure pendant le suivi, exécution purgée, adoption après arrêt, réparation 404,
  rotation d'un endpoint adopté, nettoyage différé et verrou réentrant.
- `node scripts/test-replication-postgres.mjs` : toutes les migrations dans un schéma
  temporaire, exclusion entre deux connexions réelles, libération après erreur et persistance
  d'un nettoyage sans registres parents. Le schéma est supprimé à la fin.

La recette destructive doit se faire sur des Harbor dédiés et vides : installer deux ou trois
membres, pousser une image par digest, interrompre un membre, pousser une seconde image,
redémarrer le Gateway puis le membre et attendre la copie sans ouvrir le dashboard. Vérifier
ensuite une suppression de politique, une rotation d'identifiants et un retrait pendant une
copie. Tester séparément une suppression pendant panne et deux écritures sur le même tag pour
observer les limites ci-dessus. Ne pas utiliser le maillage `**` de cette recette sur des
Harbor partagés contenant des projets existants.
