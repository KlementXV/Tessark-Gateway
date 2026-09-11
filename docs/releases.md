# Versions et releases

Le [changelog](../CHANGELOG.md) décrit les changements et les actions nécessaires à la mise à niveau.
Le parcours principal passe par GitHub Actions : **Prepare release → PR et CI → fusion →
Publish release → CI sur le tag → image GHCR et GitHub Release**. Le script local reste le
moteur commun des validations et de la préparation.

## Quelle version désigne quoi ?

| Élément | Référence | Règle |
| --- | --- | --- |
| Application | `package.json.version` | Source de la version affichée dans les paramètres et annoncée par le serveur MCP |
| Dépendances | `package-lock.json` | Versions exactes installées ; les deux versions du package racine suivent l’application |
| Code source | Commit Git complet | Identifie exactement le code construit ; une version applicative seule ne distingue pas deux builds de développement |
| Release et image | Tag Git `vX.Y.Z`, image `X.Y.Z` | Le tag doit correspondre à la version applicative et à une entrée datée du changelog |
| Chart Helm | `Chart.yaml.version` | Version indépendante du paquet de déploiement ; augmente quand son contenu change |
| Application par défaut du chart | `Chart.yaml.appVersion` | Identique à `package.json.version` ; une surcharge `image.tag` ou `image.digest` peut déployer une autre image |
| Contrat REST | Version OpenAPI | Version de compatibilité de l’API, indépendante des releases applicatives |

Les valeurs initiales de ce suivi sont application `0.1.0`, chart `0.2.0`. Elles ne sont pas
requalifiées rétroactivement en releases publiées. L’historique antérieur devra être établi à
partir des tags et artefacts réels avant d’ajouter des entrées anciennes au changelog.

## Politique de numérotation

Utiliser `MAJOR.MINOR.PATCH`, avec éventuellement un suffixe comme `-alpha.1`, `-beta.1` ou
`-rc.1`. Les métadonnées `+build` ne sont pas acceptées pour les releases : elles ne sont pas
utilisables telles quelles dans les tags Docker. Le SHA Git et le digest identifient le build.

- **Patch** : correction compatible ou maintenance sans changement de contrat.
- **Minor** : nouvelle fonctionnalité ; tant que l’application reste en `0.x`, réserver aussi ce changement aux ruptures, annoncées dans le changelog.
- **Major**, à partir de `1.0.0` : rupture de compatibilité ou nouvelle exigence d’exploitation nécessitant une migration.
- **Prérelease** : validation avant publication stable. Par exemple `0.2.0-rc.1` puis `0.2.0`. Elle ne déplace pas le tag d’image `latest`.

Ne jamais réutiliser ni déplacer un tag de release. Une correction après publication reçoit
une nouvelle version. `main` reste une image de développement mobile ; déployer un digest
validé pour une installation on-premise reproductible.

## Préparer une release applicative

1. Mettre à jour **Unreleased** dans `CHANGELOG.md` : changements visibles, correctifs, sécurité et actions de mise à niveau. Signaler les migrations, nouveaux composants/images et prérequis airgap. N’annoncer une validation réelle que si elle a été effectuée.
2. Choisir une version applicative et une version de chart supérieures aux versions courantes. Le chart augmente aussi parce que son `appVersion` change.
3. Dans **Actions → Prepare release → Run workflow**, sélectionner **main**, puis saisir `app_version` et `chart_version`, par exemple `0.2.0` et `0.3.0`.
4. Ouvrir la PR indiquée dans le résumé du workflow, relire son diff et ses notes de mise à niveau, attendre les contrôles requis, puis fusionner.

Le [workflow de préparation](../.github/workflows/prepare-release.yml) part du commit `main`
sélectionné lors du lancement. Il synchronise `package.json`, les deux champs racine du lockfile
et le chart, date les notes en UTC, puis crée une branche `release/vVERSION` et sa PR. Seuls ces
quatre fichiers sont inclus dans son commit. Il ne fusionne pas la PR et n’écrase pas une branche
de release existante.

La CI est demandée explicitement sur la branche de release. Les lancements manuels de validation
ne publient rien. Les contrôles de PR imposés par les protections du dépôt restent applicables.
Pour une release candidate puis stable, ajouter dans **Unreleased** la promotion du candidat
et les éventuelles corrections avant de relancer **Prepare release** avec les versions stables.

## Publier depuis GitHub

1. Après fusion, attendre la réussite complète de **Test, build and publish** sur `main`.
2. Dans **Actions → Publish release → Run workflow**, sélectionner **main** et saisir la version applicative fusionnée, par exemple `0.2.0`.
3. Suivre le nouveau **Test, build and publish** exécuté sur le tag `v0.2.0`. Le succès du workflow de déclenchement indique seulement que la demande de publication a été envoyée.

Le [workflow de publication](../.github/workflows/publish-release.yml) vérifie les versions et
les notes, exige une CI `push` réussie pour le **commit exact** de `main`, puis crée le tag sur
ce commit. Si le tag existe déjà après un échec partiel, il ne peut être réutilisé que s’il
désigne ce même commit. Un tag pointant ailleurs ou une GitHub Release déjà présente, même en
brouillon, provoque un refus.

Le tag déclenche explicitement la CI avec `publish_release=true`. Celle-ci n’accepte ce mode
que sur une référence `refs/tags/v…`, vérifie à nouveau les versions, reconstruit et teste
l’image, puis publie l’artefact testé sur GHCR. Après ce succès, elle crée la GitHub Release avec :

- Les notes extraites de l’entrée correspondante du changelog.
- Le chart Helm `.tgz` empaqueté dans le même run validé.
- `application-images.json`, contenant les références de l’image Gateway par digest.
- `SHA256SUMS`, couvrant le chart et ce fichier de références.

Les prereleases sont marquées comme telles et ne déplacent ni `latest` sur GHCR ni la release
GitHub indiquée comme la plus récente. Ces pièces jointes ne constituent pas un lot airgap
complet : les images Dex, PostgreSQL, Skopeo et les autres composants activés restent à inventorier.
Le chart est joint à la release, pas publié dans un registre Helm OCI.

## Configuration GitHub et reprises

Les workflows doivent d’abord être intégrés à `main`. Ils utilisent uniquement `GITHUB_TOKEN`,
sans PAT ni secret supplémentaire. Dans **Settings → Actions → General → Workflow permissions**,
autoriser **Allow GitHub Actions to create and approve pull requests** pour la création des PR.
Le workflow ne donne lui-même aucune approbation. Les politiques de l’organisation et les
règles de protection des branches et tags restent prioritaires. Voir les
[paramètres GitHub Actions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

Les événements produits avec `GITHUB_TOKEN` ne déclenchent pas tous automatiquement un autre
workflow ; les workflows de release utilisent donc `workflow_dispatch`, pris en charge pour
ce cas. Les workflows automatiques de PR peuvent demander une approbation distincte dans GitHub.
Voir le [comportement de GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token).

Si la préparation échoue après le push, reprendre la branche `release/vVERSION` existante.
Créer sa PR depuis l’interface GitHub si elle manque, puis lancer la CI sur cette branche.
Si le tag a été créé mais le dispatch a échoué, **Publish release** peut être relancé sur le
même commit. Si la publication de l’image a réussi mais la GitHub Release a échoué, examiner
le dernier job et les éventuels assets ou brouillons avant de reprendre ; ne pas déplacer le tag.

## Préparation locale et publication par tag

Les mêmes validations restent utilisables localement pour tester ou préparer un diff :

```bash
npm run release:prepare -- 0.2.0 --chart 0.3.0 --dry-run
npm run release:prepare -- 0.2.0 --chart 0.3.0
git diff -- package.json package-lock.json deploy/helm/tessark-gateway/Chart.yaml CHANGELOG.md
npm run version:check -- --tag v0.2.0
```

La commande locale ne crée aucun commit ni tag. Intégrer les fichiers relus et testés par PR,
puis utiliser **Publish release**. Le push manuel d’un tag reste compatible avec la CI : après
revue et validation du commit exact, vérifier que le worktree est propre et que le tag distant
n’existe pas avant de le créer.

```bash
git status --short
git ls-remote --tags origin refs/tags/v0.2.0
git tag -a v0.2.0 -m "Tessark Gateway 0.2.0"
git push origin v0.2.0
```

Une évolution du chart seul peut augmenter `Chart.yaml.version` tout en conservant `appVersion`.
La noter dans **Unreleased** et tester le chart. Les workflows ci-dessus préparent des releases
applicatives coordonnées ; une distribution du chart seul reste un empaquetage séparé.

## Livrer et mettre à niveau en on-premise / airgap

```bash
helm package deploy/helm/tessark-gateway --destination bundle
```

Constituer le lot selon le [guide airgap](on-premise-airgap.md), à partir du commit tagué et des
images réellement validées. Le nom du `.tgz` suit la version du **chart**, pas celle de l’app.
Inclure les composants activés, notamment Dex pour le SSO embarqué, ainsi que leurs prérequis.

Sauvegarder PostgreSQL et la `GATEWAY_SECRET_KEY` correspondante avant la mise à niveau. Lire
les notes de la version cible et de toutes les versions intermédiaires. Une ancienne image
ne peut pas nécessairement utiliser un schéma migré : un `helm rollback` n’annule pas les
migrations Prisma ; prévoir une restauration cohérente si le retour arrière l’exige.

Après déploiement, vérifier les hooks, la readiness, la connexion locale/SSO et les fonctions
utilisées sur le site. La version applicative figure dans **Paramètres** ; le digest de l’image,
le label OCI `org.opencontainers.image.revision` et le tag `sha-<commit>` permettent d’identifier
précisément le build. La version affichée seule ne constitue pas une preuve de publication.
