# Authentication and directories · Authentification et annuaires

**[English](#english) · [Français](#français)** · [Tessark Gateway](../../README.md)

## English

### Local accounts and roles

The first seed creates a local `SUPERADMIN` using `GATEWAY_ADMIN_USERNAME` and `GATEWAY_ADMIN_PASSWORD`, only while the user table is empty. Manage subsequent users under `/settings/users`.

| Role | Scope |
| --- | --- |
| `USER` | Access permitted by project membership and feature-specific authorization |
| `ADMIN` | Administrative operations, including registry management and transfer approval |
| `SUPERADMIN` | Highest application role, including global policy administration |

Application roles and Harbor project roles are separate. A user’s Gateway role does not automatically create an equivalent Harbor account. Session role refresh defaults to 300 seconds (`AUTH_SESSION_REFRESH_SECONDS`, Helm `auth.sessionRefreshSeconds`); `0` rereads the user on every request.

### Configure OpenID Connect

SSO is disabled by default. When LDAP and/or OIDC sign-in is enabled, Gateway connects to **Dex** using OIDC discovery and authorization code authentication with PKCE/state. Configure LDAP/AD, an upstream OIDC provider, or both as Dex connectors. `OIDC_ENABLED=true` enables this Gateway-to-Dex connection even when the only upstream source is LDAP. Without SSO, only local Gateway accounts are used.

1. Register Gateway as a static OIDC client in Dex. Register **exactly** `https://gateway.example.com/api/auth/callback/oidc`, using your actual public Gateway URL without a trailing slash after `oidc`.
2. Set the Dex issuer, Gateway client ID and client secret. Make Dex reachable at the same issuer URL from both Gateway and the browser.
3. Configure the LDAP and/or OIDC connectors in Dex. Request the `groups` scope and use the `groups` claim for group-based roles.
4. Keep a tested local administrator account available while validating SSO, then enable role mapping if required.

```dotenv
AUTH_URL=https://gateway.example.com
OIDC_ENABLED=true
OIDC_ISSUER=https://sso.example.com
OIDC_CLIENT_ID=tessark-gateway
OIDC_CLIENT_SECRET=replace-with-provider-secret
OIDC_SCOPES="openid profile email groups"
OIDC_DISPLAY_NAME="Company SSO"
OIDC_ROLE_CLAIM=groups
OIDC_ALLOW_LOCAL_LOGIN=true
```

For Helm, use `oidc.*` in [the chart values](../../deploy/helm/tessark-gateway/values.yaml). `oidc.clientSecret` is rendered into a Secret; if `existingSecret` is used, supply `OIDC_CLIENT_SECRET` there.

### Provisioning and role mapping

| Variable | Default | Behavior |
| --- | --- | --- |
| `OIDC_ALLOW_LOCAL_LOGIN` | `true` | Retains username/password login for local accounts |
| `OIDC_ALLOW_SIGNUP` | `true` | Allows creation of new federated accounts at sign-in |
| `OIDC_LINK_BY_EMAIL` | `false` | Allows linking a local account by verified email during migration |
| `OIDC_ROLE_CLAIM` | `groups` | Claim name or dotted path, `groups` for Dex |
| `OIDC_ROLE_MAPPING` | `{}` | Maps claim values to `USER`, `ADMIN` or `SUPERADMIN` |
| `OIDC_DEFAULT_ROLE` | `USER` | Role assigned when no configured group matches |
| `OIDC_LOGOUT_MODE` | `local` | Ends the Gateway session; `idp` also requests provider logout |

With an empty role mapping, existing roles remain managed in Gateway. A nonempty mapping is reapplied on each SSO sign-in: the highest matching role wins and the provider owns that user’s role.

```dotenv
OIDC_ROLE_MAPPING='{"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}'
```

The role claim accepts a string or an array of strings. A comma-separated string is one value, not a list of groups. Claim values match exactly: `gateway-admins` and `/gateway-admins` are different group names. Configure group membership in the provider’s token claims; a successful login alone does not prove groups were included.

Federated identity is stored as `<issuer>|<sub>`, not email. A matching local email is refused unless linking is explicitly enabled and the email is verified. Linking converts the local account to an OIDC account and removes its password; it can no longer sign in locally. Enable linking only for the intended migration period. Keep a separate local recovery account if local login remains enabled.

The application protects the last active `SUPERADMIN` from demotion through role mapping and user administration. This does not guarantee access if the provider is unavailable and local login has been disabled.

### Logout

`local` removes the Gateway session but leaves the provider session active. Signing in again may therefore require no prompt. `idp` requests provider logout, which can affect other applications using that provider session. Configure `<AUTH_URL>/login` as an allowed post-logout redirect at the provider. In this mode, Gateway retains the ID token in its session cookie to send `id_token_hint` during logout.

### Harbor directory identities

Each Harbor cluster has a directory mode under **Registries**:

| Mode | Project membership behavior |
| --- | --- |
| Same directory as Gateway | The Gateway username is used as the Harbor account name |
| Own directory | An administrator maps each Gateway user to a Harbor account returned by that cluster’s directory lookup |

In **own directory** mode, an unmapped user cannot receive project access; there is no fallback to a same-named account. Changing a mapping removes the old account’s project memberships before applying the new account. Deleting a mapping revokes those memberships. Switching a populated cluster to this mode is refused until all existing memberships have mappings.

Mappings are cluster-wide and require `ADMIN`. A project manager can grant membership to already-mapped users. Neither OIDC `sub` nor `preferred_username` automatically determines a Harbor identity in this mode.

### Searching the directory

Account and group pickers search through one of the cluster’s Harbors. Gateway contains no LDAP client: it uses the directory configured **on Harbor**, so it can never offer an account that Harbor would refuse. Each result states its source:

| Harbor configuration | What a search reaches |
| --- | --- |
| LDAP settings present (any `auth_mode`) | The directory itself, including people who never signed in to Harbor. The lookup matches the **exact** identifier (Harbor’s `ldap_uid` attribute); a partial entry only lists accounts Harbor already knows |
| No LDAP settings | Only accounts that have already signed in to Harbor |
| Credentials that are not a Harbor administrator | Only accounts Harbor already knows — its configuration cannot be read |

Whether a directory account can be granted access before signing in depends on Harbor’s `auth_mode`, measured on Harbor 2.15:

| Harbor `auth_mode` | Granting an account that never signed in to Harbor |
| --- | --- |
| `ldap_auth` | Works: Harbor creates the account when it is granted. Gateway also imports it if Harbor did not |
| `oidc_auth` | Refused: Harbor only creates the account at the person’s first sign-in to Harbor. The error says so |
| `db_auth` | Refused until the local account is created on Harbor |

The cluster page shows which of these applies, under **Directory**.

### Directory groups

The project **Members** tab can grant a project role to a directory group. Groups Harbor has already registered are listed; when the Harbor has LDAP settings, typing a group’s **exact** name also finds a group Harbor has never registered. On an `ldap_auth` Harbor, that group is registered from the DN returned by the directory when it is granted. Gateway does not enumerate a group’s members and never creates a group from a manually entered DN.

A group grant gives access **on Harbor** (for example, image pull/push), but does not add its members to the Gateway project list or membership table. Add Gateway memberships separately when access to the portal’s project view is required.

### Upstream OIDC through Dex

For an existing OIDC provider, configure Dex's `oidc` connector, including the upstream issuer, client credentials and a callback at `<Dex issuer>/callback`. These credentials belong to Dex; they are separate from the Gateway client registered in Dex. This route also applies when no LDAP connector is configured.

When roles depend on upstream groups, configure the connector's scopes, claim mapping and `insecureEnableGroups` explicitly. Dex documents limits on group freshness; requesting `groups` from Gateway alone does not enable upstream group forwarding. Validate group removal on a new sign-in, upstream MFA and logout across the chain. See [Dex's OIDC connector](https://dexidp.io/docs/connectors/oidc/).

Moving existing direct OIDC accounts to Dex changes their `<issuer>|<sub>` identity: plan explicit account migration before switching issuers. The generic OIDC client does not identify the provider's software; using Dex is the deployment contract.

### LDAP/AD authentication through Dex

Use [the Dex LDAP example](../../deploy/dev/dex-ldap.example.yaml) with an independently deployed Dex instance. Adapt the issuer, callback URL, LDAP host, base DNs and attributes, and mount the directory CA at the configured path. Inject `GATEWAY_CLIENT_SECRET` and `LDAP_BIND_PW` into Dex; set the same client secret as `OIDC_CLIENT_SECRET` in Gateway. Never put directory passwords in Gateway configuration.

Request `openid profile email groups` and map the exact group names emitted by Dex. Set `preferredUsernameAttr` to Harbor's `ldap_uid` attribute; if Gateway username normalization or a name collision changes the resulting username, use an explicit cluster identity mapping.

The issuer must resolve to the same public URL from both the browser and Gateway. Keep `OIDC_ALLOW_LOCAL_LOGIN=true` and a separate local `SUPERADMIN` for recovery. Do not configure Dex static passwords. Gateway implements no SAML authentication.

This example is for a Dex you run yourself (`identity.mode: external`); it uses Kubernetes storage, which requires Dex's CRDs and RBAC. To have the chart deploy Dex, see the next section. Harbor's own LDAP configuration remains separate from Dex.

See the [official Dex LDAP configuration](https://dexidp.io/docs/connectors/ldap/).

### Deploying Dex with the chart

With `oidc.enabled: true`, `identity.mode` decides where Dex comes from:

| `identity.mode` | What the chart does |
| --- | --- |
| `embedded` (default) | Deploys Dex (Deployment, Service, ConfigMap, Secret, RBAC for its Kubernetes storage) and registers the Gateway in it, redirect URI included. `oidc.issuer`, `oidc.clientId` and `oidc.clientSecret` are derived and must stay empty |
| `external` | Deploys nothing. `oidc.issuer` points at a Dex you run yourself — never directly at an upstream provider |

Without `oidc.enabled`, no identity component is deployed at all. A complete example is in [`values-ldap.yaml`](../../deploy/helm/examples/values-ldap.yaml).

- **Issuer.** Defaults to `<auth.url>/dex`, routed by the Gateway’s own Ingress: one hostname, one certificate. It must resolve to the same Dex from browsers **and** from the Gateway pods — Dex has no separate internal URL. `identity.dex.issuer` on another host gets an Ingress of its own (`identity.dex.ingressTls`).
- **Connectors.** `identity.dex.connectors` takes Dex connector blocks of type `ldap` and/or `oidc`. `saml` is refused at render time. Reference secrets as `$VARIABLE` and supply them through `identity.dex.env` (rendered into Dex’s Secret) or `identity.dex.existingSecret`; directory CAs through `identity.dex.caConfigMap`, mounted at `/etc/dex/ca`.
- **Client secret.** Generated at install and preserved at upgrade in Dex’s Secret; the Gateway reads that same key, so it exists in exactly one place.
- **Air-gap.** `identity.dex.image` is rewritten by `global.imageRegistry` / `global.imageRepositoryPrefix`, and `global.imagePullSecrets` apply, like every other component.
- **Refused at render time:** no connector, a `saml` connector, Dex static passwords, `oidc.roleMapping` on the `groups` claim without the `groups` scope, and an embedded Dex without `auth.url` or an Ingress host.

The chart’s Dex writes its state into `dex.coreos.com` resources in the release namespace and creates those CRDs at startup, which requires a cluster-scoped grant (`identity.dex.createCrdRbac`, on by default). Set it to `false` if the CRDs are installed out of band.

### Choosing a setup

Gateway speaks OIDC to Dex, and to nothing else. Every client situation is a Dex configuration, not Gateway code:

| Situation | Dex connectors | Harbor `auth_mode` | Directory search from Gateway |
| --- | --- | --- | --- |
| Bare LDAP/AD | `ldap` | `ldap_auth` against the directory | Complete |
| Existing OIDC provider | `oidc` | `oidc_auth` — a separate Harbor configuration | Complete if Harbor also has LDAP settings; otherwise accounts known to Harbor only |
| AD **and** an OIDC provider in front of it | `oidc` towards the provider | `ldap_auth` against the AD | Complete |
| Several sources | several connectors under one issuer | per cluster | According to each Harbor’s settings |

Measured on Harbor 2.15: a Harbor’s directory search works with LDAP settings whatever its `auth_mode`. But an `oidc_auth` Harbor cannot create an account before that person’s first sign-in to Harbor, so a grant to someone who never signed in is refused there.

**Trade-off of the third row.** Harbor on `ldap_auth` behind an OIDC provider means that signing in to the Harbor web UI **bypasses the provider and its MFA**. It is cheap when Harbor serves only `docker pull` with robot accounts; when people use the Harbor UI daily, it will be raised in a security review.

Three wiring pitfalls:

- **Groups scope.** Dex puts no `groups` claim in the token unless the `groups` scope is requested (measured on Dex 2.44). The Gateway refuses to start — and the chart to render — when `OIDC_ROLE_MAPPING` is set on the `groups` claim without it, instead of silently giving everyone `OIDC_DEFAULT_ROLE`.
- **Issuer.** Same URL from browsers and pods (see above).
- **Usernames.** The Gateway username comes from `preferred_username`, which Dex fills from `preferredUsernameAttr`. Set it to the attribute Harbor’s `ldap_uid` uses; otherwise switch the cluster to **own directory** and map accounts. Changing a Dex connector `id` changes every `sub`, like changing the issuer.

For Entra ID and other providers, use Dex’s `oidc` connector and check how it fills `preferred_username`; use a cluster identity mapping when it does not match the Harbor account. Moving existing direct-OIDC accounts to Dex changes their `<issuer>|<sub>`: plan an explicit migration rather than enabling email linking permanently.

**SAML** does not exist in Gateway and is not planned. Dex’s SAML connector is refused (its own documentation calls it unmaintained and likely vulnerable to authentication bypass). A SAML-only client provides an OIDC issuer in front of its provider, connected to Dex’s `oidc` connector.

**Revocation.** Disabling an account or changing its role in Gateway takes effect within `AUTH_SESSION_REFRESH_SECONDS`. Disabling someone only at the provider does not end a Gateway session already open; they are refused at their next sign-in.

**Recovery.** Keep `OIDC_ALLOW_LOCAL_LOGIN=true` and a local `SUPERADMIN` distinct from any SSO account. No static password is configured in Dex.

### Cluster directory diagnostics

The cluster page (**Registries → cluster → Directory**, `ADMIN`) reads every member Harbor’s sign-in mode and LDAP settings and compares them. It reports, by name: a different `auth_mode`, base DN, filter, identifier attribute or group settings between members; certificate verification off; LDAP over `ldap://`; a member with LDAP settings whose directory does not answer; a member without LDAP settings while others have them. An unreachable member is shown as such, never as consistent. The bind password cannot be compared: Harbor never returns it. This panel writes nothing.

### Writing Harbor’s LDAP configuration (opt-in)

A `SUPERADMIN` can store a cluster’s LDAP settings and write them to its Harbors (**Directory → Configure directory**, or `PUT`/`POST /api/clusters/{id}/directory-config[/apply]`). Off by default: while writing is not enabled for the cluster, nothing is ever written. Leave it off when Harbor is managed by other tooling.

- Each Harbor first tests the settings itself (`POST /ldap/ping`, bind password included); a Harbor whose test fails is not written.
- The last settings written to each Harbor are fingerprinted, password included: applying unchanged settings makes no call. **Rewrite even where nothing changed** repairs a Harbor edited by hand.
- **Switch blank Harbors to LDAP sign-in** only applies to a Harbor holding no account besides `admin`, which is when Harbor allows it.
- Never queued or replayed: a replay would overwrite a correction made by hand.
- The bind password is stored encrypted with `GATEWAY_SECRET_KEY`, never returned by the API and never logged. It is a directory service account: its compromise reaches beyond this application.

A wrong base DN or filter on an `ldap_auth` Harbor locks out all of its human users. Harbor’s local `admin` account still signs in whatever the mode.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Redirect rejected | Exact callback URI, public `AUTH_URL`, proxy host/protocol |
| Login succeeds with the wrong role | Actual group claim, dotted path, array format and role mapping |
| Existing email refused | Local account collision; linking requires explicit activation and verified email |
| Unknown user refused | `OIDC_ALLOW_SIGNUP`, provider assignment and account status |
| Local login fails for a migrated account | Federated accounts cannot use local passwords |
| Harbor access missing after SSO | Cluster directory mapping and Harbor project membership are separate from Gateway login |
| Gateway refuses to start: `OIDC_SCOPES: must include "groups"` | Add `groups` to the scopes; without it Dex emits no groups claim |
| Directory search lists only people who signed in to Harbor | The cluster page says why: no LDAP settings on that Harbor, or stored credentials that are not a Harbor administrator |
| Granting a directory account fails with "only learns an account at that person's first sign-in" | The Harbor uses `oidc_auth`: the person must sign in to Harbor once |

See [`.env.example`](../../.env.example) for all OIDC settings and [the implementation](../../src/lib/auth/oidc.ts) for account-linking and role-resolution rules.

## Français

### Comptes locaux et rôles

Le premier seed crée un `SUPERADMIN` local avec `GATEWAY_ADMIN_USERNAME` et `GATEWAY_ADMIN_PASSWORD`, uniquement si la table des utilisateurs est vide. Gérer ensuite les comptes dans `/settings/users`.

| Rôle | Périmètre |
| --- | --- |
| `USER` | Accès autorisés par les appartenances aux projets et les règles propres à chaque fonctionnalité |
| `ADMIN` | Opérations administratives, dont la gestion des registres et l’approbation des transferts |
| `SUPERADMIN` | Rôle applicatif le plus élevé, incluant l’administration des règles globales |

Les rôles applicatifs et les rôles de projet Harbor sont distincts. Le rôle Gateway d’une personne ne crée pas automatiquement un compte Harbor équivalent. Le rafraîchissement du rôle en session vaut 300 secondes par défaut (`AUTH_SESSION_REFRESH_SECONDS`, Helm `auth.sessionRefreshSeconds`) ; `0` relit l’utilisateur à chaque requête.

### Configurer OpenID Connect

Le SSO est désactivé par défaut. Dès que la connexion LDAP et/ou OIDC est activée, Gateway se raccorde à **Dex** par découverte OIDC et authentification par code avec PKCE/state. Configurer LDAP/AD, un IdP OIDC amont ou les deux comme connecteurs Dex. `OIDC_ENABLED=true` active cette connexion Gateway–Dex même si la seule source amont est LDAP. Sans SSO, seuls les comptes locaux Gateway sont utilisés.

1. Déclarer Gateway comme client OIDC statique dans Dex. Enregistrer **exactement** `https://gateway.example.com/api/auth/callback/oidc`, avec l’URL publique réelle du Gateway, sans slash final après `oidc`.
2. Définir l’issuer Dex, l’identifiant client Gateway et son secret. Dex doit être accessible sous la même URL d’issuer depuis Gateway et le navigateur.
3. Configurer les connecteurs LDAP et/ou OIDC dans Dex. Demander le scope `groups` et utiliser le claim `groups` pour attribuer les rôles par groupe.
4. Conserver un compte administrateur local testé pendant la validation du SSO, puis activer l’attribution des rôles si nécessaire.

```dotenv
AUTH_URL=https://gateway.example.com
OIDC_ENABLED=true
OIDC_ISSUER=https://sso.example.com
OIDC_CLIENT_ID=tessark-gateway
OIDC_CLIENT_SECRET=remplacer-par-le-secret-du-fournisseur
OIDC_SCOPES="openid profile email groups"
OIDC_DISPLAY_NAME="SSO entreprise"
OIDC_ROLE_CLAIM=groups
OIDC_ALLOW_LOCAL_LOGIN=true
```

Avec Helm, utiliser `oidc.*` dans [les valeurs du chart](../../deploy/helm/tessark-gateway/values.yaml). `oidc.clientSecret` est placé dans un Secret ; avec `existingSecret`, y fournir `OIDC_CLIENT_SECRET`.

### Création de comptes et attribution des rôles

| Variable | Défaut | Comportement |
| --- | --- | --- |
| `OIDC_ALLOW_LOCAL_LOGIN` | `true` | Conserve la connexion par mot de passe des comptes locaux |
| `OIDC_ALLOW_SIGNUP` | `true` | Autorise la création de comptes fédérés à la connexion |
| `OIDC_LINK_BY_EMAIL` | `false` | Autorise le rattachement par email vérifié pendant une migration |
| `OIDC_ROLE_CLAIM` | `groups` | Nom du claim ou chemin pointé, `groups` pour Dex |
| `OIDC_ROLE_MAPPING` | `{}` | Associe les valeurs du claim à `USER`, `ADMIN` ou `SUPERADMIN` |
| `OIDC_DEFAULT_ROLE` | `USER` | Rôle appliqué si aucun groupe configuré ne correspond |
| `OIDC_LOGOUT_MODE` | `local` | Termine la session Gateway ; `idp` demande aussi la déconnexion du fournisseur |

Sans correspondance de rôles, les rôles existants restent gérés dans Gateway. Une correspondance non vide est réappliquée à chaque connexion SSO : le rôle correspondant le plus élevé l’emporte et le fournisseur devient responsable du rôle de cet utilisateur.

```dotenv
OIDC_ROLE_MAPPING='{"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}'
```

Le claim accepte une chaîne ou un tableau de chaînes. Une chaîne séparée par des virgules est une seule valeur, pas une liste de groupes. Les valeurs correspondent exactement : `gateway-admins` et `/gateway-admins` sont des noms de groupes distincts. Configurer les appartenances dans les claims du token chez le fournisseur ; une connexion réussie ne prouve pas que les groupes sont présents.

L’identité fédérée est enregistrée sous `<issuer>|<sub>`, pas sous l’email. Une adresse locale déjà présente entraîne un refus sauf si le rattachement est explicitement activé et l’email vérifié. Le rattachement convertit le compte local en compte OIDC et supprime son mot de passe ; il ne peut plus se connecter localement. N’activer le rattachement que pendant la migration prévue. Conserver un compte local de secours distinct si la connexion locale reste autorisée.

L’application protège le dernier `SUPERADMIN` actif contre la rétrogradation par les correspondances de rôles et l’administration des utilisateurs. Cela ne garantit pas l’accès si le fournisseur est indisponible et la connexion locale désactivée.

### Déconnexion

`local` supprime la session Gateway mais conserve celle du fournisseur. Une nouvelle connexion peut donc ne demander aucune saisie. `idp` demande la déconnexion du fournisseur, ce qui peut affecter d’autres applications utilisant cette session. Déclarer `<AUTH_URL>/login` comme URL de retour autorisée après déconnexion chez le fournisseur. Dans ce mode, Gateway conserve l’ID token dans son cookie de session pour transmettre `id_token_hint` à la déconnexion.

### Identités des annuaires Harbor

Chaque cluster Harbor possède un mode d’annuaire dans **Registres** :

| Mode | Comportement des appartenances aux projets |
| --- | --- |
| Même annuaire que Gateway | Le nom d’utilisateur Gateway est utilisé comme nom de compte Harbor |
| Son propre annuaire | Un administrateur associe chaque utilisateur Gateway à un compte renvoyé par la recherche d’annuaire du cluster |

En mode **son propre annuaire**, une personne non associée ne peut pas recevoir d’accès à un projet ; aucun repli sur un compte homonyme n’a lieu. Modifier une correspondance retire les appartenances de l’ancien compte avant d’appliquer celles du nouveau. Supprimer une correspondance révoque ces appartenances. Le basculement d’un cluster peuplé vers ce mode est refusé tant que toutes les appartenances existantes n’ont pas de correspondance.

Les correspondances concernent tout le cluster et exigent `ADMIN`. Un responsable de projet peut ajouter les personnes déjà associées. Ni `sub` ni `preferred_username` OIDC ne détermine automatiquement l’identité Harbor dans ce mode.

### Rechercher dans l’annuaire

Les sélecteurs de comptes et de groupes interrogent l’un des Harbor du cluster. Gateway ne contient aucun client LDAP : il utilise l’annuaire configuré **sur Harbor**, et ne peut donc jamais proposer un compte que Harbor refuserait. Chaque résultat indique sa provenance :

| Configuration de Harbor | Ce qu’atteint la recherche |
| --- | --- |
| Réglages LDAP présents (quel que soit `auth_mode`) | L’annuaire lui-même, y compris les personnes jamais connectées à Harbor. La recherche porte sur l’identifiant **exact** (attribut `ldap_uid` de Harbor) ; une saisie partielle ne liste que les comptes déjà connus de Harbor |
| Aucun réglage LDAP | Seulement les comptes déjà connectés à Harbor |
| Identifiants non administrateurs de Harbor | Seulement les comptes déjà connus de Harbor : sa configuration ne peut pas être lue |

Pouvoir accorder un accès à un compte de l’annuaire avant sa première connexion dépend du `auth_mode` de Harbor, mesuré sur Harbor 2.15 :

| `auth_mode` de Harbor | Accorder un accès à un compte jamais connecté à Harbor |
| --- | --- |
| `ldap_auth` | Fonctionne : Harbor crée le compte à l’octroi. Gateway l’importe aussi si Harbor ne l’a pas fait |
| `oidc_auth` | Refusé : Harbor ne crée le compte qu’à la première connexion de la personne à Harbor. Le message d’erreur le dit |
| `db_auth` | Refusé tant que le compte local n’existe pas sur Harbor |

La page du cluster indique, sous **Annuaire**, lequel de ces cas s’applique.

### Groupes d’annuaire

L’onglet **Membres** d’un projet permet d’accorder un rôle de projet à un groupe d’annuaire. Les groupes déjà enregistrés sur Harbor sont listés ; si Harbor a des réglages LDAP, saisir le nom **exact** d’un groupe trouve aussi un groupe que Harbor n’a jamais enregistré. Sur un Harbor `ldap_auth`, ce groupe est enregistré à l’octroi depuis le DN renvoyé par l’annuaire. Gateway n’énumère pas les membres d’un groupe et ne crée jamais de groupe depuis un DN saisi manuellement.

Un octroi par groupe donne l’accès **sur Harbor** (par exemple pour pull/push), sans ajouter ses membres à la liste des projets ou au tableau des appartenances Gateway. Ajouter séparément des appartenances Gateway si ces personnes doivent consulter le projet dans le portail.

### IdP OIDC amont via Dex

Pour un IdP OIDC existant, configurer le connecteur `oidc` de Dex : issuer amont, identifiants client et callback `<issuer Dex>/callback`. Ces identifiants appartiennent à Dex et sont distincts du client Gateway déclaré dans Dex. Ce chemin s’applique aussi sans connecteur LDAP.

Si les rôles dépendent des groupes amont, configurer explicitement les scopes, le mapping des claims et `insecureEnableGroups` du connecteur. Dex documente des limites de fraîcheur des groupes ; demander `groups` depuis Gateway ne suffit pas à activer leur transmission amont. Valider le retrait d’un groupe à la reconnexion, le MFA amont et la déconnexion sur toute la chaîne. Voir le [connecteur OIDC de Dex](https://dexidp.io/docs/connectors/oidc/).

Passer des comptes OIDC directs existants à Dex modifie leur identité `<issuer>|<sub>` : préparer une migration explicite avant de changer l’issuer. Le client OIDC générique ne reconnaît pas le logiciel du fournisseur ; utiliser Dex constitue le contrat de déploiement.

### Connexion LDAP/AD avec Dex

Utiliser [l’exemple Dex LDAP](../../deploy/dev/dex-ldap.example.yaml) avec une instance Dex déployée séparément. Adapter l’issuer, l’URL de callback, l’hôte LDAP, les bases DN et les attributs, puis monter la CA de l’annuaire au chemin configuré. Injecter `GATEWAY_CLIENT_SECRET` et `LDAP_BIND_PW` dans Dex ; fournir le même secret client à Gateway via `OIDC_CLIENT_SECRET`. Aucun mot de passe d’annuaire ne doit entrer dans la configuration Gateway.

Demander `openid profile email groups` et mapper les noms exacts émis par Dex. Aligner `preferredUsernameAttr` sur l’attribut `ldap_uid` de Harbor ; si la normalisation ou une collision modifie le nom d’utilisateur Gateway, utiliser une correspondance explicite d’identité par cluster.

L’issuer doit être accessible sous la même URL publique depuis le navigateur et Gateway. Conserver `OIDC_ALLOW_LOCAL_LOGIN=true` et un `SUPERADMIN` local distinct pour le secours. Ne pas configurer de mots de passe statiques dans Dex. Gateway ne réalise aucune authentification SAML.

Cet exemple vise un Dex exploité séparément (`identity.mode: external`) ; il utilise le stockage Kubernetes, qui exige les CRD et le RBAC de Dex. Pour que le chart déploie Dex, voir la section suivante. La configuration LDAP de Harbor reste distincte de Dex.

Voir la [configuration LDAP officielle de Dex](https://dexidp.io/docs/connectors/ldap/).

### Déployer Dex avec le chart

Avec `oidc.enabled: true`, `identity.mode` décide d’où vient Dex :

| `identity.mode` | Ce que fait le chart |
| --- | --- |
| `embedded` (défaut) | Déploie Dex (Deployment, Service, ConfigMap, Secret, RBAC de son stockage Kubernetes) et y déclare Gateway, URI de retour comprise. `oidc.issuer`, `oidc.clientId` et `oidc.clientSecret` sont dérivés et doivent rester vides |
| `external` | Ne déploie rien. `oidc.issuer` désigne un Dex exploité séparément — jamais directement un fournisseur amont |

Sans `oidc.enabled`, aucun composant d’identité n’est déployé. Un exemple complet se trouve dans [`values-ldap.yaml`](../../deploy/helm/examples/values-ldap.yaml).

- **Issuer.** Par défaut `<auth.url>/dex`, routé par l’Ingress de Gateway : un nom d’hôte, un certificat. Il doit désigner le même Dex depuis les navigateurs **et** depuis les pods Gateway — Dex n’a pas d’URL interne distincte. Un `identity.dex.issuer` sur un autre hôte reçoit son propre Ingress (`identity.dex.ingressTls`).
- **Connecteurs.** `identity.dex.connectors` reçoit des blocs de connecteurs Dex de type `ldap` et/ou `oidc`. `saml` est refusé au rendu. Référencer les secrets en `$VARIABLE` et les fournir par `identity.dex.env` (placé dans le Secret de Dex) ou `identity.dex.existingSecret` ; les CA d’annuaire par `identity.dex.caConfigMap`, monté dans `/etc/dex/ca`.
- **Secret client.** Généré à l’installation et conservé aux mises à niveau dans le Secret de Dex ; Gateway lit cette même clé, qui n’existe donc qu’à un seul endroit.
- **Air-gap.** `identity.dex.image` est réécrite par `global.imageRegistry` / `global.imageRepositoryPrefix`, et `global.imagePullSecrets` s’applique, comme pour les autres composants.
- **Refusés au rendu :** aucun connecteur, un connecteur `saml`, des mots de passe statiques Dex, `oidc.roleMapping` sur le claim `groups` sans le scope `groups`, et un Dex embarqué sans `auth.url` ni hôte d’Ingress.

Le Dex du chart enregistre son état dans des ressources `dex.coreos.com` du namespace de la release et crée ces CRD au démarrage, ce qui exige un droit à l’échelle du cluster (`identity.dex.createCrdRbac`, activé par défaut). Le passer à `false` si les CRD sont installées séparément.

### Choisir une architecture

Gateway parle OIDC à Dex, et à rien d’autre. Chaque situation client est une configuration de Dex, pas du code Gateway :

| Situation | Connecteurs Dex | `auth_mode` de Harbor | Recherche d’annuaire depuis Gateway |
| --- | --- | --- | --- |
| LDAP/AD nu | `ldap` | `ldap_auth` sur l’annuaire | Complète |
| IdP OIDC existant | `oidc` | `oidc_auth` — configuration Harbor distincte | Complète si Harbor a aussi des réglages LDAP ; sinon comptes déjà connus de Harbor |
| AD **et** IdP OIDC devant | `oidc` vers l’IdP | `ldap_auth` sur l’AD | Complète |
| Plusieurs sources | plusieurs connecteurs sous un même issuer | selon le cluster | Selon les réglages de chaque Harbor |

Mesuré sur Harbor 2.15 : la recherche d’annuaire d’un Harbor fonctionne dès qu’il a des réglages LDAP, quel que soit son `auth_mode`. Mais un Harbor en `oidc_auth` ne peut pas créer un compte avant la première connexion de la personne à Harbor : un accès accordé à quelqu’un qui ne s’y est jamais connecté y est refusé.

**Arbitrage de la troisième ligne.** Harbor en `ldap_auth` derrière un IdP OIDC signifie que la connexion à l’interface web de Harbor **contourne l’IdP et son MFA**. Le coût est faible si Harbor ne sert qu’à `docker pull` avec des robots ; si l’interface Harbor est utilisée au quotidien, l’incohérence sera relevée en revue de sécurité.

Trois pièges de raccordement :

- **Scope des groupes.** Dex ne met aucun claim `groups` dans le jeton sans le scope `groups` (mesuré sur Dex 2.44). Gateway refuse de démarrer — et le chart de se rendre — quand `OIDC_ROLE_MAPPING` porte sur le claim `groups` sans ce scope, au lieu de donner silencieusement `OIDC_DEFAULT_ROLE` à tout le monde.
- **Issuer.** Même URL depuis les navigateurs et les pods (voir plus haut).
- **Noms d’utilisateur.** Le nom Gateway vient de `preferred_username`, que Dex remplit depuis `preferredUsernameAttr`. L’aligner sur l’attribut `ldap_uid` de Harbor ; sinon passer le cluster en **son propre annuaire** et associer les comptes. Changer l’`id` d’un connecteur Dex change tous les `sub`, comme changer d’issuer.

Pour Entra ID et les autres IdP, utiliser le connecteur `oidc` de Dex et vérifier comment il remplit `preferred_username` ; utiliser une correspondance d’identité par cluster s’il ne correspond pas au compte Harbor. Passer des comptes OIDC directs à Dex change leur `<issuer>|<sub>` : prévoir une migration explicite plutôt que d’activer durablement le rattachement par email.

**SAML** n’existe pas dans Gateway et n’est pas prévu. Le connecteur SAML de Dex est refusé (sa propre documentation le dit non maintenu et probablement vulnérable au contournement d’authentification). Un client uniquement SAML fournit un issuer OIDC devant son fournisseur, raccordé au connecteur `oidc` de Dex.

**Révocation.** Désactiver un compte ou changer son rôle dans Gateway prend effet sous `AUTH_SESSION_REFRESH_SECONDS`. Désactiver quelqu’un uniquement chez le fournisseur ne ferme pas une session Gateway déjà ouverte ; il est refusé à sa prochaine connexion.

**Secours.** Conserver `OIDC_ALLOW_LOCAL_LOGIN=true` et un `SUPERADMIN` local distinct de tout compte SSO. Aucun mot de passe statique n’est configuré dans Dex.

### Diagnostic d’annuaire d’un cluster

La page d’un cluster (**Registres → cluster → Annuaire**, `ADMIN`) lit le mode de connexion et les réglages LDAP de chaque Harbor membre et les compare. Elle signale, nommément : un `auth_mode`, une base DN, un filtre, un attribut d’identifiant ou des réglages de groupes différents entre membres ; la vérification de certificat désactivée ; LDAP en `ldap://` ; un membre dont les réglages LDAP existent mais dont l’annuaire ne répond pas ; un membre sans réglages LDAP alors que d’autres en ont. Un membre injoignable est affiché comme tel, jamais comme cohérent. Le mot de passe de bind ne peut pas être comparé : Harbor ne le renvoie jamais. Ce panneau n’écrit rien.

### Écrire la configuration LDAP de Harbor (opt-in)

Un `SUPERADMIN` peut enregistrer les réglages LDAP d’un cluster et les écrire sur ses Harbor (**Annuaire → Configurer l’annuaire**, ou `PUT`/`POST /api/clusters/{id}/directory-config[/apply]`). Désactivé par défaut : tant que l’écriture n’est pas activée pour le cluster, rien n’est jamais écrit. Laisser désactivé si Harbor est géré par un autre outillage.

- Chaque Harbor teste d’abord les réglages lui-même (`POST /ldap/ping`, mot de passe de bind compris) ; un Harbor dont le test échoue n’est pas écrit.
- Les derniers réglages écrits sur chaque Harbor sont conservés sous forme d’empreinte, mot de passe compris : appliquer des réglages inchangés n’émet aucun appel. **Réécrire même sans changement** répare un Harbor modifié à la main.
- **Basculer les Harbor vierges en connexion LDAP** ne s’applique qu’à un Harbor ne portant aucun compte hormis `admin`, seul cas où Harbor l’accepte.
- Jamais mis en file ni rejoué : un rejeu écraserait une correction faite à la main.
- Le mot de passe de bind est chiffré avec `GATEWAY_SECRET_KEY`, jamais renvoyé par l’API ni journalisé. C’est un compte de service d’annuaire : sa compromission dépasse le périmètre de cette application.

Une base DN ou un filtre erroné sur un Harbor en `ldap_auth` verrouille tous ses utilisateurs humains. Le compte `admin` local de Harbor se connecte toujours, quel que soit le mode.

### Dépannage

| Symptôme | Vérification |
| --- | --- |
| Redirection refusée | URI de retour exacte, `AUTH_URL` publique, hôte/protocole du proxy |
| Connexion réussie avec un mauvais rôle | Claim de groupes réel, chemin pointé, format tableau et correspondances de rôles |
| Email existant refusé | Collision avec un compte local ; le rattachement exige une activation explicite et un email vérifié |
| Nouvel utilisateur refusé | `OIDC_ALLOW_SIGNUP`, affectation chez le fournisseur et état du compte |
| Connexion locale impossible après migration | Un compte fédéré ne peut pas utiliser de mot de passe local |
| Accès Harbor absent après SSO | Correspondance d’annuaire et appartenance Harbor sont distinctes de la connexion Gateway |
| Gateway refuse de démarrer : `OIDC_SCOPES: must include "groups"` | Ajouter `groups` aux scopes ; sans lui Dex n’émet aucun claim de groupes |
| La recherche d’annuaire ne liste que les personnes déjà connectées à Harbor | La page du cluster dit pourquoi : aucun réglage LDAP sur ce Harbor, ou identifiants enregistrés non administrateurs de Harbor |
| Accorder un accès à un compte d’annuaire échoue avec « only learns an account at that person's first sign-in » | Le Harbor est en `oidc_auth` : la personne doit se connecter une fois à Harbor |

Consulter [`.env.example`](../../.env.example) pour tous les paramètres OIDC et [l’implémentation](../../src/lib/auth/oidc.ts) pour les règles de rattachement et de résolution des rôles.
