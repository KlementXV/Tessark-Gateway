# Harbor replication and recovery · Réplication et reprise Harbor

**[English](#english) · [Français](#français)** · [Tessark Gateway](../../README.md)

## English

### What an active link means

Content replication is asynchronous. An `ACTIVE` link means its configuration and connectivity have been verified, not that every image is already present on its peer. The cluster panel separately reports Harbor executions, Gateway-managed catch-up and cleanup errors.

This guide concerns the Harbor replication mesh. Destination `skopeo` transfer Jobs have a separate lifecycle, described in the [Helm runbook](../../deploy/helm/tessark-gateway/README.md#english).

### Recovery behavior

- `REPLICATION_SYNC` stays queued if a reconciliation pass reports a failed link. Automatic retries start at 30 seconds and double up to one hour. Manual actions can request an earlier check.
- Every new link requests a full catch-up, including both directions when adding a member with existing images or enabling replication on populated registries.
- Repaired links request another catch-up. Periodic safety passes also cover content interruptions that left no queued administrative operation.
- Harbor execution IDs are persisted once accepted and polled to a terminal result. Read errors preserve the ID; failed results schedule a retry. An execution purged by Harbor becomes unknown and triggers a new request.
- After a crash between Harbor’s POST and the database write, a still-running manual execution is adopted. Harbor supplies no idempotency key for that POST; if the execution already finished, a second pass can occur. Exactly-once execution is not guaranteed.
- Deleted policies are recreated. Endpoints and policies adopted after a naming conflict are updated before a link is declared active.
- Removal records durable cleanup before removing the link. Cleanup disables and deletes the policy, then deletes the endpoint. Failed steps remain queued even after a registry has been removed from Gateway. Connection details are encrypted and deleted when cleanup finishes. An outstanding cleanup blocks recreation of the same direction.

The Activity scan and `GET /api/registries/orphans` expose pending cleanup, including registries that have left Gateway. An unreachable source may retain an active policy until it can be disabled.

### Worker and configuration

Next.js instrumentation starts the worker in each Node server. It needs neither an open browser tab nor a Kubernetes CronJob. Ticks do not overlap within a process. Mesh mutations, recovery, membership changes and cleanup share a PostgreSQL transactional lock; another pod defers work while the lock is held. Administrative actions may need to be retried.

Clusters are processed sequentially. Mesh configuration handles at most three concurrent sources, execution tracking at most 20 links, and cleanup at most 50 rows per pass. Harbor transfers blobs outside Gateway transactions. A Gateway operation retains its transactional context for at most 30 minutes. This assumes finite administrative operations and an available database; it is not distributed consensus or fencing during a PostgreSQL network partition.

Allow **at least two PostgreSQL connections per process**: one for the lock and one for business writes. The chart defaults to five.

| Variable | Default | Helm field under `config` |
| --- | --- | --- |
| `REPLICATION_WORKER_ENABLED` | `true` | `replicationWorkerEnabled` |
| `REPLICATION_POLL_SECONDS` | `60` | `replicationPollSeconds` |
| `REPLICATION_VERIFY_SECONDS` | `300` | `replicationVerifySeconds` |
| `REPLICATION_CATCHUP_SECONDS` | `3600` | `replicationCatchupSeconds` |

`REPLICATION_CATCHUP_SECONDS=0` disables only periodic safety catch-up. Initial and post-repair catch-up remain active. Disabling the worker preserves queued copy requests but stops their automatic advancement.

### Consistency limits

Harbor deletion propagation is event-based. Manual and scheduled execution does not replay missed deletions; an artifact remaining on a peer may be reintroduced during catch-up. Local retention and propagated deletion are not a backup.

The mesh uses `override: true`. Concurrent writes to the same tag have no global ordering or conflict resolution. For deterministic content, use immutable tags or one writer per tag, and consume images by digest. Catch-up does not exhaustively compare peer inventories. A successful execution confirms that Harbor completed that pass; it does not prove all registries are identical.

### Troubleshooting

1. Check the cluster panel for the affected direction, execution ID and cleanup error.
2. Verify source/destination reachability, credentials and Harbor policy state.
3. Confirm the worker is enabled and PostgreSQL has available connections. Check Gateway logs for retries or lock contention.
4. After restoring connectivity, request a recheck or let the worker retry. Follow the recorded execution to completion rather than relying only on `ACTIVE`.
5. For removal, verify durable cleanup has finished before recreating the same direction. Check for policies still active on previously unreachable sources.

### Installation and validation

Apply migration `20260906160000_replication_recovery` before running a version that needs it, using `npx prisma migrate deploy`. The Helm chart already runs a migration Job. This additive migration marks existing links for initial catch-up when the worker starts.

From the repository root:

```bash
npm test
node --env-file=.env.local scripts/test-replication-postgres.mjs
```

Unit tests cover partial failure, initial/periodic catch-up, terminal results, tracking interruption, purged executions, crash adoption, 404 repair, adopted endpoint rotation, deferred cleanup and reentrant locking. The PostgreSQL integration script uses the connection in `.env.local`, applies all migrations to a temporary schema, checks mutual exclusion between real connections and cleanup persistence, and drops that schema afterward. Use a development database with schema-creation permissions.

For destructive end-to-end validation, use dedicated empty Harbor instances: add two or three members, push an image by digest, interrupt one member, push another image, restart Gateway and the member, and verify catch-up without opening the dashboard. Then test policy deletion, credential rotation and removal during a copy. Test deletion during an outage and concurrent writes to one tag separately to observe the limits above. Do not use the broad `**` mesh for this scenario on shared Harbor instances with existing projects.

## Français

### Sens d’une liaison active

La réplication du contenu est asynchrone. Une liaison `ACTIVE` signifie que sa configuration
et sa connectivité ont été vérifiées, pas que toutes les images sont déjà présentes chez le
pair. Le panneau du cluster affiche séparément les exécutions Harbor, le rattrapage suivi par
le Gateway et les erreurs de nettoyage.

Ce guide concerne le maillage de réplication Harbor. Les Jobs de transfert `skopeo` suivent un cycle de vie distinct, décrit dans le [guide Helm](../../deploy/helm/tessark-gateway/README.md#français).

### Fonctionnement

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

### Traitement périodique et configuration

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

### Limites de cohérence

Harbor ne réplique les suppressions que par événement. Les exécutions manuelles et planifiées
ne rejouent pas les suppressions manquées : un artefact resté sur un pair peut donc être
réintroduit lors d'un rattrapage. La rétention locale et la suppression propagée ne constituent
pas une sauvegarde.

Le maillage conserve `override: true`. Deux écritures concurrentes sur le même tag n'ont pas
d'ordre global ni de résolution de conflit. Pour un contenu déterministe, utiliser des tags
immuables ou un seul écrivain par tag et consommer les images par digest. Le rattrapage ne
compare pas exhaustivement les inventaires de tous les pairs : une exécution réussie est une
confirmation Harbor de cette passe, pas une preuve que tous les registres sont identiques.

### Diagnostic

1. Consulter le panneau du cluster pour identifier la direction, l’exécution et l’erreur de nettoyage concernées.
2. Vérifier l’accès source/destination, les identifiants et l’état des politiques Harbor.
3. Confirmer l’activation du worker et la disponibilité des connexions PostgreSQL. Examiner les logs Gateway pour les tentatives et conflits de verrou.
4. Après rétablissement, demander une vérification ou laisser le worker réessayer. Suivre l’exécution jusqu’à son terme plutôt que se fier uniquement à `ACTIVE`.
5. Pour un retrait, attendre la fin du nettoyage durable avant de recréer la direction. Vérifier les politiques restées actives sur les sources précédemment inaccessibles.

### Installation et validation

Appliquer `20260906160000_replication_recovery` avec `npx prisma migrate deploy` avant de lancer
la nouvelle version. Le chart possède déjà un Job de migration. La migration est additive ;
elle marque les liaisons existantes pour un premier rattrapage au démarrage du worker.

Depuis la racine du dépôt :

```bash
npm test
node --env-file=.env.local scripts/test-replication-postgres.mjs
```

Le test PostgreSQL lit la connexion dans `.env.local`. Utiliser une base de développement avec le droit de créer des schémas.

Vérifications automatisées :

- `npm test` : échec partiel conservé en file, rattrapage initial et périodique, résultat
  terminal, coupure pendant le suivi, exécution purgée, adoption après arrêt, réparation 404,
  rotation d'un endpoint adopté, nettoyage différé et verrou réentrant.
- `node --env-file=.env.local scripts/test-replication-postgres.mjs` : toutes les migrations dans un schéma
  temporaire, exclusion entre deux connexions réelles, libération après erreur et persistance
  d'un nettoyage sans registres parents. Le schéma est supprimé à la fin.

La recette destructive doit se faire sur des Harbor dédiés et vides : installer deux ou trois
membres, pousser une image par digest, interrompre un membre, pousser une seconde image,
redémarrer le Gateway puis le membre et attendre la copie sans ouvrir le dashboard. Vérifier
ensuite une suppression de politique, une rotation d'identifiants et un retrait pendant une
copie. Tester séparément une suppression pendant panne et deux écritures sur le même tag pour
observer les limites ci-dessus. Ne pas utiliser le maillage `**` de cette recette sur des
Harbor partagés contenant des projets existants.
