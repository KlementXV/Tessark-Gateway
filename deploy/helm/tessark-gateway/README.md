# Kubernetes deployment · Déploiement Kubernetes

On-premise / air-gap, private image registries and OCI Helm chart transfers: [deployment guide](../../../docs/on-premise-airgap.md).

Release notes and application/chart versioning: [changelog](../../../CHANGELOG.md) · [guide des releases](../../../docs/releases.md).

**[English](#english) · [Français](#français)** · [Tessark Gateway](../../../README.md)

## English

### Requirements

- Kubernetes **1.27 or later**, as declared in [Chart.yaml](Chart.yaml), and Helm 3.
- A Gateway image accessible to every node that may run application or migration pods.
- Storage provisioning for the embedded database, or an existing PostgreSQL service.
- Permissions to create the chart’s resources, including Roles/RoleBindings when `rbac.create=true`.
- For `database.mode=cnpg`, a preinstalled CloudNativePG operator. The chart does not install it.

Run the commands in this guide from the repository root. Examples consistently use release and namespace `tessark-gateway`. Supply your own image repository, tag, host and secrets.

Published application images are available through [the GHCR pipeline](../../../docs/ci/README.md#english). Set `image.repository: ghcr.io/klementxv/tessark-gateway` and a published version/commit tag. The following instructions are for building your own image.

### Build the application image

The [Dockerfile](../../../Dockerfile) builds with Node 22 and includes the standalone web server plus Prisma migration/seed tooling. Application configuration is supplied at runtime, not as image build arguments.

```bash
docker build -t registry.example.com/team/tessark-gateway:0.1.0 .
docker push registry.example.com/team/tessark-gateway:0.1.0
```

Use a new immutable tag for each release. For private registries, create a pull Secret in the application namespace and set `imagePullSecrets`.

For a local k3s node, images can instead be imported with `docker save IMAGE:TAG | sudo k3s ctr images import -`. Repeat the import on all eligible nodes. The convenience script `scripts/build-and-import.sh` requires Docker Buildx with a builder named `tessark-builder`, local k3s and sudo; it imports only to the local node.

### Install

Create a deployment values file outside the repository, for example `/secure/tessark-values.yaml`. The example below uses an image you have published and the chart’s embedded PostgreSQL:

```yaml
image:
  repository: registry.example.com/team/tessark-gateway
  tag: "0.1.0"
auth:
  url: https://gateway.example.com
  adminUsername: admin
  adminPassword: "REPLACE_WITH_A_UNIQUE_PASSWORD"
database:
  mode: embedded
ingress:
  enabled: true
  ingressClassName: nginx
  hosts:
    - host: gateway.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: gateway-tls
      hosts:
        - gateway.example.com
```

Replace the password before installation. Use the ingress class installed in your cluster and provision the referenced TLS Secret in the namespace. The chart does not install an ingress controller or issue certificates. If ingress is disabled, set `auth.url` to the URL actually used to reach the service.

```bash
helm upgrade --install tessark-gateway ./deploy/helm/tessark-gateway \
  --namespace tessark-gateway --create-namespace \
  -f /secure/tessark-values.yaml --timeout 10m

kubectl -n tessark-gateway rollout status deployment/tessark-gateway
helm test tessark-gateway --namespace tessark-gateway
```

On first installation, migration runs as a `post-install` hook, then seed creates the initial administrator. Pods can answer readiness before schema migration finishes; wait for Helm’s hooks to complete before using the application. Successful hook Jobs are deleted automatically. Upgrades run migration as a `pre-upgrade` hook, before applying the new Deployment. Seed is a first-install hook and does not reset existing accounts.

### Values reference

[values.yaml](values.yaml) is the full, commented list of defaults; [values.schema.json](values.schema.json) defines accepted types and constraints. The table below locates the main settings without duplicating the entire schema.

| Values | Defaults / purpose |
| --- | --- |
| `image.repository`, `image.tag`, `image.pullPolicy` | `tessark-gateway`, chart app version when tag is empty, `IfNotPresent` |
| `replicaCount`, `resources` | 2 pods; requests 100m/256Mi, limits 1 CPU/1Gi |
| `service.*`, `ingress.*` | ClusterIP port 80 → 3000; ingress disabled |
| `serviceAccount.*`, `rbac.create` | Chart-created service account and RBAC by default |
| `podSecurityContext`, `securityContext` | UID/GID 1001, non-root, read-only filesystem, dropped capabilities |
| `nodeSelector`, `tolerations`, `affinity`, `topologySpreadConstraints` | Pod placement |
| `podDisruptionBudget.*`, `networkPolicy.*` | PDB enabled with minimum 1; network policy disabled |
| `existingSecret`, `secretKey` | External application Secret, or chart-managed encryption key |
| `auth.*`, `oidc.*` | Bootstrap, public URL, session refresh and optional SSO |
| `seedSources`, `auth.seedUsers` | Optional first-run sources and users; not reapplied on upgrade |
| `config.*` | Kubernetes, Harbor timeouts, replication worker, branding and logging |
| `skopeo.*` | Transfer image, resources, placement and lifecycle; deadline 1800s, TTL 3600s, backoff 1 |
| `apiExternal.*`, `mcp.*` | Optional API tokens and MCP; both disabled |
| `customCa.enabled` | Custom CA beta, disabled |
| `notifications.*` | Optional webhook; formats json/slack/teams, timeout 5000ms, read-notification retention 30 days |
| `database.*` | PostgreSQL mode, storage and connection limit |
| `builds.*` | Optional build runner, scheduling infrastructure, limits and retention |

`config.k8sNamespace` defaults to the pod namespace. Setting a different transfer namespace requires additional RBAC there; it is not the same setting as `builds.namespace`. The optional application NetworkPolicy restricts ingress, with egress left open; the build policy has its own explicit egress rules.

### PostgreSQL modes

| Mode | Provisioning | Default storage |
| --- | --- | --- |
| `embedded` | One chart-managed PostgreSQL 17 Alpine StatefulSet replica | 8Gi, default storage class |
| `cnpg` | CloudNativePG `Cluster`, 3 instances | 10Gi per instance |
| `external` | No database deployed; connect to an existing PostgreSQL service | Managed outside the chart |

All modes use `database.connectionLimit: 5`. Size the database connection budget for all application replicas and migration/seed Jobs; the replication worker needs at least two connections per application process.

For an external database, set `database.mode: external` plus `database.external.host`, `port`, `database`, `username` and either `password` or `existingSecret` with `existingSecretPasswordKey` (default `password`). Host/user/database remain necessary when using the password Secret. `sslMode` defaults to `prefer`; choose the mode required by your database deployment. CNPG and external password Secrets provide credentials through pod environment references; `DATABASE_URL` may therefore not be present in the application Secret. See [the environment helpers](templates/_helpers.tpl).

### Optional CloudNativePG cluster

Set `database.mode: cnpg` to have this chart create a `postgresql.cnpg.io/v1` **Cluster**. The CloudNativePG operator must already be installed and running; it remains managed separately from the Gateway release. The chart checks for its Cluster CRD and fails clearly if it is absent.

Merge this into your deployment values file, alongside the application image, URL and bootstrap credentials:

```yaml
database:
  mode: cnpg
  connectionLimit: 5
  waitForReadySeconds: 600
  cnpg:
    instances: 3
    storageSize: 20Gi
    storageClassName: "" # Use the cluster default, or your database storage class.
    keepCluster: true
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: "1"
        memory: 1Gi
    affinity:
      enablePodAntiAffinity: true
      podAntiAffinityType: preferred
      topologyKey: kubernetes.io/hostname
      nodeSelector: {}
      tolerations: []
    parameters:
      max_connections: "100"
```

Three instances provide one primary and two replicas. The operator manages replication and failover; Gateway connects through the primary service `<release-fullname>-rw` and uses the generated `<release-fullname>-app` Secret. Database and owner remain `app` for compatibility with existing installations. Superuser access is disabled.

`preferred` anti-affinity permits a small cluster to schedule all instances, but multiple replicas on one node do not provide protection against that node failing. For three separate eligible nodes, set `podAntiAffinityType: required`; instances will remain Pending if insufficient nodes/storage are available. Database placement is configured under `database.cnpg.affinity`, separately from Gateway pod placement. See [CNPG scheduling](https://cloudnative-pg.io/docs/devel/scheduling/).

| Setting | Behavior |
| --- | --- |
| `database.cnpg.imageName` | Optional CNPG-compatible PostgreSQL image. Empty preserves the operator/existing cluster image choice; set it explicitly to control releases. Do not use the vanilla `postgres` image. |
| `database.cnpg.resources` | CPU/memory requests and limits per database instance |
| `database.cnpg.storageSize`, `storageClassName` | Storage per instance; expansion also depends on the StorageClass |
| `database.cnpg.parameters` | PostgreSQL parameters, with string values; CNPG validates supported settings |
| `database.cnpg.keepCluster` | `true` by default: Helm retains the Cluster on uninstall. Explicit deletion of the Cluster can still delete operator-owned resources. |
| `database.waitForReadySeconds` | Migration init container waits for a successful `SELECT 1`, default 600 seconds, for all database modes |

```bash
kubectl get crd clusters.postgresql.cnpg.io
helm upgrade --install tessark-gateway ./deploy/helm/tessark-gateway \
  --namespace tessark-gateway --create-namespace \
  -f /secure/tessark-values.yaml --timeout 20m
kubectl -n tessark-gateway wait --for=condition=Ready cluster/tessark-gateway --timeout=10m
kubectl -n tessark-gateway get cluster,pods,pvc
```

Adjust resource names if `nameOverride` or `fullnameOverride` is set. The readiness wait avoids exhausting migration retries while CNPG provisions PostgreSQL. Helm’s timeout also includes scheduling, image downloads and migrations, so leave additional headroom. The wait does not prove that every replica is healthy; inspect the Cluster status separately.

**Changing `database.mode` does not migrate existing data.** For an existing embedded/external database, arrange a separate database migration and retain the matching `GATEWAY_SECRET_KEY`. Use a fresh release/database for a new installation. Retention and replication are not backups: configure and test CNPG backups separately; this chart does not automatically configure a backup destination or schedule. Before reinstalling a retained cluster, confirm that the original operator-managed credentials and Gateway encryption key are still available.

### Secrets and backups

Without `existingSecret`, the chart creates and preserves `AUTH_SECRET` and `GATEWAY_SECRET_KEY` using the existing Secret on upgrades. A conflicting explicit `secretKey` is rejected. Keep the same encryption key with its database; replacing it makes stored registry and robot credentials unreadable.

An externally managed application Secret must include:

- `AUTH_SECRET` and `GATEWAY_SECRET_KEY`.
- `DATABASE_URL` for embedded mode or external mode without a separate password Secret.
- `GATEWAY_ADMIN_USERNAME` and `GATEWAY_ADMIN_PASSWORD` for first-run bootstrap.
- `OIDC_CLIENT_SECRET`, `NOTIFICATIONS_WEBHOOK_URL`, `GATEWAY_SEED_USERS` and `GATEWAY_SEED_SOURCES` when those optional settings are used.

The chart does not modify an `existingSecret`. Consult [the Secret template](templates/secret.yaml) for the exact conditions. Back up PostgreSQL, its access credentials and the associated encryption key together. Store backup material securely outside Git. For a restore, provision the matching key before starting Gateway against the restored database.

### Scheduled builds · Beta

First build and publish the [runner image](../../build-runner/README.md#english), then merge these settings into your deployment values:

```yaml
config:
  k8sEnabled: true
builds:
  enabled: true
  runnerImage: registry.example.com/team/tessark-build-runner@sha256:REPLACE_WITH_64_HEX_DIGEST
  namespace: tessark-builds
  maxActivePods: 4
  nodeSelector: {}
```

The example digest is a placeholder: the chart requires a real SHA-256 digest. Builds require Kubernetes. An empty build namespace uses the release namespace; a distinct namespace is created and retained by the chart, with a pod quota. Use a dedicated build namespace/node pool compatible with the runner’s security profile. With `rbac.create=false`, supply equivalent manager and claim permissions yourself.

An `ADMIN` configures builds under **Registries → Builds · Beta**. Sources are an inline Dockerfile with an empty context, or a public HTTPS Git repository with a ref and relative context/Dockerfile paths. Cron schedules have five fields and use UTC. Presets cover hourly/daily/weekly/monthly runs. Pause stops future schedules but permits manual runs; resume reapplies configuration.

A project-scoped robot and verified HTTPS destination are required. Build arguments are not a secret-delivery mechanism. Credentials and CA are snapshotted in immutable revision Secrets. Rotation suspends affected schedules: reapply after rotation; active Jobs retain their old snapshot and may fail if it was revoked.

| Setting | Default |
| --- | --- |
| `builds.pollSeconds`, `deadlineSeconds` | 15s collector interval, 1800s deadline |
| `builds.jobTtlSeconds`, `retentionDays` | 7 days for Jobs, 90 days for summaries |
| `builds.cpuRequest`, `cpuLimit` | 500m / 2 CPUs |
| `builds.memoryRequest`, `memoryLimit`, `storageLimit` | 512Mi / 2Gi / 10Gi |
| `builds.maxActivePods` | 4, quota when using a distinct build namespace |
| `builds.networkPolicy.enabled`, `egress` | Disabled / empty rules |

If enabling build network policies, allow the required DNS, Kubernetes API, target registry, Git, package and base-image endpoints. Logs live in Kubernetes and expire with pods. The collector stores run summaries and releases completed claims. Old revision Secrets are removed only after the retention interval and when no Job, pod or current CronJob references them; revision metadata remains until build deletion.

### Upgrade, restore and removal

1. Back up the database and encryption key before schema-changing upgrades.
2. Build/publish a new application tag, update the same values file, then rerun the installation command above.
3. Verify migration completion, Deployment rollout, readiness and feature behavior. An application rollback does not automatically undo database migrations.

Before disabling builds/Kubernetes, changing build namespace, restoring a database or uninstalling, **pause and verify scheduled builds**. Kubernetes CronJobs continue independently of application flags. Keep manager RBAC and API access until pending deletions finish. Build definitions block project deletion/movement; deleting a build stops its Jobs and removes transport resources while preserving published images.

Before disabling custom CA support, suspend or remove scheduled mirrors that depend on it. Existing CronJobs can keep running even after the feature flag changes.

```bash
helm uninstall tessark-gateway --namespace tessark-gateway
```

Uninstall retains the application Secret, embedded PostgreSQL credential Secret and persistent database volume. In CNPG mode it also retains the Cluster when `database.cnpg.keepCluster=true` (default). A separate build namespace is retained as well. Reinstallation can reuse existing data; uninstall is not a database reset. Review [NOTES.txt](templates/NOTES.txt) and actual remaining objects before deliberately deleting retained resources.

### Operations and troubleshooting

```bash
kubectl -n tessark-gateway get pods,jobs,pvc
kubectl -n tessark-gateway logs deployment/tessark-gateway
kubectl -n tessark-gateway get events --sort-by=.lastTimestamp
```

| Symptom | Action |
| --- | --- |
| `ImagePullBackOff` | Check repository/tag, pull Secret or image import on the selected node |
| Migration/seed failure | Inspect the failed hook Job and database connectivity; verify bootstrap credentials |
| Readiness 503 | Check runtime configuration and database reachability; liveness alone is not readiness |
| Transfer remains `RUNNING` | Inspect the destination Job, then synchronize status from the Transfers view or `POST /api/transfers/{id}/sync` |
| Replication does not catch up | Use the [replication runbook](../../../docs/replication/README.md#english) |
| Scheduled build remains skipped | Inspect the previous pod and claim; do not force-release a claim while its pod can still run |
| Bootstrap password change has no effect | The user already exists; use account administration rather than reseeding |

For a transfer, substitute its destination target ID:

```bash
kubectl -n tessark-gateway get jobs,secrets -l tessark.io/transfer-target-id=TARGET_ID
kubectl -n tessark-gateway logs job/JOB_NAME
kubectl -n tessark-gateway describe job JOB_NAME
```

Transfer Job defaults are a 30-minute deadline and one-hour TTL after completion. UI-driven synchronization updates transfer results; it is separate from the autonomous Harbor replication worker. Do not delete active transfer Jobs/Secrets during diagnosis. If all local administrators lose access, account recovery requires a controlled database intervention using the application’s password format; changing Helm bootstrap values cannot reset an existing password.

## Français

### Prérequis

- Kubernetes **1.27 ou ultérieur**, comme déclaré dans [Chart.yaml](Chart.yaml), et Helm 3.
- Une image Gateway accessible à chaque nœud pouvant exécuter l’application ou les migrations.
- Du stockage pour la base embarquée, ou un service PostgreSQL existant.
- Les droits nécessaires aux ressources du chart, dont les Roles/RoleBindings si `rbac.create=true`.
- Pour `database.mode=cnpg`, un opérateur CloudNativePG déjà installé. Le chart ne l’installe pas.

Exécuter les commandes depuis la racine du dépôt. Les exemples utilisent la release et le namespace `tessark-gateway`. Fournir son propre dépôt d’images, tag, domaine et secrets.

Les images applicatives sont publiées par [le pipeline GHCR](../../../docs/ci/README.md#français). Définir `image.repository: ghcr.io/klementxv/tessark-gateway` et un tag de version/commit publié. Les instructions suivantes servent à construire sa propre image.

### Construire l’image applicative

Le [Dockerfile](../../../Dockerfile) utilise Node 22 et contient le serveur web standalone ainsi que les outils Prisma de migration/seed. La configuration applicative arrive à l’exécution, pas par arguments de construction.

```bash
docker build -t registry.example.com/team/tessark-gateway:0.1.0 .
docker push registry.example.com/team/tessark-gateway:0.1.0
```

Utiliser un nouveau tag immuable à chaque version. Pour un registre privé, créer un Secret de téléchargement dans le namespace applicatif et configurer `imagePullSecrets`.

Sur un nœud k3s local, importer l’image avec `docker save IMAGE:TAG | sudo k3s ctr images import -` est une autre possibilité. Répéter l’import sur tous les nœuds éligibles. Le script `scripts/build-and-import.sh` exige Docker Buildx avec un builder nommé `tessark-builder`, k3s local et sudo ; il n’importe que sur le nœud local.

### Installer

Créer un fichier de valeurs hors du dépôt, par exemple `/secure/tessark-values.yaml`. L’exemple utilise une image préalablement publiée et PostgreSQL embarqué :

```yaml
image:
  repository: registry.example.com/team/tessark-gateway
  tag: "0.1.0"
auth:
  url: https://gateway.example.com
  adminUsername: admin
  adminPassword: "REMPLACER_PAR_UN_MOT_DE_PASSE_UNIQUE"
database:
  mode: embedded
ingress:
  enabled: true
  ingressClassName: nginx
  hosts:
    - host: gateway.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: gateway-tls
      hosts:
        - gateway.example.com
```

Remplacer le mot de passe avant installation. Utiliser la classe ingress du cluster et créer le Secret TLS référencé dans le namespace. Le chart n’installe aucun contrôleur ingress et n’émet aucun certificat. Sans ingress, définir `auth.url` avec l’adresse réellement utilisée pour joindre le service.

```bash
helm upgrade --install tessark-gateway ./deploy/helm/tessark-gateway \
  --namespace tessark-gateway --create-namespace \
  -f /secure/tessark-values.yaml --timeout 10m

kubectl -n tessark-gateway rollout status deployment/tessark-gateway
helm test tessark-gateway --namespace tessark-gateway
```

À la première installation, la migration s’exécute en hook `post-install`, puis le seed crée l’administrateur initial. Les pods peuvent répondre à la readiness avant la fin de la migration ; attendre la fin des hooks Helm avant d’utiliser l’application. Les Jobs de hooks réussis sont supprimés automatiquement. En mise à jour, la migration est un hook `pre-upgrade`, exécuté avant l’application du nouveau Deployment. Le seed est réservé à l’installation et ne réinitialise pas les comptes existants.

### Référence des valeurs

[values.yaml](values.yaml) contient la liste complète et commentée des défauts ; [values.schema.json](values.schema.json) définit les types et contraintes. Ce tableau permet de retrouver les principaux réglages sans recopier tout le schéma.

| Valeurs | Défauts / utilité |
| --- | --- |
| `image.repository`, `image.tag`, `image.pullPolicy` | `tessark-gateway`, version applicative du chart si tag vide, `IfNotPresent` |
| `replicaCount`, `resources` | 2 pods ; demandes 100m/256Mi, limites 1 CPU/1Gi |
| `service.*`, `ingress.*` | ClusterIP port 80 → 3000 ; ingress désactivé |
| `serviceAccount.*`, `rbac.create` | Compte de service et RBAC créés par défaut |
| `podSecurityContext`, `securityContext` | UID/GID 1001, non-root, fichiers en lecture seule, capacités supprimées |
| `nodeSelector`, `tolerations`, `affinity`, `topologySpreadConstraints` | Placement des pods |
| `podDisruptionBudget.*`, `networkPolicy.*` | PDB actif avec minimum 1 ; politique réseau désactivée |
| `existingSecret`, `secretKey` | Secret applicatif externe ou clé de chiffrement gérée par le chart |
| `auth.*`, `oidc.*` | Amorçage, URL publique, rafraîchissement des sessions et SSO optionnel |
| `seedSources`, `auth.seedUsers` | Sources et comptes initiaux optionnels ; non réappliqués à la mise à jour |
| `config.*` | Kubernetes, délais Harbor, worker de réplication, apparence et journalisation |
| `skopeo.*` | Image, ressources, placement et cycle de vie des transferts ; délai 1800s, TTL 3600s, backoff 1 |
| `apiExternal.*`, `mcp.*` | Tokens API et MCP optionnels, désactivés |
| `customCa.enabled` | CA personnalisées en bêta, désactivées |
| `notifications.*` | Webhook optionnel ; formats json/slack/teams, délai 5000ms, conservation des notifications lues 30 jours |
| `database.*` | Mode PostgreSQL, stockage et limite de connexions |
| `builds.*` | Runner optionnel, infrastructure de planification, limites et conservation |

`config.k8sNamespace` utilise par défaut le namespace du pod. Un namespace différent pour les transferts exige des RBAC supplémentaires ; ce réglage est distinct de `builds.namespace`. La NetworkPolicy applicative optionnelle limite les entrées en laissant les sorties ouvertes ; celle des builds possède ses propres règles de sortie explicites.

### Modes PostgreSQL

| Mode | Ressources | Stockage par défaut |
| --- | --- | --- |
| `embedded` | StatefulSet PostgreSQL 17 Alpine géré par le chart, un réplica | 8Gi, classe de stockage par défaut |
| `cnpg` | `Cluster` CloudNativePG, 3 instances | 10Gi par instance |
| `external` | Aucune base déployée ; connexion à un PostgreSQL existant | Géré hors du chart |

Tous les modes utilisent `database.connectionLimit: 5`. Dimensionner les connexions pour tous les réplicas applicatifs et les Jobs de migration/seed ; le worker de réplication exige au moins deux connexions par processus applicatif.

Pour une base externe, définir `database.mode: external`, puis `database.external.host`, `port`, `database`, `username` et soit `password`, soit `existingSecret` avec `existingSecretPasswordKey` (défaut `password`). Hôte/utilisateur/base restent nécessaires avec un Secret de mot de passe. `sslMode` vaut `prefer` par défaut ; choisir le mode adapté à la base. Les modes CNPG et externe avec Secret de mot de passe fournissent les identifiants par références d’environnement dans les pods ; `DATABASE_URL` peut donc être absent du Secret applicatif. Voir [les helpers d’environnement](templates/_helpers.tpl).

### Cluster CloudNativePG optionnel

Définir `database.mode: cnpg` pour que ce chart crée un **Cluster** `postgresql.cnpg.io/v1`. L’opérateur CloudNativePG doit être déjà installé et actif ; sa gestion reste séparée de la release Gateway. Le chart vérifie la présence de sa CRD Cluster et échoue explicitement si elle manque.

Intégrer ce bloc au fichier de valeurs du déploiement, avec l’image applicative, l’URL et les identifiants initiaux :

```yaml
database:
  mode: cnpg
  connectionLimit: 5
  waitForReadySeconds: 600
  cnpg:
    instances: 3
    storageSize: 20Gi
    storageClassName: "" # Classe par défaut du cluster, ou classe dédiée aux bases.
    keepCluster: true
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: "1"
        memory: 1Gi
    affinity:
      enablePodAntiAffinity: true
      podAntiAffinityType: preferred
      topologyKey: kubernetes.io/hostname
      nodeSelector: {}
      tolerations: []
    parameters:
      max_connections: "100"
```

Trois instances correspondent à un primaire et deux réplicas. L’opérateur gère la réplication et la bascule ; Gateway se connecte au service primaire `<release-fullname>-rw` et utilise le Secret généré `<release-fullname>-app`. La base et son propriétaire restent `app` pour préserver la compatibilité des installations existantes. L’accès superutilisateur est désactivé.

L’anti-affinité `preferred` permet de placer toutes les instances sur un petit cluster, mais plusieurs réplicas sur un même nœud ne protègent pas contre sa panne. Avec trois nœuds distincts éligibles, utiliser `podAntiAffinityType: required` ; les instances restent Pending si les nœuds ou le stockage sont insuffisants. Le placement de la base se configure sous `database.cnpg.affinity`, séparément des pods Gateway. Voir [le placement CNPG](https://cloudnative-pg.io/docs/devel/scheduling/).

| Réglage | Comportement |
| --- | --- |
| `database.cnpg.imageName` | Image PostgreSQL compatible CNPG optionnelle. Vide, elle conserve le choix de l’opérateur/du cluster existant ; la définir explicitement pour contrôler les versions. Ne pas utiliser l’image `postgres` standard. |
| `database.cnpg.resources` | Demandes et limites CPU/mémoire par instance de base |
| `database.cnpg.storageSize`, `storageClassName` | Stockage par instance ; son extension dépend aussi de la StorageClass |
| `database.cnpg.parameters` | Paramètres PostgreSQL sous forme de chaînes ; CNPG valide les réglages acceptés |
| `database.cnpg.keepCluster` | `true` par défaut : Helm conserve le Cluster à la désinstallation. Sa suppression explicite peut toujours supprimer les ressources appartenant à l’opérateur. |
| `database.waitForReadySeconds` | L’init container de migration attend un `SELECT 1` réussi, 600 secondes par défaut, pour tous les modes de base |

```bash
kubectl get crd clusters.postgresql.cnpg.io
helm upgrade --install tessark-gateway ./deploy/helm/tessark-gateway \
  --namespace tessark-gateway --create-namespace \
  -f /secure/tessark-values.yaml --timeout 20m
kubectl -n tessark-gateway wait --for=condition=Ready cluster/tessark-gateway --timeout=10m
kubectl -n tessark-gateway get cluster,pods,pvc
```

Adapter les noms avec `nameOverride` ou `fullnameOverride`. L’attente évite d’épuiser les tentatives de migration pendant le provisionnement PostgreSQL par CNPG. Le délai Helm inclut aussi placement, téléchargement des images et migrations ; prévoir une marge. Cette attente ne prouve pas que chaque réplica est sain ; vérifier séparément l’état du Cluster.

**Changer `database.mode` ne migre pas les données existantes.** Pour une base embedded/external déjà utilisée, organiser une migration de base distincte et conserver la même `GATEWAY_SECRET_KEY`. Pour une nouvelle installation, utiliser une nouvelle release/base. Conservation et réplication ne remplacent pas les sauvegardes : configurer et tester celles de CNPG séparément ; ce chart ne configure automatiquement ni destination ni planification de sauvegarde. Avant de réinstaller un cluster conservé, vérifier que ses identifiants gérés par l’opérateur et la clé de chiffrement Gateway restent disponibles.

### Secrets et sauvegardes

Sans `existingSecret`, le chart crée et préserve `AUTH_SECRET` et `GATEWAY_SECRET_KEY` en consultant le Secret existant lors des mises à jour. Une `secretKey` explicite différente est refusée. Conserver la même clé de chiffrement avec sa base ; la remplacer rend les identifiants de registres et de robots illisibles.

Un Secret applicatif externe doit contenir :

- `AUTH_SECRET` et `GATEWAY_SECRET_KEY`.
- `DATABASE_URL` en mode embarqué ou externe sans Secret de mot de passe séparé.
- `GATEWAY_ADMIN_USERNAME` et `GATEWAY_ADMIN_PASSWORD` pour l’amorçage initial.
- `OIDC_CLIENT_SECRET`, `NOTIFICATIONS_WEBHOOK_URL`, `GATEWAY_SEED_USERS` et `GATEWAY_SEED_SOURCES` si ces options sont utilisées.

Le chart ne modifie pas un `existingSecret`. Consulter [le template du Secret](templates/secret.yaml) pour les conditions exactes. Sauvegarder ensemble PostgreSQL, ses identifiants d’accès et la clé de chiffrement associée. Conserver les sauvegardes de façon sécurisée hors Git. Pour restaurer, fournir la clé correspondante avant de démarrer Gateway sur la base restaurée.

### Builds planifiés · Bêta

Construire et publier [l’image du runner](../../build-runner/README.md#français), puis intégrer ces paramètres aux valeurs du déploiement :

```yaml
config:
  k8sEnabled: true
builds:
  enabled: true
  runnerImage: registry.example.com/team/tessark-build-runner@sha256:REPLACE_WITH_64_HEX_DIGEST
  namespace: tessark-builds
  maxActivePods: 4
  nodeSelector: {}
```

Le digest d’exemple doit être remplacé : le chart exige un véritable digest SHA-256. Les builds nécessitent Kubernetes. Un namespace vide utilise celui de la release ; un namespace distinct est créé et conservé par le chart, avec un quota de pods. Utiliser un namespace/groupe de nœuds dédié compatible avec le profil du runner. Avec `rbac.create=false`, fournir soi-même les droits équivalents de gestion et de réservation.

Un `ADMIN` configure les builds dans **Registres → Builds · Bêta**. Les sources sont un Dockerfile saisi avec contexte vide, ou un dépôt Git HTTPS public avec une ref et des chemins relatifs de contexte/Dockerfile. Les crons ont cinq champs et utilisent UTC. Les préréglages couvrent les exécutions horaires/quotidiennes/hebdomadaires/mensuelles. La pause arrête les futures planifications mais autorise les lancements manuels ; la reprise réapplique la configuration.

Un robot limité au projet et une destination HTTPS vérifiée sont nécessaires. Les arguments de build ne servent pas à transmettre des secrets. Identifiants et CA sont figés dans des Secrets de révision immuables. Leur rotation suspend les planifications concernées : réappliquer ensuite ; les Jobs actifs gardent leur ancien instantané et peuvent échouer s’il a été révoqué.

| Réglage | Défaut |
| --- | --- |
| `builds.pollSeconds`, `deadlineSeconds` | Collecte toutes les 15s, délai 1800s |
| `builds.jobTtlSeconds`, `retentionDays` | 7 jours pour les Jobs, 90 jours pour les résumés |
| `builds.cpuRequest`, `cpuLimit` | 500m / 2 CPU |
| `builds.memoryRequest`, `memoryLimit`, `storageLimit` | 512Mi / 2Gi / 10Gi |
| `builds.maxActivePods` | 4, quota avec un namespace de builds distinct |
| `builds.networkPolicy.enabled`, `egress` | Désactivé / règles vides |

Avec les politiques réseau de builds, autoriser les destinations nécessaires : DNS, API Kubernetes, registre cible, Git, paquets et images de base. Les logs résident dans Kubernetes et expirent avec les pods. Le collecteur conserve les résumés et libère les réservations terminées. Les anciens Secrets de révision ne sont supprimés qu’après le délai de conservation et lorsqu’aucun Job, pod ou CronJob courant ne les référence ; leurs métadonnées restent jusqu’à suppression du build.

### Mise à jour, restauration et suppression

1. Sauvegarder la base et sa clé avant une mise à jour du schéma.
2. Construire/publier un nouveau tag, modifier le même fichier de valeurs, puis relancer la commande d’installation ci-dessus.
3. Vérifier la migration, le déploiement, la readiness et les fonctionnalités. Un retour arrière applicatif n’annule pas automatiquement les migrations de base.

Avant de désactiver les builds/Kubernetes, changer leur namespace, restaurer une base ou désinstaller, **mettre en pause et vérifier les builds planifiés**. Les CronJobs Kubernetes fonctionnent indépendamment des variables applicatives. Conserver les RBAC de gestion et l’accès API jusqu’à la fin des suppressions en attente. Les définitions de builds bloquent la suppression/le déplacement d’un projet ; supprimer un build arrête ses Jobs et retire ses ressources de transport, en conservant les images publiées.

Avant de désactiver les CA personnalisées, suspendre ou supprimer les miroirs planifiés qui en dépendent. Les CronJobs existants peuvent continuer après modification de la variable d’activation.

```bash
helm uninstall tessark-gateway --namespace tessark-gateway
```

La désinstallation conserve le Secret applicatif, le Secret d’identifiants PostgreSQL embarqué et le volume persistant de la base. En mode CNPG, elle conserve aussi le Cluster si `database.cnpg.keepCluster=true` (défaut). Un namespace de builds distinct est aussi conservé. Une réinstallation peut retrouver les données ; désinstaller ne réinitialise pas la base. Examiner [NOTES.txt](templates/NOTES.txt) et les objets réellement restants avant une suppression volontaire des ressources conservées.

### Exploitation et diagnostic

```bash
kubectl -n tessark-gateway get pods,jobs,pvc
kubectl -n tessark-gateway logs deployment/tessark-gateway
kubectl -n tessark-gateway get events --sort-by=.lastTimestamp
```

| Symptôme | Action |
| --- | --- |
| `ImagePullBackOff` | Vérifier dépôt/tag, Secret de téléchargement ou import sur le nœud choisi |
| Échec migration/seed | Examiner le Job de hook en échec et la connexion à la base ; vérifier les identifiants initiaux |
| Readiness 503 | Vérifier configuration et accès à la base ; la liveness ne suffit pas |
| Transfert restant `RUNNING` | Examiner le Job cible, puis synchroniser depuis Transferts ou `POST /api/transfers/{id}/sync` |
| Réplication sans rattrapage | Suivre le [guide de reprise](../../../docs/replication/README.md#français) |
| Build planifié toujours ignoré | Examiner le pod précédent et sa réservation ; ne pas la libérer de force si le pod peut encore tourner |
| Modifier le mot de passe initial ne change rien | L’utilisateur existe déjà ; utiliser l’administration des comptes plutôt que le seed |

Pour un transfert, remplacer l’identifiant de sa cible :

```bash
kubectl -n tessark-gateway get jobs,secrets -l tessark.io/transfer-target-id=TARGET_ID
kubectl -n tessark-gateway logs job/JOB_NAME
kubectl -n tessark-gateway describe job JOB_NAME
```

Les Jobs de transfert ont par défaut un délai maximal de 30 minutes et un TTL d’une heure après achèvement. La synchronisation depuis l’interface actualise leurs résultats ; elle est distincte du worker autonome de réplication Harbor. Ne pas supprimer les Jobs/Secrets actifs pendant le diagnostic. Si tous les administrateurs locaux perdent l’accès, la récupération exige une intervention contrôlée en base avec le format de mot de passe de l’application ; les valeurs d’amorçage Helm ne réinitialisent pas un compte existant.
