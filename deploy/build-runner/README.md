# Build runner · Runner de builds

**[English](#english) · [Français](#français)** · [Tessark Gateway](../../README.md)

## English

### Purpose and prerequisites

This image runs the optional **Scheduled builds · Beta** feature. It builds an image using Buildah and publishes it to the configured project registry. It is separate from the Gateway application image.

To build/publish the runner, use Buildah with access to the pinned upstream image and package repositories, plus push credentials for your runner registry. To execute builds, use Kubernetes with a node pool that supports the profile below, a project-scoped Harbor robot and a verified HTTPS destination. See [Helm activation](../helm/tessark-gateway/README.md#english) for Gateway settings and RBAC.

### Build and publish

Run from the repository root, replacing the example repository:

```bash
buildah bud -t registry.example.com/team/tessark-build-runner:beta deploy/build-runner
buildah push --digestfile=/tmp/tessark-runner.digest \
  registry.example.com/team/tessark-build-runner:beta
cat /tmp/tessark-runner.digest
```

Set `BUILDS_RUNNER_IMAGE` or Helm `builds.runnerImage` to `registry.example.com/team/tessark-build-runner@sha256:YOUR_DIGEST`, using the published 64-character digest. A tag alone is rejected when enabling the feature. Also enable `BUILDS_BETA_ENABLED` and `K8S_ENABLED` (Helm `builds.enabled` and `config.k8sEnabled`).

The [Dockerfile](Dockerfile) pins the upstream Buildah image by digest and installs Python/Git when building the runner image. Individual Dockerfiles executed by the runner may still download their own dependencies and base images.

### Inputs and scheduling

Administrators configure builds in **Registries → Builds · Beta**:

- Inline Dockerfile: uses an empty build context.
- Public HTTPS Git repository: select a ref and relative context/Dockerfile paths.
- Optional build arguments: configuration values, not a channel for secrets.
- Optional five-field UTC cron: pause prevents future scheduled runs while manual runs remain available.

Private Git authentication is not provided by this flow. The destination must have a project robot; builds never fall back to the system robot. Credentials and custom CA are captured in an immutable revision Secret. Reapply a build after rotating its credentials; existing Jobs retain their original revision.

### Kubernetes execution profile

| Property | Profile |
| --- | --- |
| Build container | UID 1000, fsGroup 1000 |
| Storage / isolation | VFS storage driver, chroot isolation |
| AppArmor / seccomp | Unconfined for the build container |
| Privileges | No privileged mode, SYS_ADMIN, Docker socket or host mount |
| Claim init container | UID 0, all capabilities dropped, RuntimeDefault seccomp |
| API token | Projected only into the claim init container |
| Claim permissions | Lease `create/get`, no Secret reads |

The recorded validation environment was k3s v1.36.4, Ubuntu 22.04 and kernel 5.15. This profile is not admitted by a Pod Security `restricted` namespace. Use a dedicated build namespace/node pool for administrator-approved Dockerfiles; it is not an isolation boundary for arbitrary untrusted code.

Per-build CPU, memory, ephemeral storage and deadline limits are configured under `builds.*`. With optional network policies, allow DNS, the Kubernetes API for claims, the target registry and the Git/package/base-image sources required by approved Dockerfiles. The main build container receives project push credentials but no ServiceAccount token.

### Claims and lifecycle

A Kubernetes Lease represents a build claim. It has **no expiry** and its holder is a pod UID. The Gateway collector releases it only after observing that pod as terminal or absent following a successful list. A Gateway/API outage therefore keeps later runs skipped until reconciliation.

Never force-remove a Lease while its pod may still execute. If a pod is force-deleted on a partitioned node, fence that node before resuming builds. A deleted API object alone does not prove the process has stopped.

The collector runs every 15 seconds by default. Job TTL defaults to 7 days; run summaries are retained for 90 days. Pause and verify schedules before disabling the feature, changing its namespace, restoring a database or removing the chart. CronJobs operate independently from Gateway. See the [deployment lifecycle](../helm/tessark-gateway/README.md#english) for revision cleanup and removal behavior.

### Results, logs and testing

The runner writes JSON to `/dev/termination-log`. Success includes the published digest reported by Buildah; failure includes a stage and a bounded error summary. Full logs remain in Kubernetes, while Gateway stores run summaries.

```bash
kubectl -n tessark-builds get jobs,pods,leases
kubectl -n tessark-builds logs POD_NAME -c build
kubectl -n tessark-builds describe pod POD_NAME
```

Use the actual build namespace and pod name. If execution fails before the build container starts, inspect init-container status and pod events. For skipped runs, inspect the claim and the previous pod before changing anything.

Run the runner’s unit tests from the repository root:

```bash
python3 scripts/test-build-runner.py
```

These tests check context-path handling; they do not replace a real Kubernetes build/push validation on your node profile.

## Français

### Rôle et prérequis

Cette image exécute la fonctionnalité optionnelle **Builds planifiés · Bêta**. Elle construit une image avec Buildah et la publie dans le registre du projet configuré. Elle est distincte de l’image applicative Gateway.

Pour construire/publier le runner, utiliser Buildah avec accès à l’image amont figée et aux dépôts de paquets, ainsi que des identifiants de publication pour le registre du runner. Pour exécuter les builds, utiliser Kubernetes avec des nœuds compatibles avec le profil ci-dessous, un robot Harbor limité au projet et une destination HTTPS vérifiée. Voir [l’activation Helm](../helm/tessark-gateway/README.md#français) pour les paramètres Gateway et les RBAC.

### Construire et publier

Depuis la racine du dépôt, remplacer le dépôt d’exemple :

```bash
buildah bud -t registry.example.com/team/tessark-build-runner:beta deploy/build-runner
buildah push --digestfile=/tmp/tessark-runner.digest \
  registry.example.com/team/tessark-build-runner:beta
cat /tmp/tessark-runner.digest
```

Définir `BUILDS_RUNNER_IMAGE` ou Helm `builds.runnerImage` à `registry.example.com/team/tessark-build-runner@sha256:YOUR_DIGEST`, avec le digest publié de 64 caractères. Un tag seul est refusé à l’activation. Activer aussi `BUILDS_BETA_ENABLED` et `K8S_ENABLED` (Helm `builds.enabled` et `config.k8sEnabled`).

Le [Dockerfile](Dockerfile) fige l’image Buildah amont par digest et installe Python/Git pendant la construction du runner. Les Dockerfiles exécutés ensuite peuvent encore télécharger leurs propres dépendances et images de base.

### Entrées et planification

Les administrateurs configurent les builds dans **Registres → Builds · Bêta** :

- Dockerfile saisi : contexte de construction vide.
- Dépôt Git HTTPS public : ref et chemins relatifs du contexte/Dockerfile.
- Arguments de build optionnels : valeurs de configuration, pas un canal pour les secrets.
- Cron UTC à cinq champs optionnel : la pause empêche les prochains lancements planifiés tout en conservant les lancements manuels.

Ce parcours ne fournit pas d’authentification Git privée. La destination doit disposer d’un robot de projet ; les builds ne se replient jamais sur le robot système. Les identifiants et la CA personnalisée sont figés dans un Secret de révision immuable. Réappliquer un build après rotation de ses identifiants ; les Jobs existants conservent leur révision initiale.

### Profil d’exécution Kubernetes

| Propriété | Profil |
| --- | --- |
| Conteneur de build | UID 1000, fsGroup 1000 |
| Stockage / isolation | Pilote VFS, isolation chroot |
| AppArmor / seccomp | Unconfined pour le conteneur de build |
| Privilèges | Aucun mode privilégié, SYS_ADMIN, socket Docker ou montage hôte |
| Init container de réservation | UID 0, toutes les capacités supprimées, seccomp RuntimeDefault |
| Token API | Projeté uniquement dans l’init container de réservation |
| Droits de réservation | Lease `create/get`, sans lecture des Secrets |

L’environnement de validation consigné était k3s v1.36.4, Ubuntu 22.04 et noyau 5.15. Un namespace Pod Security `restricted` n’admet pas ce profil. Utiliser un namespace/groupe de nœuds dédié pour des Dockerfiles approuvés par les administrateurs ; ce profil n’est pas une frontière d’isolation pour du code arbitraire non fiable.

Les limites de CPU, mémoire, stockage éphémère et durée se règlent sous `builds.*`. Avec les politiques réseau optionnelles, autoriser DNS, l’API Kubernetes pour les réservations, le registre cible et les sources Git/paquets/images de base nécessaires aux Dockerfiles approuvés. Le conteneur principal reçoit les identifiants de publication du projet mais aucun token de compte de service.

### Réservations et cycle de vie

Une Lease Kubernetes représente une réservation de build. Elle **n’expire pas** et son propriétaire est l’UID d’un pod. Le collecteur Gateway ne la libère qu’après avoir observé ce pod terminé ou absent à la suite d’une lecture de liste réussie. Une panne Gateway/API laisse donc les lancements suivants ignorés jusqu’à réconciliation.

Ne jamais supprimer une Lease de force si son pod peut encore s’exécuter. En cas de suppression forcée d’un pod sur un nœud isolé du réseau, neutraliser ce nœud avant de reprendre les builds. La suppression d’un objet API ne prouve pas que le processus est arrêté.

Le collecteur tourne toutes les 15 secondes par défaut. Le TTL des Jobs est de 7 jours ; les résumés restent 90 jours. Mettre en pause et vérifier les planifications avant de désactiver la fonctionnalité, changer son namespace, restaurer une base ou retirer le chart. Les CronJobs fonctionnent indépendamment du Gateway. Voir le [cycle de vie du déploiement](../helm/tessark-gateway/README.md#français) pour le nettoyage des révisions et les suppressions.

### Résultats, logs et tests

Le runner écrit du JSON dans `/dev/termination-log`. Un succès inclut le digest publié renvoyé par Buildah ; un échec indique l’étape et un résumé d’erreur borné. Les logs complets restent dans Kubernetes, tandis que Gateway conserve les résumés d’exécution.

```bash
kubectl -n tessark-builds get jobs,pods,leases
kubectl -n tessark-builds logs POD_NAME -c build
kubectl -n tessark-builds describe pod POD_NAME
```

Utiliser le véritable namespace et le nom du pod. Si l’exécution échoue avant le démarrage du conteneur de build, examiner l’état des init containers et les événements du pod. Pour les lancements ignorés, examiner la réservation et le pod précédent avant toute modification.

Lancer les tests unitaires du runner depuis la racine du dépôt :

```bash
python3 scripts/test-build-runner.py
```

Ces tests vérifient la gestion des chemins de contexte ; ils ne remplacent pas une validation réelle de build/push Kubernetes sur le profil des nœuds utilisés.
