# Tessark Gateway

A web portal for managing Harbor registries, projects and image delivery.

Un portail web pour administrer les registres Harbor, les projets et la livraison d’images.

**[English](#english) · [Français](#français)**

## English

### Overview

Tessark Gateway brings multiple Harbor registries into one interface. It manages projects, access, robot accounts, retention, replication and transfers. PostgreSQL stores application state; Harbor stores images. Kubernetes runs image transfer and optional build jobs.

| Capability | What it provides |
| --- | --- |
| Registry management | Managed Harbor clusters and delivery destinations |
| Projects and access | Project membership, directory mappings, groups and robot accounts |
| Image delivery | Policy-controlled transfers from approved sources to one or more destinations |
| Replication | Harbor replication policies with background reconciliation and catch-up |
| Authentication | Local accounts and optional OpenID Connect SSO |
| Integration | REST API, OpenAPI/Swagger and optional MCP endpoint |
| Scheduled builds · Beta | Buildah builds from Dockerfiles or public HTTPS Git repositories |
| Interface | English/French UI, branding settings and notifications |

Harbor support is recorded per capability and version in the [compatibility matrix](docs/harbor/README.md#english). A declared version range is not proof that every feature has passed a live test.

### Documentation

| Guide | Contents |
| --- | --- |
| [Kubernetes and Helm](deploy/helm/tessark-gateway/README.md#english) | Images, installation, values, database modes, upgrades and operations |
| [Authentication and directories](docs/authentication/README.md#english) | Local accounts, SSO, role mapping and Harbor identities |
| [REST API and MCP](docs/api/README.md#english) | Tokens, endpoints, rate limits and tools |
| [Replication and recovery](docs/replication/README.md#english) | Worker configuration, retries, consistency and troubleshooting |
| [Build runner](deploy/build-runner/README.md#english) | Runner image, execution profile, credentials and lifecycle |
| [Harbor compatibility](docs/harbor/README.md#english) | Version matrix, evidence and required tests |

### Local development

Use **Node.js 22**, npm and Docker with Compose. The local Compose file provides PostgreSQL 16. Kubernetes is optional for working on the web interface; transfers and builds require a reachable Kubernetes API and appropriate permissions. Commands below run from the repository root.

```bash
git clone https://github.com/KlementXV/Tessark-Gateway.git
cd Tessark-Gateway
npm ci
cp .env.example .env.local
docker compose -f docker-compose.dev.yml up -d postgres
```

Edit `.env.local` before continuing:

| Variable | Local setup |
| --- | --- |
| `DATABASE_URL` | Keep the example URL for the Compose database |
| `AUTH_SECRET` | Replace the example with a fresh `openssl rand -base64 32` value |
| `GATEWAY_SECRET_KEY` | Generate a separate value with `openssl rand -base64 32` |
| `GATEWAY_ADMIN_USERNAME` | Choose the initial administrator username |
| `GATEWAY_ADMIN_PASSWORD` | Set a unique password of at least 8 characters |
| `AUTH_URL` | `http://localhost:3000` |
| `K8S_ENABLED` | `false` for UI development without Kubernetes |

Wait until PostgreSQL is healthy (`docker compose -f docker-compose.dev.yml ps`), then:

```bash
npm run prisma:generate
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

Open **http://localhost:3000** and sign in with the bootstrap account. Seeding does nothing once any user exists: changing bootstrap credentials later does not reset a password. Use the user administration screen for subsequent account management.

Use `npm run prisma:migrate -- --name your_change` when developing a schema change; commit the resulting migration. `./start.sh` starts PostgreSQL and the dev server after initial setup, but does not generate Prisma, migrate or seed the database.

To build and run the production web server locally, use `npm run build` followed by `npm start`. Keep the database and runtime configuration available. The container uses its standalone server directly.

### First registry and transfer

1. Sign in as the bootstrap `SUPERADMIN` and add a Harbor registry under **Registries**. Verify its endpoint, credentials and TLS configuration.
2. Use `MANAGED` for a registry where Gateway manages projects and replication, or `DELIVERY` for a destination where it reads projects and pushes images. Delivery registries cannot join clusters.
3. Create a cluster/project as needed and configure access and robot credentials. Gateway and Harbor identities may differ; see the [directory guide](docs/authentication/README.md#english).
4. As `SUPERADMIN`, configure approved upstream sources and enabled directional rules under `/registries/policy`. A transfer without a matching enabled rule is refused. Rules can require approval and constrain transfer job settings.
5. Create a transfer, obtain approval when required, and inspect each destination’s result. Each destination runs independently in its own `skopeo` Job. Transfers from a known Harbor project pin the source digest when requested.

Moving an empty project to another cluster changes its placement and configuration; it does not copy images. Use transfers for content delivery.

### Runtime configuration

[`.env.example`](.env.example) documents the configuration variables and [the configuration schema](src/lib/config.ts) defines defaults and validation. Local Next.js and Prisma commands read `.env.local`. Containers receive settings at runtime through environment variables and Kubernetes Secrets/ConfigMaps. Configuration read through the application schema also supports `<NAME>_FILE`; a configured file takes precedence over the direct variable.

| Optional feature | Environment flag | Helm value | Default |
| --- | --- | --- | --- |
| SSO | `OIDC_ENABLED` | `oidc.enabled` | `false` |
| Bearer API | `API_EXTERNAL_ENABLED` | `apiExternal.enabled` | `false` |
| MCP | `MCP_ENABLED` | `mcp.enabled` | `false` |
| MCP writes | `MCP_WRITE_TOOLS_ENABLED` | `mcp.writeToolsEnabled` | `false` |
| Custom CA · Beta | `CUSTOM_CA_BETA_ENABLED` | `customCa.enabled` | `false` |
| Scheduled builds · Beta | `BUILDS_BETA_ENABLED` | `builds.enabled` | `false` |
| Replication worker | `REPLICATION_WORKER_ENABLED` | `config.replicationWorkerEnabled` | `true` |

A notification webhook is optional (`NOTIFICATIONS_WEBHOOK_URL`, format `json`, `slack` or `teams`). Its URL is a credential; keep it in secret configuration. Registry topology, project membership and policies are managed in the application and database.

**Back up PostgreSQL together with `GATEWAY_SECRET_KEY`.** That key encrypts stored registry and robot credentials. Losing it or replacing it without a migration makes those credentials unreadable. Local `.env` files are excluded from Git; `.env.example` contains development examples, not production credentials.

### Validation and contributing

After installing dependencies and generating Prisma:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run check:messages
npm run check:env-example
npm run check:harbor-surface
npm run check:harbor-matrix
npm run build
```

`npm test` uses mocked HTTP and `tests/env.fixture`; it does not require live PostgreSQL, Harbor or Kubernetes. Additional integration checks are separate:

```bash
# Uses a temporary schema on the PostgreSQL instance from .env.local.
node --env-file=.env.local scripts/test-replication-postgres.mjs

# Requires a dedicated Harbor test instance and conformance credentials.
npm run test:harbor

# Runner unit tests.
python3 scripts/test-build-runner.py
```

The [replication guide](docs/replication/README.md#english) describes database and recovery validation. Harbor test connection settings are documented in [the test target](tests/harbor/target.ts); those tests create resources on the target instance.

For changes, include relevant tests, update both language sections of affected README files and run the checks above. The Harbor README is generated: modify [its generator](scripts/gen-harbor-matrix.ts) or source evidence, then run `npm run gen:harbor-matrix`. Do not edit its generated table by hand.

### Troubleshooting

| Symptom | First check |
| --- | --- |
| Missing Prisma client | Run `npm run prisma:generate` |
| Database unavailable | Check Compose health, `DATABASE_URL` and applied migrations |
| Bootstrap password change has no effect | Seed runs only when the user table is empty |
| Transfers unavailable locally | `K8S_ENABLED=false` disables Kubernetes execution |
| SSO login or role mismatch | Check the exact callback URL and token claims in the authentication guide |
| API or MCP request denied | Check feature flags, token validity and owner permissions |
| Pod readiness fails | `/api/ready` reports configuration and database checks |

`GET /api/health` tests HTTP liveness. `GET /api/ready` returns 503 for invalid configuration or an unavailable database; Kubernetes health is reported but does not itself fail readiness. Deployment troubleshooting is covered in the Helm guide.

## Français

### Présentation

Tessark Gateway réunit plusieurs registres Harbor dans une interface. Il gère les projets, les accès, les comptes robots, la rétention, la réplication et les transferts. PostgreSQL conserve l’état applicatif ; Harbor stocke les images. Kubernetes exécute les transferts et les builds optionnels.

| Fonctionnalité | Utilité |
| --- | --- |
| Gestion des registres | Clusters Harbor administrés et destinations de livraison |
| Projets et accès | Appartenances, correspondances d’annuaire, groupes et comptes robots |
| Livraison d’images | Transferts soumis à des règles, depuis des sources approuvées vers plusieurs destinations |
| Réplication | Politiques Harbor avec réconciliation et rattrapage en arrière-plan |
| Authentification | Comptes locaux et SSO OpenID Connect optionnel |
| Intégration | API REST, OpenAPI/Swagger et point d’accès MCP optionnel |
| Builds planifiés · Bêta | Builds Buildah depuis un Dockerfile ou un dépôt Git HTTPS public |
| Interface | Interface français/anglais, personnalisation visuelle et notifications |

La [matrice de compatibilité](docs/harbor/README.md#français) décrit le support Harbor par fonctionnalité et version. Une plage de versions déclarée ne prouve pas que chaque fonctionnalité a passé un test réel.

### Documentation

| Guide | Contenu |
| --- | --- |
| [Kubernetes et Helm](deploy/helm/tessark-gateway/README.md#français) | Images, installation, valeurs, bases de données, mises à jour et exploitation |
| [Authentification et annuaires](docs/authentication/README.md#français) | Comptes locaux, SSO, attribution des rôles et identités Harbor |
| [API REST et MCP](docs/api/README.md#français) | Tokens, points d’accès, limites de débit et outils |
| [Réplication et reprise](docs/replication/README.md#français) | Configuration du worker, tentatives, cohérence et diagnostic |
| [Runner de builds](deploy/build-runner/README.md#français) | Image du runner, profil d’exécution, identifiants et cycle de vie |
| [Compatibilité Harbor](docs/harbor/README.md#français) | Matrice des versions, preuves et tests requis |

### Développement local

Utiliser **Node.js 22**, npm et Docker avec Compose. Le fichier Compose local fournit PostgreSQL 16. Kubernetes est facultatif pour travailler sur l’interface ; les transferts et les builds exigent une API Kubernetes accessible et les autorisations adaptées. Exécuter les commandes depuis la racine du dépôt.

```bash
git clone https://github.com/KlementXV/Tessark-Gateway.git
cd Tessark-Gateway
npm ci
cp .env.example .env.local
docker compose -f docker-compose.dev.yml up -d postgres
```

Modifier `.env.local` avant de poursuivre :

| Variable | Configuration locale |
| --- | --- |
| `DATABASE_URL` | Conserver l’URL d’exemple pour la base Compose |
| `AUTH_SECRET` | Remplacer l’exemple par une valeur générée avec `openssl rand -base64 32` |
| `GATEWAY_SECRET_KEY` | Générer une autre valeur avec `openssl rand -base64 32` |
| `GATEWAY_ADMIN_USERNAME` | Choisir le nom du premier administrateur |
| `GATEWAY_ADMIN_PASSWORD` | Définir un mot de passe unique d’au moins 8 caractères |
| `AUTH_URL` | `http://localhost:3000` |
| `K8S_ENABLED` | `false` pour développer l’interface sans Kubernetes |

Attendre que PostgreSQL soit sain (`docker compose -f docker-compose.dev.yml ps`), puis :

```bash
npm run prisma:generate
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

Ouvrir **http://localhost:3000** et se connecter avec le compte initial. Le seed ne fait rien dès qu’un utilisateur existe : modifier ensuite les identifiants d’amorçage ne réinitialise aucun mot de passe. Utiliser l’administration des utilisateurs pour gérer les comptes suivants.

Utiliser `npm run prisma:migrate -- --name votre_modification` pour faire évoluer le schéma, puis commiter la migration produite. Après la première installation, `./start.sh` démarre PostgreSQL et le serveur de développement ; il ne génère pas Prisma et ne lance ni migration ni seed.

Pour construire et lancer le serveur web de production localement, utiliser `npm run build`, puis `npm start`. La base et la configuration d’exécution doivent rester disponibles. Le conteneur lance directement son serveur standalone.

### Premier registre et premier transfert

1. Se connecter avec le `SUPERADMIN` initial et ajouter un registre Harbor dans **Registres**. Vérifier son adresse, ses identifiants et sa configuration TLS.
2. Choisir `MANAGED` pour un registre dont Gateway administre les projets et la réplication, ou `DELIVERY` pour une destination où il lit les projets et pousse les images. Un registre de livraison ne peut pas rejoindre un cluster.
3. Créer le cluster/projet nécessaire et configurer les accès et les identifiants robots. Les identités Gateway et Harbor peuvent différer ; consulter le [guide des annuaires](docs/authentication/README.md#français).
4. En tant que `SUPERADMIN`, définir les sources amont approuvées et les règles directionnelles activées dans `/registries/policy`. Sans règle correspondante activée, le transfert est refusé. Les règles peuvent imposer une approbation et encadrer les paramètres des Jobs.
5. Créer un transfert, obtenir l’approbation si nécessaire, puis consulter le résultat de chaque destination. Chacune utilise son propre Job `skopeo`, indépendant des autres. Pour une source issue d’un projet Harbor connu, le digest est figé à la demande.

Déplacer un projet vide vers un autre cluster modifie son emplacement et sa configuration ; cela ne copie pas les images. Utiliser les transferts pour livrer du contenu.

### Configuration d’exécution

[`.env.example`](.env.example) documente les variables ; [le schéma de configuration](src/lib/config.ts) définit les valeurs par défaut et leur validation. En local, Next.js et les commandes Prisma lisent `.env.local`. Les conteneurs reçoivent leurs paramètres à l’exécution par variables d’environnement et Secrets/ConfigMaps Kubernetes. Les paramètres lus par le schéma applicatif acceptent aussi `<NAME>_FILE` ; le fichier est prioritaire sur la variable directe.

| Fonctionnalité optionnelle | Variable d’activation | Valeur Helm | Défaut |
| --- | --- | --- | --- |
| SSO | `OIDC_ENABLED` | `oidc.enabled` | `false` |
| API Bearer | `API_EXTERNAL_ENABLED` | `apiExternal.enabled` | `false` |
| MCP | `MCP_ENABLED` | `mcp.enabled` | `false` |
| Écriture MCP | `MCP_WRITE_TOOLS_ENABLED` | `mcp.writeToolsEnabled` | `false` |
| CA personnalisées · Bêta | `CUSTOM_CA_BETA_ENABLED` | `customCa.enabled` | `false` |
| Builds planifiés · Bêta | `BUILDS_BETA_ENABLED` | `builds.enabled` | `false` |
| Worker de réplication | `REPLICATION_WORKER_ENABLED` | `config.replicationWorkerEnabled` | `true` |

Un webhook de notification est optionnel (`NOTIFICATIONS_WEBHOOK_URL`, format `json`, `slack` ou `teams`). Son URL est un identifiant sensible à conserver dans la configuration secrète. La topologie des registres, les appartenances aux projets et les règles se gèrent dans l’application et sa base.

**Sauvegarder PostgreSQL avec `GATEWAY_SECRET_KEY`.** Cette clé chiffre les identifiants de registres et de robots stockés. La perdre ou la remplacer sans migration rend ces identifiants illisibles. Les fichiers `.env` locaux sont exclus de Git ; `.env.example` contient des exemples de développement, pas des identifiants de production.

### Validation et contributions

Après l’installation des dépendances et la génération de Prisma :

```bash
npm run lint
npx tsc --noEmit
npm test
npm run check:messages
npm run check:env-example
npm run check:harbor-surface
npm run check:harbor-matrix
npm run build
```

`npm test` utilise des réponses HTTP simulées et `tests/env.fixture` ; il ne nécessite aucun PostgreSQL, Harbor ou Kubernetes réel. Les vérifications d’intégration sont séparées :

```bash
# Utilise un schéma temporaire sur le PostgreSQL configuré dans .env.local.
node --env-file=.env.local scripts/test-replication-postgres.mjs

# Exige une instance Harbor dédiée aux tests et des identifiants de conformance.
npm run test:harbor

# Tests unitaires du runner.
python3 scripts/test-build-runner.py
```

Le [guide de réplication](docs/replication/README.md#français) décrit la validation de la base et de la reprise. Les paramètres de connexion des tests Harbor figurent dans [leur configuration cible](tests/harbor/target.ts) ; ces tests créent des ressources sur l’instance visée.

Pour une contribution, ajouter les tests pertinents, mettre à jour les deux langues des README concernés et lancer les vérifications ci-dessus. Le README Harbor est généré : modifier [son générateur](scripts/gen-harbor-matrix.ts) ou les preuves sources, puis exécuter `npm run gen:harbor-matrix`. Ne pas modifier sa matrice à la main.

### Dépannage

| Symptôme | Première vérification |
| --- | --- |
| Client Prisma absent | Lancer `npm run prisma:generate` |
| Base inaccessible | Vérifier l’état Compose, `DATABASE_URL` et les migrations appliquées |
| Changer le mot de passe initial n’a aucun effet | Le seed ne s’exécute que si la table des utilisateurs est vide |
| Transferts indisponibles en local | `K8S_ENABLED=false` désactive l’exécution Kubernetes |
| Échec SSO ou mauvais rôle | Vérifier l’URL de retour exacte et les claims avec le guide d’authentification |
| Requête API ou MCP refusée | Vérifier les activations, le token et les droits de son propriétaire |
| Readiness du pod en échec | `/api/ready` indique l’état de la configuration et de la base |

`GET /api/health` vérifie que le serveur HTTP répond. `GET /api/ready` renvoie 503 si la configuration est invalide ou la base inaccessible ; l’état Kubernetes est indiqué, mais ne fait pas échouer la readiness à lui seul. Le guide Helm couvre le diagnostic du déploiement.
