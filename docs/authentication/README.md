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

SSO is disabled by default. Gateway uses OIDC discovery from the configured issuer and authorization code authentication with PKCE/state. LDAP or Active Directory integration belongs to the identity provider; Gateway does not connect directly to those directories.

1. Create an OIDC application at your provider. Register **exactly** `https://gateway.example.com/api/auth/callback/oidc`, using your actual public Gateway URL without a trailing slash after `oidc`.
2. Set the issuer, client ID and, for a confidential client, client secret. Make the provider’s discovery endpoint reachable from the Gateway.
3. Configure the required identity/group claims at the provider. Scope names and claim mapping depend on its configuration; the example uses Keycloak.
4. Keep a tested local administrator account available while validating SSO, then enable role mapping if required.

```dotenv
AUTH_URL=https://gateway.example.com
OIDC_ENABLED=true
OIDC_ISSUER=https://sso.example.com/realms/tessark
OIDC_CLIENT_ID=tessark-gateway
OIDC_CLIENT_SECRET=replace-with-provider-secret
OIDC_SCOPES="openid profile email"
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
| `OIDC_ROLE_CLAIM` | `groups` | Claim name or dotted path, such as `realm_access.roles` |
| `OIDC_ROLE_MAPPING` | `{}` | Maps claim values to `USER`, `ADMIN` or `SUPERADMIN` |
| `OIDC_DEFAULT_ROLE` | `USER` | Role assigned when no configured group matches |
| `OIDC_LOGOUT_MODE` | `local` | Ends the Gateway session; `idp` also requests provider logout |

With an empty role mapping, existing roles remain managed in Gateway. A nonempty mapping is reapplied on each SSO sign-in: the highest matching role wins and the provider owns that user’s role.

```dotenv
OIDC_ROLE_MAPPING='{"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}'
```

The role claim accepts a string or an array of strings. A comma-separated string is one value, not a list of groups. Both `gateway-admins` and `/gateway-admins` match the corresponding Keycloak group name. Configure group membership in the provider’s token claims; a successful login alone does not prove groups were included.

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

### Directory groups

The project **Members** tab can grant a project role to a directory group already known by Harbor. Gateway does not enumerate that group’s members or create groups from a manually entered LDAP DN.

A group grant gives access **on Harbor** (for example, image pull/push), but does not add its members to the Gateway project list or membership table. Add Gateway memberships separately when access to the portal’s project view is required.

### Local Keycloak development

After completing the [local setup](../../README.md#english), start the optional SSO service:

```bash
docker compose -f docker-compose.dev.yml --profile sso up -d
```

The [development realm](../../deploy/dev/keycloak-realm.json) imports the `tessark-gateway` client with secret `dev-client-secret`. The admin console is at `http://localhost:8080` (`admin` / `admin`). Test users are `alice` / `alice` (owners), `bob` / `bob` (admins), and `carol` / `carol` (no mapped group). These credentials are for local development only.

```dotenv
AUTH_URL=http://localhost:3000
OIDC_ENABLED=true
OIDC_ISSUER=http://localhost:8080/realms/tessark
OIDC_CLIENT_ID=tessark-gateway
OIDC_CLIENT_SECRET=dev-client-secret
OIDC_ROLE_MAPPING='{"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}'
```

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Redirect rejected | Exact callback URI, public `AUTH_URL`, proxy host/protocol |
| Login succeeds with the wrong role | Actual group claim, dotted path, array format and role mapping |
| Existing email refused | Local account collision; linking requires explicit activation and verified email |
| Unknown user refused | `OIDC_ALLOW_SIGNUP`, provider assignment and account status |
| Local login fails for a migrated account | Federated accounts cannot use local passwords |
| Harbor access missing after SSO | Cluster directory mapping and Harbor project membership are separate from Gateway login |

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

Le SSO est désactivé par défaut. Gateway utilise la découverte OIDC depuis l’issuer configuré et une authentification par code avec PKCE/state. Le fournisseur d’identité assure l’intégration LDAP ou Active Directory ; Gateway ne se connecte pas directement à ces annuaires.

1. Créer une application OIDC chez le fournisseur. Enregistrer **exactement** `https://gateway.example.com/api/auth/callback/oidc`, avec l’URL publique réelle du Gateway, sans slash final après `oidc`.
2. Définir l’issuer, l’identifiant client et, pour un client confidentiel, son secret. Le point de découverte du fournisseur doit être accessible depuis Gateway.
3. Configurer les claims d’identité et de groupes requis chez le fournisseur. Les noms des scopes et les correspondances de claims dépendent de sa configuration ; l’exemple utilise Keycloak.
4. Conserver un compte administrateur local testé pendant la validation du SSO, puis activer l’attribution des rôles si nécessaire.

```dotenv
AUTH_URL=https://gateway.example.com
OIDC_ENABLED=true
OIDC_ISSUER=https://sso.example.com/realms/tessark
OIDC_CLIENT_ID=tessark-gateway
OIDC_CLIENT_SECRET=remplacer-par-le-secret-du-fournisseur
OIDC_SCOPES="openid profile email"
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
| `OIDC_ROLE_CLAIM` | `groups` | Nom du claim ou chemin pointé, tel que `realm_access.roles` |
| `OIDC_ROLE_MAPPING` | `{}` | Associe les valeurs du claim à `USER`, `ADMIN` ou `SUPERADMIN` |
| `OIDC_DEFAULT_ROLE` | `USER` | Rôle appliqué si aucun groupe configuré ne correspond |
| `OIDC_LOGOUT_MODE` | `local` | Termine la session Gateway ; `idp` demande aussi la déconnexion du fournisseur |

Sans correspondance de rôles, les rôles existants restent gérés dans Gateway. Une correspondance non vide est réappliquée à chaque connexion SSO : le rôle correspondant le plus élevé l’emporte et le fournisseur devient responsable du rôle de cet utilisateur.

```dotenv
OIDC_ROLE_MAPPING='{"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}'
```

Le claim accepte une chaîne ou un tableau de chaînes. Une chaîne séparée par des virgules est une seule valeur, pas une liste de groupes. `gateway-admins` et `/gateway-admins` correspondent au même groupe Keycloak. Configurer les appartenances dans les claims du token chez le fournisseur ; une connexion réussie ne prouve pas que les groupes sont présents.

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

### Groupes d’annuaire

L’onglet **Membres** d’un projet permet d’accorder un rôle de projet à un groupe d’annuaire déjà connu de Harbor. Gateway n’énumère pas les membres du groupe et ne crée pas de groupe depuis un DN LDAP saisi manuellement.

Un octroi par groupe donne l’accès **sur Harbor** (par exemple pour pull/push), sans ajouter ses membres à la liste des projets ou au tableau des appartenances Gateway. Ajouter séparément des appartenances Gateway si ces personnes doivent consulter le projet dans le portail.

### Développement avec Keycloak local

Après la [configuration locale](../../README.md#français), démarrer le service SSO optionnel :

```bash
docker compose -f docker-compose.dev.yml --profile sso up -d
```

Le [realm de développement](../../deploy/dev/keycloak-realm.json) importe le client `tessark-gateway` avec le secret `dev-client-secret`. La console d’administration est à `http://localhost:8080` (`admin` / `admin`). Les utilisateurs de test sont `alice` / `alice` (owners), `bob` / `bob` (admins) et `carol` / `carol` (sans groupe associé). Ces identifiants sont réservés au développement local.

```dotenv
AUTH_URL=http://localhost:3000
OIDC_ENABLED=true
OIDC_ISSUER=http://localhost:8080/realms/tessark
OIDC_CLIENT_ID=tessark-gateway
OIDC_CLIENT_SECRET=dev-client-secret
OIDC_ROLE_MAPPING='{"gateway-admins":"ADMIN","gateway-owners":"SUPERADMIN"}'
```

### Dépannage

| Symptôme | Vérification |
| --- | --- |
| Redirection refusée | URI de retour exacte, `AUTH_URL` publique, hôte/protocole du proxy |
| Connexion réussie avec un mauvais rôle | Claim de groupes réel, chemin pointé, format tableau et correspondances de rôles |
| Email existant refusé | Collision avec un compte local ; le rattachement exige une activation explicite et un email vérifié |
| Nouvel utilisateur refusé | `OIDC_ALLOW_SIGNUP`, affectation chez le fournisseur et état du compte |
| Connexion locale impossible après migration | Un compte fédéré ne peut pas utiliser de mot de passe local |
| Accès Harbor absent après SSO | Correspondance d’annuaire et appartenance Harbor sont distinctes de la connexion Gateway |

Consulter [`.env.example`](../../.env.example) pour tous les paramètres OIDC et [l’implémentation](../../src/lib/auth/oidc.ts) pour les règles de rattachement et de résolution des rôles.
