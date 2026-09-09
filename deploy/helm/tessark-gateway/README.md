# tessark-gateway

Chart Helm pour [Tessark Gateway](../../../README.md). Ce document décrit les valeurs
de configuration et les prérequis de déploiement.

`helm install` avec ce `values.yaml` non modifié démarre en mode `database.mode: embedded`,
secrets mis à part (`auth.adminPassword` doit être fourni pour que le Job de bootstrap
réussisse — voir le [README principal](../../../README.md#déploiement-kubernetes)).

## Prérequis

- Kubernetes ≥ 1.27 (`kubeVersion` dans `Chart.yaml`).
- Une image déjà construite et importée dans le cluster — aucun registry n'existe pour ce
  projet à ce jour, voir `../../../scripts/build-and-import.sh`.
- Mode `database.mode: cnpg` uniquement : l'opérateur CloudNativePG déjà installé.

## Valeurs

| Clé | Type | Défaut | Description |
|---|---|---|---|
| `image.repository` | string | `tessark-gateway` | Nom de l'image (sans registry par défaut) |
| `image.tag` | string | `""` (→ `.Chart.AppVersion`) | Jamais `latest` — voir `build-and-import.sh` |
| `image.pullPolicy` | string | `IfNotPresent` | |
| `imagePullSecrets` | list | `[]` | |
| `replicaCount` | int | `2` | Nombre de réplicas applicatifs |
| `serviceAccount.create` | bool | `true` | |
| `serviceAccount.name` | string | `""` (→ nom généré) | |
| `rbac.create` | bool | `true` | **Obligatoire** pour le mirroring d'images (create/get/delete sur jobs et secrets) |
| `podSecurityContext.*` | object | non-root, uid/gid 1001 | |
| `securityContext.*` | object | `readOnlyRootFilesystem: true`, `drop: [ALL]` | Système de fichiers en lecture seule et capacités Linux supprimées |
| `resources` | object | `100m`/`256Mi` req, `1`/`1Gi` limit | |
| `podDisruptionBudget.enabled` | bool | `true` | Sans effet si `replicaCount: 1` |
| `podDisruptionBudget.minAvailable` | int | `1` | |
| `service.type` | string | `ClusterIP` | |
| `service.port` | int | `80` | |
| `ingress.enabled` | bool | `false` | |
| `ingress.ingressClassName` | string | `""` | Générique — aucun défaut de contrôleur |
| `ingress.annotations` | object | `{}` | |
| `ingress.hosts` | list | `[{host: gateway.example.com, paths: [{path: /, pathType: Prefix}]}]` | |
| `ingress.tls` | list | `[]` | |
| `nodeSelector` / `tolerations` / `affinity` / `topologySpreadConstraints` | | `{}` / `[]` | |
| `networkPolicy.enabled` | bool | `false` | Ingress uniquement, egress volontairement ouvert (Harbor est externe et variable) |
| `existingSecret` | string | `""` | Nom d'un Secret géré ailleurs (External Secrets, Vault...) — voir `templates/secret.yaml` pour les clés attendues |
| `secretKey` | string | `""` | `GATEWAY_SECRET_KEY` — laisser vide pour génération auto + préservation ; le chart refuse un changement qui contredirait la valeur déjà stockée |
| `auth.url` | string | `""` | Déduit du premier `ingress.hosts[]` si vide et `ingress.enabled: true` |
| `auth.trustHost` | bool | `true` | |
| `auth.adminUsername` | string | `admin` | Consommé une fois par le Job de seed |
| `auth.adminPassword` | string | `""` | **À fournir** pour que le premier install réussisse (sinon le Job de seed échoue explicitement) |
| `auth.seedUsers` | list | `[]` | Comptes additionnels créés une fois par le Job de seed, `{username, email, password, name?, role?}` — `role` par défaut `USER` |
| `auth.sessionRefreshSeconds` | int | `300` | Fraîcheur maximale du rôle mis en cache dans la session ; `0` = relecture en base à chaque requête |
| `oidc.enabled` | bool | `false` | Authentification unique OpenID Connect (Keycloak en cible de référence) — rien n'est exposé de plus tant que c'est `false` |
| `oidc.issuer` | string | `""` | **Requis si activé.** Tout le reste vient de `<issuer>/.well-known/openid-configuration` |
| `oidc.clientId` | string | `""` | **Requis si activé** |
| `oidc.clientSecret` | string | `""` | Rendu dans le Secret du chart, jamais dans le ConfigMap ; avec `existingSecret`, fournir `OIDC_CLIENT_SECRET` |
| `oidc.scopes` | string | `openid profile email` | |
| `oidc.displayName` | string | `Single sign-on` | Libellé du bouton de connexion et nom de l'annuaire dans l'UI |
| `oidc.allowLocalLogin` | bool | `true` | Garde le formulaire identifiant/mot de passe — **c'est le chemin de secours si l'IdP tombe** |
| `oidc.allowSignup` | bool | `true` | `false` = seuls les comptes déjà en base peuvent se connecter |
| `oidc.linkByEmail` | bool | `false` | Rattachement d'un compte local existant par email vérifié — pour une migration, à remettre à `false` ensuite |
| `oidc.roleClaim` | string | `groups` | Chemin pointé dans les claims (`realm_access.roles` pour les rôles de realm Keycloak) |
| `oidc.roleMapping` | map | `{}` | `valeur du claim → SUPERADMIN\|ADMIN\|USER`, le plus élevé l'emporte ; non vide ⇒ le rôle n'est plus modifiable depuis `/settings/users` |
| `oidc.defaultRole` | string | `USER` | Rôle des utilisateurs dont aucun groupe ne correspond |
| `oidc.logoutMode` | string | `local` | `idp` déconnecte aussi de l'IdP (donc de toutes les applications du realm) |
| `seedSources` | list | `[]` | Sources upstream créées une fois par le Job de seed, `{name, host, authType?, username?, secret?, allowedRepos, enabled?, description?}` — voir `src/lib/sources/presets.ts` |
| `config.k8sEnabled` | bool | `true` | `false` désactive proprement le mirroring (503 explicite, UI grisée) |
| `config.k8sNamespace` | string | `""` (→ namespace du pod) | |
| `config.k8sHttpTimeoutMs` | int | `10000` | |
| `config.harborHttpTimeoutMs` | int | `15000` | |
| `config.registryCheckTimeoutMs` | int | `8000` | |
| `config.defaultBrandName` / `defaultBrandTagline` | string | `Tessark` / `Gateway` | White-label avant tout passage dans `/settings` |
| `config.defaultPrimaryColor` | string | `""` | Hex, ex. `#3366ff` |
| `config.defaultLogoUrl` | string | `""` | Validée au démarrage (`isSafeLogoUrl`) |
| `config.logoMaxBytes` / `avatarMaxBytes` | int | `524288` / `262144` | |
| `config.logLevel` | string | `info` | `debug`\|`info`\|`warn`\|`error` |
| `apiExternal.enabled` | bool | `false` | Bearer API tokens acceptés sur `/api/*` en plus du cookie de session — n'expose rien tant qu'aucun token n'est créé depuis Settings |
| `apiExternal.tokenMaxTtlDays` | int | `365` | Plafond proposé à la création d'un token |
| `apiExternal.rateLimitPerMinute` | int | `60` | Par token (ou par IP avant résolution) — in-memory, non partagé entre réplicas |
| `mcp.enabled` | bool | `false` | `POST /api/mcp`, tools en lecture seule — nécessite aussi `apiExternal.enabled` (sinon 401 systématique) |
| `mcp.writeToolsEnabled` | bool | `false` | Ajoute `create_pull_request`/`approve_pull_request`/`create_project` au serveur MCP |
| `skopeo.image` | string | `quay.io/skopeo/stable:latest` | |
| `skopeo.jobTtlSeconds` / `jobBackoffLimit` / `jobActiveDeadlineSeconds` | int | `3600` / `1` / `1800` | |
| `skopeo.resources` | object | `100m`/`128Mi` req, `1`/`512Mi` limit | |
| `skopeo.nodeSelector` / `tolerations` / `imagePullSecrets` / `serviceAccount` | | `{}` / `[]` / `[]` / `""` | Placement du Job skopeo |
| `database.mode` | string | `embedded` | `embedded` \| `cnpg` \| `external` |
| `database.connectionLimit` | int | `5` | Appliqué à `DATABASE_URL` dans les trois modes — dimensionner selon `replicaCount` |
| `database.embedded.image` | string | `postgres:17-alpine` | |
| `database.embedded.storageSize` | string | `8Gi` | |
| `database.embedded.storageClassName` | string | `""` (→ défaut du cluster) | `local-path` sur k3s |
| `database.embedded.resources` | object | `250m`/`256Mi` req, `1`/`1Gi` limit | |
| `database.cnpg.instances` | int | `3` | |
| `database.cnpg.storageSize` / `storageClassName` | string | `10Gi` / `""` | |
| `database.external.host` / `port` / `database` / `username` / `password` | | — | Ignorés si `existingSecret` est fourni |
| `database.external.existingSecret` / `existingSecretPasswordKey` | string | `""` / `password` | |
| `database.external.sslMode` | string | `prefer` | |

## Les trois modes de base de données

- **`embedded`** *(défaut)* : StatefulSet Postgres 1 réplica géré par ce chart, PVC via
  `volumeClaimTemplates`. Suffit pour un install en une commande ou une petite prod.
- **`cnpg`** : ressource `Cluster` CloudNativePG. Nécessite l'opérateur déjà installé — le
  chart échoue au rendu avec un message explicite s'il ne l'est pas.
- **`external`** : rien n'est déployé, `DATABASE_URL` est assemblée depuis
  `database.external.*`.

## Survie à `helm uninstall`

Le Secret applicatif, le Secret et le PVC du Postgres embarqué portent
`helm.sh/resource-policy: keep` : un `helm uninstall` ne les supprime pas, un réinstall dans le
même namespace les retrouve. Voir les notes post-install (`NOTES.txt`) pour la commande de
suppression volontaire.

### Reprise du maillage Harbor

Le worker Node est activé par défaut dans chaque pod ; PostgreSQL coordonne les mutations.
Réglages sous `config` : `replicationWorkerEnabled: true`, `replicationPollSeconds: 60`,
`replicationVerifySeconds: 300`, `replicationCatchupSeconds: 3600` (0 désactive les passes de
sécurité périodiques). Appliquer la migration `20260906160000_replication_recovery` avant les
nouveaux pods via le Job de migration existant. Prévoir au moins deux connexions PostgreSQL
par pod. Voir [le contrat de reprise](../../../docs/replication/README.md).

## Scheduled builds (beta)

Build and publish the runner from [`deploy/build-runner`](../../build-runner/README.md),
then configure:

```yaml
config:
  k8sEnabled: true
builds:
  enabled: true
  runnerImage: registry.example/team/tessark-build-runner@sha256:<published-digest>
  namespace: tessark-builds
  maxActivePods: 4
  nodeSelector: {}
```

Save these settings in your deployment values file, replacing `<published-digest>` with
the runner's actual 64-character SHA-256 digest, then apply them:

```sh
helm upgrade --install tessark-gateway ./deploy/helm/tessark-gateway \
  --namespace tessark --create-namespace -f values-production.yaml
```

`builds.enabled` defaults to `false`. Helm validates the runner digest and rejects activation
when `config.k8sEnabled` is false. An empty `builds.namespace` uses the release namespace.
The chart configures the feature flag, runner settings, ServiceAccount and build RBAC
(`rbac.create: true` by default); the application creates Jobs and CronJobs when builds are configured.

Use a dedicated namespace/node pool that permits the documented rootless Buildah profile
(UID 1000, seccomp/AppArmor Unconfined; no privileged mode or SYS_ADMIN). Namespace quotas
bound active pods; per-pod CPU, memory, ephemeral storage and deadline are configurable.
Network policies are opt-in: allow DNS, the Kubernetes API for claims, the target registry,
Git and the package/base-image sources required by approved Dockerfiles.

An ADMIN configures builds under **Registries → Builds · Beta**. Sources are an inline
Dockerfile with an empty context, or a public HTTPS Git repository with a ref and relative
context/Dockerfile paths. Schedules use five-field cron in UTC, with hourly/daily/weekly/monthly
presets. Pause stops future scheduled runs; manual runs remain possible. Resume reapplies the
configuration. A project-scoped robot is required; no system robot fallback is used. Targets
must use verified HTTPS. Inline arguments are not a mechanism for supplying secrets.

Definitions survive an installation failure and can be reapplied. Current credentials and
CA are captured in immutable revision Secrets. Rotation suspends affected schedules; reapply
after rotation. Jobs already active retain their old snapshot and may fail if credentials
were revoked. The collector runs every 15 seconds by default, persists run summaries and
cleans up completed claims. A collector outage keeps a claim locked until reconciliation;
it never silently starts a second writer. Logs expire with pods (default 7 days), summaries
after 90 days. Old revision Secrets are collected only after a quiet retention interval and
when no Job/pod/current CronJob refers to them. Revision metadata remains until build deletion.

Pause and verify all schedules before disabling `builds.enabled`, disabling Kubernetes,
changing `builds.namespace`, removing the chart or restoring a database backup. The application
flag cannot atomically stop autonomous CronJobs. Keep the manager RBAC and Kubernetes access
until pending deletion completes. Project deletion and movement are blocked while build
configurations exist. Deleting a build stops its Jobs and removes transport resources before
removing the definition; it leaves published images intact.

For runner configuration, see the [build runner guide](../../build-runner/README.md).
