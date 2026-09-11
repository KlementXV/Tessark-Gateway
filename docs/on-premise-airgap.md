# Installation on-premise et air-gap

Le chart autonome se trouve dans `deploy/helm/tessark-gateway`. Le [guide du chart](../deploy/helm/tessark-gateway/README.md) décrit les secrets, les migrations, le stockage et les trois modes PostgreSQL. Le [fichier on-premise](../deploy/helm/examples/values-onprem.yaml) fournit un point de départ sans identifiants. Adapter ses noms d’hôtes et tags avant utilisation.

Avant une livraison ou une mise à niveau, lire le [changelog](../CHANGELOG.md) et le [guide des releases](releases.md). La version du chart détermine le nom du `.tgz` ; son `appVersion` désigne la version applicative par défaut. Constituer chaque lot à partir d’un commit tagué et de digests d’images validés.

## Registre, chemins et secrets des images

| Composant | Référence configurable | Secrets propres au composant |
| --- | --- | --- |
| Gateway, init containers, migrations, seed, test Helm | `image.registry`, `image.repository`, `image.tag` ou `image.digest` | `imagePullSecrets: [{name: registry-pull}]` |
| PostgreSQL embarqué | `database.embedded.image` (référence complète, tag ou digest) | `database.embedded.imagePullSecrets: [registry-pull]` |
| PostgreSQL CNPG | `database.cnpg.imageName` (image compatible CNPG) | `database.cnpg.imagePullSecrets: [registry-pull]` |
| Skopeo, transferts et miroirs | `skopeo.image` (référence complète) | `skopeo.imagePullSecrets: [registry-pull]` |
| Dex embarqué (`oidc.enabled` + `identity.mode: embedded`) | `identity.dex.image` (référence complète) | `identity.dex.imagePullSecrets: [registry-pull]` |
| Runner des builds | `builds.runnerImage` (digest obligatoire si activé) | `builds.imagePullSecrets: [{name: registry-pull}]` |

`image.digest` prend priorité sur `image.tag`. Sans digest ni tag, le tag Gateway est `Chart.appVersion`. Les autres champs acceptent directement `registry/path/name:tag` ou `registry/path/name@sha256:…`.

Pour un miroir commun, `global.imageRegistry` remplace le registre de toutes ces références. `global.imageRepositoryPrefix` ajoute un chemin sous ce registre ; il exige `global.imageRegistry`. Le chemin du dépôt, le tag et le digest sont conservés. Exemple : `quay.io/skopeo/stable:validated` devient `registry.internal:5000/platform/skopeo/stable:validated`. Une référence courte `postgres:17-alpine` devient `registry.internal:5000/platform/postgres:17-alpine` : aucun préfixe `library/` n’est ajouté implicitement. Le registre global prend priorité sur le registre du composant. Pour des destinations réparties sur plusieurs registres, laisser le registre global vide et définir chaque référence complète.

`global.imagePullSecrets: [registry-pull]` ajoute des noms de Secrets existants à chaque composant. Les secrets locaux s’y ajoutent, sans doublons. Le chart ne crée pas ces identifiants. Les créer dans le namespace de la release **avant** l’installation et également dans `config.k8sNamespace` / `builds.namespace` lorsqu’ils sont distincts. Les identifiants de téléchargement des exécutables sont indépendants des identifiants source/destination stockés dans Gateway pour copier les artefacts. Une surcharge d’image Skopeo enregistrée dans une règle de transfert prend priorité sur le défaut Helm : adapter aussi ces surcharges au registre interne. Les jobs et CronJobs déjà créés conservent leur spec ; vérifier ou recréer les miroirs concernés après un changement d’image ou de secrets.

```sh
kubectl create namespace tessark
# /secure/config.json est un fichier Docker auth géré par votre organisation.
kubectl -n tessark create secret generic registry-pull \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/secure/config.json
helm upgrade --install gateway ./deploy/helm/tessark-gateway \
  --namespace tessark -f ./deploy/helm/examples/values-onprem.yaml \
  --wait --timeout 15m
helm test gateway --namespace tessark
```

L’exemple utilise `existingSecret: gateway-runtime` : provisionner ce Secret et `gateway-tls` selon le guide du chart avant de lancer la commande. Le stockage doit être disponible via une StorageClass par défaut ou `database.embedded.storageClassName`.

Avec CNPG, installer l’opérateur et ses CRDs séparément, configurer ses propres images/secrets, puis fixer explicitement `database.cnpg.imageName` à une image miroir compatible. Une valeur vide laisse le choix à l’opérateur ; le registre global ne peut pas réécrire une image choisie par celui-ci. Le chart ne configure pas non plus les images des contrôleurs Ingress, CSI, CNI ou autres opérateurs du cluster.

Les runtimes des nœuds doivent faire confiance à l’autorité du registre interne pour télécharger les images. La CA d’entreprise configurée dans Gateway concerne ses appels aux registres et ses jobs de copie ; elle ne configure pas la confiance du runtime Kubernetes. Conserver les clés `AUTH_SECRET` et `GATEWAY_SECRET_KEY` ainsi que la base lors des mises à niveau.

## Exposition réseau : Ingress, NodePort ou ClusterIP

Les trois modes se configurent dans les valeurs Helm. L’Ingress est une ressource distincte du Service : avec un contrôleur Ingress, conserver normalement `service.type: ClusterIP`.

| Mode | Configuration | Accès |
| --- | --- | --- |
| Ingress | `ingress.enabled: true`, `service.type: ClusterIP` | Nom DNS, HTTP ou HTTPS terminé par le contrôleur |
| NodePort | `ingress.enabled: false`, `service.type: NodePort`, `service.nodePort: 30080` | Adresse d’un nœud joignable et port choisi |
| ClusterIP | `ingress.enabled: false`, `service.type: ClusterIP` | Réseau interne, proxy existant ou port-forward |

L’[exemple on-premise](../deploy/helm/examples/values-onprem.yaml) active l’Ingress avec TLS. Définir `ingress.ingressClassName` selon le contrôleur installé ; `ingress.annotations`, `ingress.hosts[].paths` et `ingress.tls` sont configurables. Le chart n’installe pas le contrôleur et ne génère pas les certificats. Utiliser `/` pour publier Gateway : un chemin Ingress ne configure pas un sous-chemin applicatif Next.js.

Pour NodePort, appliquer la [surcharge NodePort](../deploy/helm/examples/values-nodeport.yaml) après les valeurs on-premise et adapter `auth.url` :

```sh
helm upgrade --install gateway ./deploy/helm/tessark-gateway -n tessark \
  -f deploy/helm/examples/values-onprem.yaml \
  -f deploy/helm/examples/values-nodeport.yaml --wait --timeout 15m
```

`service.nodePort: 0` laisse Kubernetes attribuer le port. Un port explicite doit appartenir à la plage configurée sur le cluster (habituellement 30000–32767) et être disponible. Le chart accepte les plages personnalisées ; Kubernetes valide l’allocation. Ouvrir le port dans les règles réseau de l’installation. `service.externalTrafficPolicy` accepte `Cluster` ou `Local` pour NodePort/LoadBalancer ; avec `Local`, seuls les nœuds ayant un endpoint local prêt peuvent servir ce trafic. Voir les [services Kubernetes](https://kubernetes.io/docs/concepts/services-networking/service/).

Pour ClusterIP seul, appliquer la [surcharge ClusterIP](../deploy/helm/examples/values-clusterip.yaml). Son `auth.url: http://localhost:8080` correspond à un accès de diagnostic par port-forward :

```sh
kubectl -n tessark port-forward svc/gateway-tessark-gateway 8080:80
```

Pour un accès permanent via un proxy ou un nom DNS interne, remplacer `auth.url` par l’URL réellement ouverte dans le navigateur. Sans Ingress, le chart ne peut pas la déduire. Avec Ingress, elle est déduite du premier hôte et de sa configuration TLS si elle n’est pas explicitement fournie.

`service.port` configure le port du Service (80 par défaut). `service.targetPort` configure aussi le listener `PORT` de Gateway et le port nommé utilisé par les sondes (3000 par défaut, port non privilégié à partir de 1024). `service.annotations` ajoute des annotations au Service. `service.clusterIP` permet de demander une IP fixe du réseau des Services à l’installation ; laisser vide pour l’allocation automatique. Kubernetes ne permet généralement pas de changer cette IP sur un Service existant.

Le mode `LoadBalancer` reste disponible, avec les mêmes réglages de port et d’annotations ; il nécessite un contrôleur de load balancing dans le cluster. Les fichiers de surcharge d’exposition ne contiennent ni images ni secrets et doivent être combinés avec les valeurs de l’installation.

## Préparer une installation sans accès Internet

Sur une machine connectée, constituer un lot contenant :

- Le chart empaqueté et le fichier de valeurs final, sans secrets.
- Les images Gateway, Skopeo, PostgreSQL du mode choisi et, si activés, le runner des builds et Dex (SSO embarqué).
- Les charts/images des composants d’infrastructure installés séparément.
- Les charts applicatifs, leurs dépendances non embarquées et toutes leurs images de workloads.

Choisir des versions validées et immuables ; éviter le tag Skopeo `latest` du défaut de développement. Vérifier toutes les architectures des nœuds. Les builds isolés nécessitent aussi les images `FROM`, les dépôts Git et les dépendances des Dockerfiles accessibles à l’intérieur du réseau.

```sh
mkdir -p bundle
helm package deploy/helm/tessark-gateway --destination bundle
helm template gateway deploy/helm/tessark-gateway \
  -f deploy/helm/examples/values-onprem.yaml > bundle/rendered.yaml
```

Inspecter les champs `image`, `imageName`, `SKOPEO_IMAGE` et `BUILDS_RUNNER_IMAGE` du rendu : les jobs créés dynamiquement apparaissent comme valeurs de ConfigMap, pas comme Pods dans ce fichier. Pour CNPG, ajouter `--api-versions postgresql.cnpg.io/v1/Cluster` au rendu hors cluster. Le manifeste rendu contient des Secrets : le protéger et ne pas l’inclure dans un lot distribué sans les en retirer.

Exporter chaque image de l’inventaire vers une archive OCI. Les variables ci-dessous désignent vos références réelles, incluant leurs tags ou digests validés :

```sh
skopeo copy --all "docker://${GATEWAY_SOURCE}" oci-archive:bundle/gateway.tar
skopeo copy --all "docker://${SKOPEO_SOURCE}" oci-archive:bundle/skopeo.tar
skopeo copy --all "docker://${POSTGRES_SOURCE}" oci-archive:bundle/postgres.tar
# Ajouter le runner et les autres composants activés.
(cd bundle && sha256sum *.tar *.tgz > SHA256SUMS)
```

Transporter le lot selon la procédure de l’organisation. Dans la zone isolée, avec Skopeo et Helm déjà disponibles, vérifier le lot puis remplir le registre interne. Skopeo utilise les credentials de son authfile ; ne pas les ajouter au lot.

```sh
(cd bundle && sha256sum -c SHA256SUMS)
skopeo copy --all oci-archive:bundle/gateway.tar \
  docker://registry.internal:5000/platform/tessark/gateway:release-2026-09
skopeo copy --all oci-archive:bundle/skopeo.tar \
  docker://registry.internal:5000/platform/skopeo/stable:validated
skopeo copy --all oci-archive:bundle/postgres.tar \
  docker://registry.internal:5000/platform/library/postgres:17-alpine
helm upgrade --install gateway ./bundle/tessark-gateway-0.2.0.tgz \
  --namespace tessark -f values-onprem.yaml --wait --timeout 15m
helm test gateway --namespace tessark
```

Adapter la version du `.tgz` au lot livré. Si les images sont référencées par digest dans les valeurs, préserver les digests à l’import et vérifier leur correspondance avant installation. Le registre interne doit déjà fonctionner avant le déploiement. Désactiver ou remplacer les sources Internet, webhooks et fournisseurs OIDC injoignables. Les règles de transfert ne créent pas de connectivité réseau : un job doit pouvoir atteindre les deux registres. Un passage par support amovible reste une opération hors Gateway ; aucun transport diode automatique n’est ajouté ici.

## Transférer des charts Helm OCI

Le dialogue de transfert accepte des images et charts dans une même liste :

```text
library/nginx:1.27
oci://harbor-dmz.internal/charts/mychart:1.2.3
oci://harbor-dmz.internal/charts/mychart:1.2.3+Build.7
```

Pour inclure les tags pointant vers le même digest que le chart demandé, activer **Inclure les autres tags de l’artefact** (500 tags maximum par lot). La version demandée reste obligatoire ; les autres versions du dépôt sont exclues. Voir le [contrat REST/MCP](api/README.md#transférer-tous-les-tags-de-lartefact-demandé).

Déclarer d’abord le registre ou la source amont dans Gateway, puis autoriser la direction par une règle de transfert. Chaque ligne conserve son approbation, ses cibles, son statut et ses possibilités de retry. Une référence `oci://` exige une version explicite, même avec cette option ; les métadonnées `+Build.7` deviennent `_Build.7` dans le tag OCI, sans changement de casse. L’API REST et MCP existantes prennent `repo` et `tag` séparément : envoyer le tag OCI (`1.2.3_Build.7`) dans `tag`, sans préfixe `oci://` dans `repo`.

La copie Skopeo transporte le manifeste, la configuration Helm, l’archive et sa couche de provenance lorsqu’elle existe. Une source Harbor est figée au digest à la création de la demande ; une source amont générique conserve la limite actuelle des tags non figés. La copie ne vérifie pas une signature Helm : le consommateur doit effectuer sa vérification habituelle. Les referrers OCI externes ne sont pas parcourus récursivement.

Conserver le nom du chart comme dernier segment du dépôt cible : `charts/mychart`, pas `charts/renamed`. Les tags Helm correspondent aux versions du chart. Après transfert :

```sh
helm registry login harbor-interne.example
helm pull oci://harbor-interne.example/charts/mychart --version 1.2.3
```

Les dépôts HTTP classiques (`index.yaml`) et l’upload direct de `.tgz` ne sont pas des sources Gateway. Pour les utiliser, préparer le chart et ses dépendances sur une machine autorisée, puis le publier dans une source OCI approuvée :

```sh
helm pull mon-depot/mychart --version 1.2.3
helm push mychart-1.2.3.tgz oci://harbor-dmz.internal/charts
```

Le transfert du chart ne réécrit pas ses valeurs et ne copie pas automatiquement les images qu’il référence. Préparer ces images et adapter leurs registres/secrets séparément pour l’air-gap. Voir les conventions de [Helm OCI](https://docs.helm.sh/docs/v3/topics/registries/) et les options de [Skopeo copy](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md).

Validation locale du transport (Helm et Skopeo requis, aucun registre externe) :

```sh
node --env-file=tests/env.fixture --import tsx scripts/test-helm-transfer.ts
```

Ce test exécute la commande de production contre un registre OCI de test local, compare les octets copiés puis relit l’archive avec Helm. Une recette sur les Harbor et le cluster Kubernetes de destination reste nécessaire pour valider leurs credentials, certificats et règles réseau.
