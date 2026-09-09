# Tessark Gateway

Portail Next.js qui pilote un ou plusieurs Harbor : clusters de registries, projets, robots,
rétention, réplication, et transfert d'images entre registres via des Jobs Kubernetes `skopeo`.

Voir [le guide de déploiement Kubernetes/Helm](deploy/helm/tessark-gateway/README.md)
et [le guide du runner de builds](deploy/build-runner/README.md). L'API externe
(tokens + Swagger), le serveur MCP et les transferts entre Harbor sont documentés ci-dessous.

## Transferts d'images

Une demande de transfert déplace une image d'une **source** vers une ou plusieurs
**destinations**, chacune exécutée par son propre Job `skopeo` — indépendantes, jamais une
chaîne de sauts.

- **Sources** : une source amont approuvée (`/registries/policy`), ou un projet d'un Harbor
  que le Gateway connaît. Dans le second cas le digest est figé au moment de la demande, et
  c'est lui qui voyage : un tag peut bouger entre l'approbation et le lancement.
- **Destinations** : un projet géré par le Gateway, ou un projet d'un registre en rôle
  **livraison**. Un projet peut changer de cluster (`Changer de cluster`, ADMIN) : tout le
  suit sauf les images, donc il doit être vide — c'est un déplacement, pas une copie.
- **Rôle d'un registre** (`/registries`) : `MANAGED` — le Gateway y possède projets, robots,
  rétention et réplication ; `DELIVERY` — il y lit la liste des projets et y pousse des images,
  rien d'autre, avec les identifiants stockés sur le registre. Un registre de livraison ne peut
  pas être membre d'un cluster.
- **Règles** (`/registries/policy`, SUPERADMIN) : sans règle activée correspondant à la
  direction, un transfert est **refusé**, même entre deux Harbor que le pod atteint. Une règle
  porte aussi `requiresApproval` et, éventuellement, des surcharges `skopeo` propres à cette
  direction (image, ressources, deadline, placement, drapeaux d'une liste blanche).

## Développement local

Prérequis : Node 22+, Docker (pour Postgres).

```bash
npm install

# Base de données — Postgres 16 en conteneur, volume nommé persistant entre redémarrages
docker compose -f docker-compose.dev.yml up -d

cp .env.example .env.local
# éditer .env.local : au minimum GATEWAY_SECRET_KEY (openssl rand -base64 32) et
# GATEWAY_ADMIN_USERNAME/PASSWORD pour le premier superadmin. DATABASE_URL pointe déjà vers
# le Postgres du docker-compose ci-dessus par défaut.

npx prisma migrate dev   # crée le schéma
npx prisma db seed       # bootstrap du premier SUPERADMIN (idempotent)

npm run dev
```

Vérifications locales : `npm run lint`, `npx tsc --noEmit`, `npm test`,
`npm run check:messages` et `npm run check:env-example`.
Les tests utilisent des réponses HTTP simulées et la configuration factice de
`tests/env.fixture` ; ils ne nécessitent ni PostgreSQL, ni Harbor, ni Kubernetes.

Réinitialiser complètement la base locale :

```bash
docker compose -f docker-compose.dev.yml down -v   # supprime aussi le volume
docker compose -f docker-compose.dev.yml up -d
npx prisma migrate dev
npx prisma db seed
```

### Pourquoi Postgres et pas SQLite

Le provider Prisma est figé sur `postgresql` (`prisma/schema.prisma`) — Prisma n'accepte pas
de provider dynamique par variable d'environnement. Le chart Helm propose trois modes
de base PostgreSQL : `embedded`, `cnpg`, `external`.

### `connection_limit`

Le pod applicatif tourne en un seul process Node ; avec plusieurs réplicas plus les Jobs de
migration/seed, chaque connexion Prisma compte contre `max_connections` côté Postgres. En
local, `?connection_limit=5` dans `DATABASE_URL` (déjà dans `.env.example`) suffit largement.
En production, dimensionner en fonction de `replicaCount` — voir le chart Helm.

## Déploiement Kubernetes

Chart Helm : [`deploy/helm/tessark-gateway/`](deploy/helm/tessark-gateway/) (détail des
valeurs dans son propre [README](deploy/helm/tessark-gateway/README.md)).

### Prérequis

- Un cluster Kubernetes ≥ 1.27 (testé contre k3s v1.34).
- **Aucun registry d'images n'existe encore pour ce projet** : l'image se
  construit et s'importe localement dans les nœuds du cluster, elle ne se pull pas depuis un
  registry distant. Voir `scripts/build-and-import.sh` et le `Dockerfile` à la racine.
- Le compte qui installe le chart a besoin des droits pour créer des Role/RoleBinding dans le
  namespace cible (`rbac.create: true`, par défaut) — sans quoi le mirroring d'images ne
  fonctionnera jamais (le chart le rappelle dans ses notes post-install).
- Mode `database.mode: cnpg` uniquement : l'opérateur [CloudNativePG](https://cloudnative-pg.io/)
  doit déjà être installé dans le cluster — ce n'est pas une dépendance du chart, `helm
  template`/`install` échoue avec un message explicite s'il est absent.

### Construire et importer l'image

```bash
./scripts/build-and-import.sh          # tag auto (0.1.0-<sha court>)
# ou : ./scripts/build-and-import.sh 0.2.0-rc1
```

Sur un cluster multi-nœuds, répéter l'import sur chaque nœud (le script ne gère que le nœud
local) ou contraindre le Deployment à un seul nœud via `nodeSelector` tant qu'aucun registry
n'existe.

### Install minimal

```bash
helm install tessark-gateway deploy/helm/tessark-gateway \
  --namespace tessark-gateway --create-namespace \
  --set image.tag=<tag importé ci-dessus> \
  --set auth.adminUsername=admin \
  --set auth.adminPassword=<mot de passe du premier superadmin> \
  --set auth.url=https://gateway.example.com   # ou ingress.enabled=true + ingress.hosts[0].host=...
```

Aucune autre valeur n'est obligatoire : le mode base de données par défaut (`embedded`)
déploie son propre Postgres, `AUTH_SECRET`/`GATEWAY_SECRET_KEY` sont générés automatiquement et
préservés à chaque upgrade (`lookup` + `helm.sh/resource-policy: keep`).

### ⚠️ `GATEWAY_SECRET_KEY`

Cette clé chiffre tous les credentials de registry/robot stockés en base. **Sa perte ou sa
rotation les rend définitivement illisibles.** Le chart ne la régénère jamais tant que son
Secret existe. Sauvegarder cette clé **avec** la base, pas séparément — une sauvegarde de
l'une sans l'autre ne sert à rien à la restauration. Récupérer la valeur actuelle :

```bash
kubectl -n tessark-gateway get secret tessark-gateway \
  -o jsonpath='{.data.GATEWAY_SECRET_KEY}' | base64 -d
```

### Upgrade

```bash
helm upgrade tessark-gateway deploy/helm/tessark-gateway \
  --namespace tessark-gateway \
  --reuse-values \
  --set image.tag=<nouveau tag>
```

Le Job de migration (`job-migrate`, hook `pre-upgrade`) tourne avant que le nouveau Deployment
ne soit appliqué — voir la note dans `templates/job-migrate.yaml` sur pourquoi ce n'est pas un
hook `pre-install` malgré ce que suggère une première lecture du plan.

### Suppression

`helm uninstall` **conserve délibérément** (`helm.sh/resource-policy: keep`) : le
Secret applicatif, le Secret et le PVC du Postgres embarqué. Un réinstall dans le même
namespace retrouve donc les utilisateurs et les credentials existants — ce n'est pas un bug,
c'est voulu, mais ça surprend si on ne s'y attend pas. Les notes post-install (`helm install
--dry-run` ou `kubectl -n <ns> describe secret`) rappellent la commande exacte pour supprimer
volontairement ces objets.

### Runbook ops

**Un transfert reste bloqué (statut `RUNNING` qui ne bouge plus).**
L'UI ne rafraîchit le statut que via un polling déclenché par l'onglet Transferts ouvert
(`POST /api/transfers/[id]/sync`) — un mirroring dont personne ne regarde l'onglet peut sembler
bloqué alors qu'il a juste fini sans que personne ne l'ait su. Vérifier d'abord le Job lui-même :

```bash
kubectl -n <ns> get jobs -l tessark.io/transfer-target-id=<targetId>
kubectl -n <ns> describe job transfer-<targetId>
kubectl -n <ns> logs job/transfer-<targetId>
```

S'il tourne depuis plus longtemps que `config.skopeo.jobActiveDeadlineSeconds` (1800s par
défaut) sans que Kubernetes ne l'ait tué, quelque chose d'anormal se passe côté API server —
sinon, `activeDeadlineSeconds` le termine tout seul et la cible finit `FAILED` avec la raison au
prochain sync.

**Retrouver les Jobs/Secrets orphelins.**
Tout objet créé par une mirror (Job skopeo et son Secret de credentials) porte les labels posés
par `buildSkopeoJobLabels()` (`src/lib/transfers/job-spec.ts`) :

```bash
kubectl -n <ns> get jobs,secrets -l app.kubernetes.io/managed-by=tessark-gateway
kubectl -n <ns> delete jobs,secrets -l tessark.io/transfer-request-id=<id>   # une requête entière
kubectl -n <ns> delete jobs,secrets -l tessark.io/transfer-target-id=<id>   # une seule cible
```

`ttlSecondsAfterFinished` (`config.skopeo.jobTtlSeconds`, 3600s par défaut) nettoie les Jobs
terminés tout seul ; ce qui reste après ce délai a probablement échoué à se terminer proprement.

**Mot de passe admin perdu.**
`GATEWAY_ADMIN_USERNAME`/`PASSWORD` ne sont lus qu'une fois, au tout premier `helm install` (par
`prisma/seed.ts`) — les changer dans les values n'a plus aucun effet ensuite. Réinitialiser un
mot de passe directement en base, avec le même hachage que `src/lib/crypto.ts#hashPassword`
(scrypt, format `salt_b64:hash_b64`), depuis un pod jetable utilisant la même image :

```bash
kubectl -n <ns> run reset-password --rm -it --restart=Never \
  --image=tessark-gateway:<tag actuellement déployé> \
  --env="DATABASE_URL=$(kubectl -n <ns> get secret tessark-gateway -o jsonpath='{.data.DATABASE_URL}' | base64 -d)" \
  -- node -e '
    const crypto = require("node:crypto");
    const { PrismaClient } = require("/app/src/generated/prisma/client");
    const [, , username, password] = process.argv;
    const salt = crypto.randomBytes(16);
    const hash = salt.toString("base64") + ":" + crypto.scryptSync(password, salt, 64).toString("base64");
    new PrismaClient().user.update({ where: { username }, data: { passwordHash: hash } })
      .then(() => console.log("done")).catch((e) => { console.error(e); process.exit(1); });
  ' admin 'nouveau-mot-de-passe'
```

En mode `database.mode: cnpg` ou `external` avec `existingSecret` : `DATABASE_URL` n'est **pas**
dans le Secret applicatif (composée à la volée dans chaque pod spec, voir
`tessark-gateway.databaseEnv` dans `_helpers.tpl`) — l'assembler à la main à partir du Secret
concerné (`<fullname>-app` pour CNPG, ou celui pointé par `database.external.existingSecret`).

**Sauvegarder Postgres et `GATEWAY_SECRET_KEY` ensemble.**
Une sauvegarde de l'un sans l'autre est inexploitable à la restauration : la base contient des
credentials de registry chiffrés avec cette clé précise, et une base restaurée avec la mauvaise
clé (ou sans elle) ne redonne accès à rien. Sauvegarder dans la même opération, ou au minimum
documenter l'association base ↔ clé :

```bash
kubectl -n <ns> get secret tessark-gateway -o jsonpath='{.data.GATEWAY_SECRET_KEY}' | base64 -d > gateway-secret-key.txt
# + dump Postgres selon le mode (pg_dump depuis le pod embedded-postgres-0, snapshot du
# volume CNPG, ou la procédure de sauvegarde de la base externe)
```

## Authentification unique (SSO / OIDC)

**Désactivé par défaut** (`OIDC_ENABLED=false`) : sans configuration, l'authentification est
exactement celle d'avant — identifiant/mot de passe en base.

Le Gateway parle **OIDC générique** : tout est découvert depuis
`<issuer>/.well-known/openid-configuration`. Keycloak est la cible de référence (et sait
lui-même servir de courtier vers LDAP/AD, SAML, Google…), mais Entra ID, Authentik, Okta ou
Dex fonctionnent avec la même configuration.

### Mise en place pas à pas (Okta, PingFederate, Entra ID…)

Le Gateway **ne parle jamais LDAP** : c'est l'IdP qui fédère l'annuaire (agent AD/LDAP côté
Okta, datastore LDAP côté PingFederate) et n'expose au Gateway qu'un jeton OIDC. Basculer de
Keycloak à Okta, côté Gateway, c'est changer trois variables.

#### 1. Créer l'application côté fournisseur

L'URL de redirection à déclarer est **exactement** celle-ci, sans variante ni slash final :

```
<AUTH_URL>/api/auth/callback/oidc
```

C'est la cause n°1 d'échec au premier essai ; `helm install` la réaffiche dans ses notes
post-install pour éviter de la recopier de travers.

- **Okta** — *Applications → Applications → Create App Integration* → **OIDC - OpenID
  Connect** → **Web Application**. Renseigner les *Sign-in redirect URIs* avec l'URL
  ci-dessus, et les *Sign-out redirect URIs* avec `<AUTH_URL>/login` si vous comptez utiliser
  `OIDC_LOGOUT_MODE=idp`. Assigner les utilisateurs ou groupes autorisés. Le **Client ID** et
  le **Client secret** sont dans l'onglet *General*, section *Client Credentials*.
- **PingFederate** — un client OAuth avec la même URL de redirection, `code` comme grant type,
  et l'URL post-logout si nécessaire.
- **Keycloak** — un client `openid-connect` confidentiel, *Valid redirect URIs* identique.

#### 2. Faire sortir les groupes dans un claim

**C'est l'étape qu'on oublie**, et elle ne produit aucune erreur : sans elle la connexion
réussit et tout le monde se retrouve simplement avec `OIDC_DEFAULT_ROLE`.

Chez Okta, l'emplacement **dépend du serveur d'autorisation** :

- *org authorization server* (`issuer = https://<org>.okta.com`) → onglet **Sign On** de
  l'application, *Edit* sur **OpenID Connect ID Token**, *Group claim type* = **Filter**, nom
  du claim `groups`, filtre `Matches regex` avec `.*`. Puis *More → Refresh Application Data*.
- *serveur personnalisé* (`issuer = https://<org>.okta.com/oauth2/<id>`) → *Security → API →*
  votre serveur *→ Claims → Add Claim*, *Value type* = **Groups**, inclus dans l'**ID Token**.

Chez PingFederate, l'attribut passe par le **contrat d'attributs** du client, mappé dans la
*OpenID Connect Policy* qui le sert — en **multi-valué**, voir les pièges plus bas. Chez
Keycloak, un *group membership mapper* écrivant dans le claim `groups`.

#### 3. Configurer le Gateway

```bash
OIDC_ENABLED=true
OIDC_ISSUER=https://<org>.okta.com          # ou .../oauth2/<id>, ou https://pf.example.com
OIDC_CLIENT_ID=0oa...
OIDC_CLIENT_SECRET=...
OIDC_SCOPES="openid profile email groups"   # `groups` est nécessaire chez Okta
OIDC_DISPLAY_NAME="Okta"
OIDC_ROLE_CLAIM=groups
```

En Helm, le même bloc sous `oidc.*` : le `clientSecret` est rendu dans le Secret du chart,
jamais dans le ConfigMap.

#### 4. Basculer, dans cet ordre

1. **Première mise en service sans mapping de rôles.** Laisser `OIDC_ROLE_MAPPING` vide : tout
   le monde arrive en `USER` et les rôles restent pilotés depuis `/settings/users`. On valide
   que la connexion marche avant d'empiler une couche de plus.
2. **Puis le mapping** : `OIDC_ROLE_MAPPING='{"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}'`.
   Dès qu'il est non vide, l'IdP devient propriétaire du rôle.
3. **Comptes locaux à migrer** : activer `OIDC_LINK_BY_EMAIL=true` le temps que chacun se
   connecte une fois par l'IdP — son compte est alors adopté et son mot de passe supprimé —
   puis le remettre à `false`.
4. **Ne pas toucher à `OIDC_ALLOW_LOCAL_LOGIN`.** C'est la porte de secours : IdP injoignable,
   le SUPERADMIN bootstrappé entre toujours par le formulaire.

#### Différences entre fournisseurs, en un tableau

| | Okta | PingFederate |
|---|---|---|
| `OIDC_ISSUER` | `https://<org>.okta.com` (org authorization server) ou `https://<org>.okta.com/oauth2/<id>` (serveur personnalisé) | l'URL de base du serveur, ex. `https://pf.example.com` — la découverte est servie à la racine |
| Claim de groupes | Onglet *Sign On* de l'application (org auth server) ou *Security → API → Claims* (serveur personnalisé) — voir §2 | Contrat d'attributs + *OpenID Connect Policy* du client |
| `OIDC_SCOPES` | ajouter `groups` → `openid profile email groups` | selon le scope auquel la policy rattache l'attribut |
| `OIDC_ROLE_CLAIM` | le nom donné au claim (`groups` par convention) | idem |
| URL de redirection | *Sign-in redirect URIs* | *Redirect URIs* du client |
| `OIDC_LOGOUT_MODE=idp` | déclarer `<AUTH_URL>/login` dans les *Sign-out redirect URIs* | déclarer l'URL post-logout côté client |

#### Pièges

- **Sans claim de groupes, tout le monde arrive avec `OIDC_DEFAULT_ROLE`** — la connexion
  réussit, seuls les droits sont faux. Panne la plus fréquente, et silencieuse. Vérifiez le
  contenu réel de l'ID token avant de soupçonner le mapping : côté Okta, le *Token Preview*
  d'un serveur d'autorisation personnalisé le montre directement.
- Si le claim arrive en **chaîne séparée par des virgules** plutôt qu'en tableau (ce que
  certaines policies PingFederate produisent), le mapping ne matchera pas : `resolveRole`
  accepte une chaîne ou un tableau de chaînes, pas une liste à découper. Configurez l'attribut
  en multi-valué.
- Un **chemin pointé** est accepté pour `OIDC_ROLE_CLAIM` (`realm_access.roles` pour les rôles
  de realm Keycloak), et les deux formes de groupe Keycloak (`gateway-admins` et
  `/gateway-admins`) matchent indifféremment.

### Variables

La liste exhaustive, commentée, est dans [`.env.example`](.env.example) (bloc
« Single sign-on ») et dans le tableau des valeurs du
[README du chart](deploy/helm/tessark-gateway/README.md). Le minimum vital tient en cinq
lignes — voir l'étape 3 ci-dessus.

### Ce que ça change

- **Le login local reste actif** (`OIDC_ALLOW_LOCAL_LOGIN=true`). C'est volontaire : si l'IdP
  devient injoignable, le SUPERADMIN bootstrappé peut toujours entrer. Le désactiver est un
  choix de politique de sécurité, sans porte de secours.
- **Le fournisseur devient propriétaire du rôle** dès que `OIDC_ROLE_MAPPING` est non vide : il
  est réappliqué à chaque connexion, et `/settings/users` cesse de proposer de le modifier pour
  ces comptes. Le rôle le plus élevé l'emporte quand plusieurs groupes correspondent.
- **L'identité est liée au claim `sub`**, jamais à l'e-mail (`User.externalId` =
  `<issuer>|<sub>`). Un compte local préexistant portant la même adresse n'est **pas** adopté :
  la connexion est refusée avec un message explicite, sauf si `OIDC_LINK_BY_EMAIL=true` — à
  n'activer que le temps d'une migration, et qui exige alors `email_verified`.
- **Un compte fédéré ne peut plus se connecter par le formulaire local**, même s'il a conservé
  un ancien hash : ce serait un contournement de l'IdP.
- **Impossible de se verrouiller dehors** : ni le mapping de rôles, ni `/settings/users` ne
  peuvent retirer son rôle au dernier SUPERADMIN actif.

Déconnexion : par défaut (`OIDC_LOGOUT_MODE=local`) seule la session du Gateway est effacée —
celle de l'IdP survit, donc recliquer « se connecter » ne redemande rien. `idp` déconnecte
aussi de l'IdP, donc de **toutes** les applications qui en dépendent ; il faut alors déclarer
l'URL post-logout côté fournisseur. Ce mode fait aussi transiter l'ID token dans le cookie de
session, pour l'envoyer en `id_token_hint` — la spec ne le rend que *recommandé*, mais certains
fournisseurs (Okta) refusent la redirection post-logout sans lui. Coût mesuré : cookie de
session de ~585 o à ~2,1 Ko, sous le seuil de 4 Ko à partir duquel NextAuth le découpe.

### Annuaire propre à un cluster Harbor

L'authentification ci-dessus concerne la **Gateway**. Les Harbor, eux, ont leur propre
authentification, et **chaque cluster peut dépendre d'un annuaire différent** (LDAP/AD distinct,
base locale Harbor, autre courtier OIDC). Or une appartenance de projet est poussée sur Harbor
sous un **nom de compte** : il faut donc savoir lequel.

Chaque cluster porte pour cela un mode d'annuaire, réglable dans le formulaire du cluster
(page **Registres**) :

| Mode | Ce que ça veut dire |
|---|---|
| **Même annuaire que la Gateway** (défaut) | `User.username` est aussi le nom du compte sur ces Harbor. C'est le comportement historique, et il ne demande aucune configuration |
| **Son propre annuaire** | Chaque personne doit être **associée** à un compte de l'annuaire de ce cluster avant de pouvoir recevoir des droits |

En mode « son propre annuaire » :

- l'écran **Correspondance d'annuaire** (icône sur l'en-tête du cluster) liste les
  correspondances, et le compte se choisit **dans la liste renvoyée par Harbor**, jamais en
  saisie libre ;
- **il n'y a pas de repli** sur le nom d'utilisateur Gateway. Une personne non associée ne peut
  pas être ajoutée à un projet du cluster — c'est délibéré : un compte homonyme dans un autre
  annuaire est quelqu'un d'autre, et lui accorder des droits en silence est exactement ce que ce
  mode sert à empêcher ;
- **changer** une correspondance déplace les droits : l'ancien compte est retiré des projets du
  cluster avant que le nouveau y soit ajouté. La **supprimer** révoque ces droits ;
- écrire une correspondance est réservé aux **ADMIN** : elle vaut pour tout le cluster. Un
  responsable de projet qui n'est pas admin ajoute des personnes déjà associées ;
- basculer un cluster **déjà peuplé** vers ce mode est refusé tant que toutes les appartenances
  existantes ne sont pas associées, avec la liste des comptes concernés.

L'identité Gateway et l'identité Harbor restent deux espaces de noms distincts : ni le `sub` ni
le `preferred_username` d'un fournisseur OIDC n'en dérivent automatiquement un nom de compte
Harbor.

#### Donner l'accès à un groupe plutôt qu'à des personnes

L'onglet **Membres** d'un projet comporte une section **Groupes d'annuaire** : si les Harbor du
cluster connaissent des groupes (LDAP sur un Harbor en mode LDAP, OIDC sur un Harbor en mode
OIDC), un groupe peut recevoir un rôle sur le projet. C'est le raccourci quand une équipe
entière doit avoir accès : un octroi, aucune correspondance à saisir — le nom du groupe désigne
la même chose sur tous les Harbor du cluster.

En contrepartie, **la Gateway ne sait pas énumérer un groupe** : elle n'a aucun lien avec
l'annuaire. Un octroi par groupe donne donc l'accès *sur les Harbor* — `docker pull` / `push`
fonctionnent — sans faire de personne un membre côté Gateway : le projet n'apparaît pas dans
leur liste et ses membres ne figurent pas dans le tableau du dessus. L'encart de la section le
rappelle à l'écran.

Seuls les groupes que Harbor connaît déjà sont proposés. Harbor sait enregistrer un groupe LDAP
à la volée depuis un DN, mais un DN saisi dans un formulaire est invérifiable — même objection
qu'un nom d'utilisateur tapé de mémoire — donc la Gateway n'en crée jamais.

### Développer contre un Keycloak local

```bash
docker compose -f docker-compose.dev.yml --profile sso up -d   # Keycloak sur :8080
```

Le realm `tessark` est importé au démarrage ([`deploy/dev/keycloak-realm.json`](deploy/dev/keycloak-realm.json)) :
client `tessark-gateway` / secret `dev-client-secret`, groupes `gateway-admins` et
`gateway-owners`, et trois comptes — `alice`/`alice` (owner), `bob`/`bob` (admin),
`carol`/`carol` (sans groupe). Console d'administration sur <http://localhost:8080> avec
`admin`/`admin`. **Tout y est un jouet** : rien de ce fichier ne doit sortir d'un poste de dev.

Dans `.env.local` :

```bash
OIDC_ENABLED=true
OIDC_ISSUER=http://localhost:8080/realms/tessark
OIDC_CLIENT_ID=tessark-gateway
OIDC_CLIENT_SECRET=dev-client-secret
OIDC_ROLE_MAPPING={"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}
```

## API externe & MCP

Tout est **désactivé par défaut** —
`API_EXTERNAL_ENABLED=false` et `MCP_ENABLED=false` — un `helm install` sans surcharge n'expose
rien de plus que l'UI web avec sa session cookie.

### Activer l'API externe

```bash
# En local (.env.local) ou via le chart :
API_EXTERNAL_ENABLED=true

# Chart Helm :
helm upgrade tessark-gateway deploy/helm/tessark-gateway --reuse-values \
  --set apiExternal.enabled=true
```

Ce flag seul ne donne accès à rien : il faut ensuite qu'un compte crée un token depuis
**Settings → API Tokens** (`/settings/tokens`) — le secret n'est affiché **qu'une fois**, à la
création. Un token hérite du `Role` de son propriétaire (`USER`/`ADMIN`/`SUPERADMIN`) — il ne
peut jamais faire plus que ce que ce compte peut déjà faire depuis l'UI.

```bash
curl -H "Authorization: Bearer tsk_live_..." https://gateway.example.com/api/projects
```

Limite de débit par défaut : 60 req/min par token (par IP avant résolution du token) —
`API_RATE_LIMIT_PER_MINUTE` / `apiExternal.rateLimitPerMinute`. Compteur en mémoire, non
partagé entre réplicas.

### Documentation interactive (Swagger)

`GET /api/docs` (Swagger UI) et `GET /api/openapi.json` (le document OpenAPI 3.1 brut) sont
**toujours accessibles**, même avec `API_EXTERNAL_ENABLED=false` : ils décrivent l'API, ils ne
renvoient aucune donnée d'instance. Générés dynamiquement à chaque requête depuis les routes
réellement exposées — jamais un snapshot qui peut dériver du code.

### Serveur MCP

`POST /api/mcp` sert un serveur MCP (transport Streamable HTTP) à tout client qui présente un
token Bearer valide ; le cookie de session ne permet pas cet accès. Nécessite
`MCP_ENABLED=true` **et** `API_EXTERNAL_ENABLED=true` (le second sans le premier laisse
`/api/mcp` répondre 401 à tout appelant).

```bash
MCP_ENABLED=true
MCP_WRITE_TOOLS_ENABLED=false   # true pour exposer aussi create_transfer,
                                 # approve_transfer, create_project
```

Configuration pour un client MCP en Streamable HTTP :

```json
{
  "mcpServers": {
    "tessark-gateway": {
      "url": "https://gateway.example.com/api/mcp",
      "headers": { "Authorization": "Bearer tsk_live_..." }
    }
  }
}
```

Tools en lecture seule, toujours présents quand le serveur est actif : `list_projects`,
`get_project`, `list_registries` (ADMIN+), `list_clusters`, `list_transfers`, `get_transfer_status`,
`search_images`. Tools d'écriture, uniquement si `MCP_WRITE_TOOLS_ENABLED=true` :
`create_transfer`, `approve_transfer` (ADMIN+), `create_project` — chacun avec la même
garde de `Role` que la route REST équivalente, pas de logique dupliquée. `create_robot_account`
en est délibérément absent : il renvoie un secret Harbor en clair (visible une seule fois), ce
qui exposerait ce secret au client MCP.

Chaque appel de tool est loggé (`{ tokenId, tool, ok, id ou error }`, jamais les arguments
bruts) — même niveau d'audit qu'une action faite depuis l'UI.

La reprise autonome du maillage Harbor, ses réglages et ses limites sont décrits dans [Réplication et rattrapage](docs/replication/README.md).


### Scheduled builds · Beta

La fonctionnalité construit des images depuis un Dockerfile saisi ou un dépôt Git HTTPS
public, à la demande ou selon un cron UTC, puis les publie dans un projet actif. Elle est
réservée aux administrateurs et désactivée par défaut. Le runner Buildah et un robot limité
au projet sont nécessaires ; la destination doit être en HTTPS vérifié.

Voir le [runner](deploy/build-runner/README.md) et la
[configuration Helm](deploy/helm/tessark-gateway/README.md#scheduled-builds-beta).

La [matrice de compatibilité Harbor](docs/harbor/README.md) détaille les fonctionnalités
prises en charge et les résultats de validation par version.
