# CI and container packages · CI et packages conteneurs

**[English](#english) · [Français](#français)** · [Tessark Gateway](../../README.md)

## English

### Pipeline

[The workflow](../../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, version tags beginning with `v`, and manual **Run workflow** requests.

| Job | Checks |
| --- | --- |
| Code and configuration | Version/changelog/tag consistency, Prisma generation, ESLint, TypeScript, translations, environment example, Harbor surface/matrix, production dependency audit (high/critical) |
| Tests, Node 22 and 24 | Application unit tests, real local TLS handshakes, Python build-runner tests |
| PostgreSQL | PostgreSQL 17 service, all migrations in a temporary schema, cross-connection locks and durable cleanup |
| Helm | Lint, embedded/CNPG/external rendering, CNPG configuration/credentials, migration wait/retry behavior, build configuration and rejection of invalid activation |
| Image | Linux AMD64 Docker build, migrations, idempotent seed, password preservation, readiness, login page, API authentication boundary and Swagger |
| Publish | Download the tested image, verify its image ID, then push it to GHCR |
| Release | After a successful version-tag publication, create the GitHub Release with changelog notes, chart archive, application image digests and checksums |

The image job waits for all checks. The publish job has no source checkout and does not rebuild or execute the application; it publishes the artifact that passed the image checks. Only this job receives `packages: write`. Actions are pinned to commit SHAs. Pull requests use `pull_request`, not `pull_request_target`, and never publish.

The image is built without application secrets. Docker layer caching and npm caching speed up subsequent runs. The tested image archive is retained for one day; release assets for seven days. Logs and published image references are available in the Actions run. Manual runs validate only unless `publish_release=true` is explicitly requested on a version tag.

Use **Actions → Prepare release** to open a version/changelog PR, then **Publish release** on `main` after merging and passing CI. Publication verifies the exact main commit and dispatches this pipeline on its version tag. Both workflows use `GITHUB_TOKEN`; see [setup and operation](../releases.md). The local preparation command remains available.

### Runtime image contents

The runner ships Next.js standalone output plus the installed dependency closure of Prisma,
tsx, dotenv and zod for the Helm migration/seed hooks. `scripts/prepare-runtime.mjs` resolves
those packages from the lockfile-installed builder tree, preserving nested versions and native
optional packages without a second dependency installation. The full builder `node_modules`
is never copied into a final layer. Source files used by the TypeScript seed and its path
aliases remain available. The same image still runs the web server, `prisma migrate deploy`
and `prisma db seed`; no separate migration image is required.

`test-image.sh` verifies the absence of build-only packages as well as migrations, seed and web
endpoints. Run locally with `docker build -t tessark-gateway:local .` followed by
`bash scripts/test-image.sh tessark-gateway:local`.

### Package and tags

The application package is **`ghcr.io/klementxv/tessark-gateway`**. The image name is derived from the repository and lowercased, so a fork publishes under its own repository name.

| Trigger | Published tags |
| --- | --- |
| Push to `main` | `main`, `sha-<full-commit>` |
| Tag `v1.2.3` | `1.2.3`, `latest`, `sha-<full-commit>` |
| Tag `v1.2.3-rc.1` | `1.2.3-rc.1`, `sha-<full-commit>`; does not change `latest` |
| Manual run on a version tag with `publish_release=true` | Same tags as a push of that version tag |
| Pull request or other manual run | None |

Before publication, CI checks that the Git tag matches `package.json`, the lockfile, the chart's `appVersion` and a dated entry in [CHANGELOG.md](../../CHANGELOG.md). The chart has its own independent version. Prepare these files through **Prepare release**, or locally with `npm run release:prepare -- VERSION --chart CHART_VERSION`; see [the release guide](../releases.md).

`latest` follows the most recently published stable release, not development pushes. For a deployment that must not change when a tag is updated, use `image.digest` in Helm; it takes precedence over `image.tag`. The build runner separately requires a digest.

```bash
docker pull ghcr.io/klementxv/tessark-gateway:main

# After preparing the release files, reviewing and committing them, and passing CI:
npm run version:check -- --tag v1.2.3
git tag v1.2.3
git push origin v1.2.3
```

Choose a version that has not been released before. The workflow builds the application image only; the separate Buildah runner remains documented in [its guide](../../deploy/build-runner/README.md#english).

### GitHub configuration

GitHub Actions must be enabled and repository policy must allow the pinned actions and package writes. Publication uses the built-in **`GITHUB_TOKEN`**; no Docker Hub account or personal access token is required by this workflow. OCI source labels associate the image with the repository. This follows [GitHub’s container publication guidance](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).

A newly created container package is private by default, even for a public repository. To permit anonymous pulls, change its visibility under the package’s settings if that is intended. Otherwise authenticate before pulling. If the package already exists, grant this repository Actions access to it. See [GitHub’s Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

For Helm, set:

```yaml
image:
  repository: ghcr.io/klementxv/tessark-gateway
  tag: sha-REPLACE_WITH_FULL_COMMIT
```

Use the published commit tag; `main` is a moving tag and the chart’s default `IfNotPresent` pull policy can retain an older cached image. For a private package, configure an appropriate `imagePullSecrets` entry in the target namespace.

### Reproduce checks locally

After the [local prerequisites](../../README.md#english):

```bash
npm ci
npm run prisma:generate
npm run version:check
npm run lint
npx tsc --noEmit
npm test
npm run check:messages
npm run check:env-example
npm run check:harbor-surface
npm run check:harbor-matrix
npm audit --omit=dev --audit-level=high
python3 scripts/test-build-runner.py
bash scripts/check-chart.sh
node --env-file=.env.local scripts/test-replication-postgres.mjs
docker build -t tessark-gateway:ci .
bash scripts/test-image.sh tessark-gateway:ci
```

The image test requires Docker, creates its own PostgreSQL container/network with test credentials, and removes them afterward. It does not read `.env.local`. The PostgreSQL integration script uses the configured development database and removes only its temporary schema.

Real Harbor conformance and installation into a live Kubernetes cluster are separate integration exercises; this workflow does not claim to validate those environments or execute an end-to-end Buildah publication. See the Harbor, replication and runner guides.

### Troubleshooting

- **No publish job:** expected on pull requests, validation-only manual runs, or when a prerequisite failed.
- **Package push denied:** verify `packages: write`, repository policy and Actions access on any pre-existing package.
- **Image download denied:** check package visibility or authenticate with package-read credentials.
- **Dependency audit failure:** inspect the advisory and update the affected dependency before releasing.
- **Image smoke failure:** inspect migration/seed output and the automatically printed container logs.
- **Expired image artifact on a rerun:** rerun all jobs to rebuild and test a new artifact.

## Français

L’image d’exécution contient la sortie standalone de Next.js et les dépendances nécessaires
aux hooks Prisma/tsx, assemblées par `scripts/prepare-runtime.mjs` à partir des versions
installées avec le lockfile. Les outils de build ne sont plus recopiés. Le serveur, les
migrations et le seed restent dans la même image. `test-image.sh` vérifie cette composition
et leur fonctionnement.


### Pipeline

[Le workflow](../../.github/workflows/ci.yml) s’exécute sur les pull requests, les pushes vers `main`, les tags de version commençant par `v` et les lancements manuels **Run workflow**.

| Job | Vérifications |
| --- | --- |
| Code et configuration | Cohérence versions/changelog/tag, génération Prisma, ESLint, TypeScript, traductions, exemple d’environnement, surface/matrice Harbor, audit des dépendances de production (sévérité haute/critique) |
| Tests, Node 22 et 24 | Tests applicatifs, véritables connexions TLS locales, tests Python du runner |
| PostgreSQL | Service PostgreSQL 17, toutes les migrations dans un schéma temporaire, verrous entre connexions et nettoyage durable |
| Helm | Lint, rendu embedded/CNPG/external, configuration/identifiants CNPG, attente des migrations, configuration des builds et refus des activations invalides |
| Image | Build Docker Linux AMD64, migrations, seed idempotent, conservation du mot de passe, readiness, page de connexion, protection API et Swagger |
| Publication | Téléchargement de l’image testée, vérification de son identifiant, puis push vers GHCR |
| Release | Après publication réussie d’un tag de version, création de la GitHub Release avec notes du changelog, archive du chart, digests de l’image applicative et sommes de contrôle |

Le job image attend toutes les vérifications. Le job de publication ne récupère pas le code source, ne reconstruit pas l’image et n’exécute pas l’application ; il publie l’artefact qui a passé les tests. Lui seul reçoit `packages: write`. Les actions sont figées par SHA de commit. Les pull requests utilisent `pull_request`, jamais `pull_request_target`, et ne publient rien.

L’image est construite sans secrets applicatifs. Les caches Docker et npm accélèrent les exécutions suivantes. L’archive de l’image testée est conservée un jour ; les assets de release sept jours. Les logs et références publiées sont disponibles dans l’exécution Actions. Un lancement manuel valide uniquement, sauf si `publish_release=true` est explicitement demandé sur un tag de version.

Utiliser **Actions → Prepare release** pour ouvrir une PR de versions/changelog, puis **Publish release** sur `main` après fusion et réussite de la CI. La publication vérifie le commit exact de `main` et lance ce pipeline sur son tag de version. Les deux workflows utilisent `GITHUB_TOKEN` ; voir leur [configuration et utilisation](../releases.md). La commande de préparation locale reste disponible.

### Package et tags

Le package applicatif est **`ghcr.io/klementxv/tessark-gateway`**. Son nom est dérivé du dépôt et passé en minuscules ; un fork publie donc sous son propre nom de dépôt.

| Déclencheur | Tags publiés |
| --- | --- |
| Push vers `main` | `main`, `sha-<commit-complet>` |
| Tag `v1.2.3` | `1.2.3`, `latest`, `sha-<commit-complet>` |
| Tag `v1.2.3-rc.1` | `1.2.3-rc.1`, `sha-<commit-complet>` ; ne modifie pas `latest` |
| Lancement manuel sur un tag avec `publish_release=true` | Mêmes tags que pour le push de ce tag de version |
| Pull request ou autre lancement manuel | Aucun |

Avant publication, la CI vérifie que le tag Git correspond à `package.json`, au lockfile, à l’`appVersion` du chart et à une entrée datée dans [CHANGELOG.md](../../CHANGELOG.md). Le chart possède sa propre version indépendante. Préparer ces fichiers via **Prepare release**, ou localement avec `npm run release:prepare -- VERSION --chart VERSION_CHART` ; voir le [guide des releases](../releases.md).

`latest` suit la dernière version stable publiée, pas les pushes de développement. Pour un déploiement immuable, utiliser `image.digest` dans Helm : il prend priorité sur `image.tag`. Le runner exige séparément un digest.

```bash
docker pull ghcr.io/klementxv/tessark-gateway:main

# Après préparation, revue et commit des fichiers de release, puis réussite de la CI :
npm run version:check -- --tag v1.2.3
git tag v1.2.3
git push origin v1.2.3
```

Choisir une version jamais publiée. Le workflow construit uniquement l’image applicative ; le runner Buildah distinct reste documenté dans [son guide](../../deploy/build-runner/README.md#français).

### Configuration GitHub

GitHub Actions doit être activé et la politique du dépôt doit autoriser les actions figées et l’écriture de packages. La publication utilise le **`GITHUB_TOKEN`** intégré ; ce workflow ne nécessite ni compte Docker Hub ni token personnel. Les labels OCI de source associent l’image au dépôt. Le mécanisme suit [la documentation de publication GitHub](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).

Un nouveau package conteneur est privé par défaut, même pour un dépôt public. Pour autoriser les téléchargements anonymes, modifier sa visibilité dans ses paramètres si c’est le comportement souhaité. Sinon, s’authentifier avant de télécharger. Si le package existe déjà, accorder à ce dépôt l’accès Actions au package. Voir [la documentation du Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Pour Helm, définir :

```yaml
image:
  repository: ghcr.io/klementxv/tessark-gateway
  tag: sha-REPLACE_WITH_FULL_COMMIT
```

Utiliser le tag de commit publié ; `main` est un tag mobile et la politique de téléchargement `IfNotPresent` du chart peut conserver une ancienne image en cache. Pour un package privé, configurer une entrée `imagePullSecrets` adaptée dans le namespace cible.

### Reproduire les vérifications en local

Après les [prérequis locaux](../../README.md#français) :

```bash
npm ci
npm run prisma:generate
npm run version:check
npm run lint
npx tsc --noEmit
npm test
npm run check:messages
npm run check:env-example
npm run check:harbor-surface
npm run check:harbor-matrix
npm audit --omit=dev --audit-level=high
python3 scripts/test-build-runner.py
bash scripts/check-chart.sh
node --env-file=.env.local scripts/test-replication-postgres.mjs
docker build -t tessark-gateway:ci .
bash scripts/test-image.sh tessark-gateway:ci
```

Le test de l’image nécessite Docker, crée son propre conteneur/réseau PostgreSQL avec des identifiants de test, puis les supprime. Il ne lit pas `.env.local`. Le script d’intégration PostgreSQL utilise la base de développement configurée et ne supprime que son schéma temporaire.

La conformance Harbor réelle et l’installation sur un cluster Kubernetes réel sont des exercices d’intégration séparés ; ce workflow ne prétend pas valider ces environnements ni exécuter une publication Buildah de bout en bout. Consulter les guides Harbor, réplication et runner.

### Dépannage

- **Pas de job de publication :** normal sur une pull request, un lancement manuel de validation, ou si un prérequis a échoué.
- **Push du package refusé :** vérifier `packages: write`, la politique du dépôt et l’accès Actions à un package préexistant.
- **Téléchargement refusé :** vérifier la visibilité du package ou s’authentifier avec des droits de lecture.
- **Échec de l’audit :** examiner l’avis de sécurité et mettre à jour la dépendance concernée avant publication.
- **Échec du test d’image :** consulter la sortie migration/seed et les logs de conteneurs imprimés automatiquement.
- **Artefact expiré lors d’une relance :** relancer tous les jobs pour reconstruire et tester une nouvelle archive.
