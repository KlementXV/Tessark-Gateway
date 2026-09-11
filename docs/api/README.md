# REST API and MCP · API REST et MCP

OCI Helm charts use the existing transfer API and `create_transfer` MCP tool. Supply `repo` and an explicit OCI version in `tag` (for example `1.2.3_Build.7`); see [chart transfers and air-gap deployment](../on-premise-airgap.md#transférer-des-charts-helm-oci).

**[English](#english) · [Français](#français)** · [Tessark Gateway](../../README.md)

## English

### Authentication and activation

The browser interface uses a session cookie. External integrations use API tokens, which are disabled by default:

```dotenv
API_EXTERNAL_ENABLED=true
```

With Helm, set `apiExternal.enabled: true` in your deployment values and apply an upgrade as described in the [deployment guide](../../deploy/helm/tessark-gateway/README.md#english).

Create a token under **Settings → API Tokens** (`/settings/tokens`). Copy the secret at creation: it is displayed only once. A token inherits its owner’s role and authorized project access. Enabling the feature alone does not create a token or grant permissions.

```bash
# GATEWAY_API_TOKEN contains a token created in the UI.
curl --fail-with-body \
  -H "Authorization: Bearer ${GATEWAY_API_TOKEN}" \
  https://gateway.example.com/api/projects
```

Revoke tokens that are no longer needed. The configured maximum token lifetime defaults to 365 days (`API_TOKEN_MAX_TTL_DAYS`, Helm `apiExternal.tokenMaxTtlDays`).

### Interactive reference

| Endpoint | Purpose |
| --- | --- |
| `/api/docs` | Swagger UI |
| `/api/openapi.json` | OpenAPI 3.1 document |
| `/api/health` | HTTP liveness |
| `/api/ready` | Configuration/database readiness with Kubernetes status |
| `/api/mcp` | Optional MCP transport |

Swagger assets are served locally. The OpenAPI document is generated from the route catalogue at request time. `/api/docs` and `/api/openapi.json` remain accessible when external token authentication is disabled; they describe the API without returning registry or project data. Use the running instance’s reference for request bodies, response schemas and route-specific authorization.

### Limits and errors

The default rate limit is **60 requests/minute**, per token after authentication and per IP before token resolution. Set `API_RATE_LIMIT_PER_MINUTE` / `apiExternal.rateLimitPerMinute` to change it. Counters are in memory and are not shared across replicas.

For protected resources, an invalid/missing token results in authentication failure; valid credentials still require the relevant role and project access. A rate-limited request receives `429` with `Retry-After`. Respect that delay before retrying. Do not assume a failed network response means a write was not applied: check the affected resource before repeating a mutation.

### MCP setup

Enable both flags; enable writes separately:

```dotenv
API_EXTERNAL_ENABLED=true
MCP_ENABLED=true
MCP_WRITE_TOOLS_ENABLED=false
```

The Helm equivalents are `apiExternal.enabled`, `mcp.enabled` and `mcp.writeToolsEnabled`. If either of the first two flags is off, `/api/mcp` returns **404**. With both enabled, a missing/invalid Bearer token returns **401**. A browser session cookie does not authenticate MCP requests.

Configure a client that supports **Streamable HTTP** with the endpoint `https://gateway.example.com/api/mcp` and header `Authorization: Bearer <token>`. Client configuration formats vary; clients using an `mcpServers` map may accept:

```json
{
  "mcpServers": {
    "tessark-gateway": {
      "url": "https://gateway.example.com/api/mcp",
      "headers": { "Authorization": "Bearer REPLACE_WITH_YOUR_TOKEN" }
    }
  }
}
```

Keep this client configuration private once it contains a real token. The transport uses JSON responses; available tools depend on the write flag, and each invocation still enforces authorization.

### Tools

| Mode | Tools |
| --- | --- |
| Read | `list_projects`, `get_project`, `list_registries`, `list_clusters`, `list_transfers`, `get_transfer_status`, `search_images` |
| Write, when enabled | `create_transfer`, `approve_transfer`, `create_project` |

`list_registries` and `approve_transfer` require `ADMIN` or higher. Other tools enforce their own role/project rules; turning on writes does not bypass approvals or transfer policies. Robot creation is not exposed as an MCP tool because it returns a plaintext Harbor credential.

Tool calls are logged with token ID, tool name and outcome, without raw arguments. Consult the [tool registrations](../../src/lib/mcp/tools/index.ts) for the implementation.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| MCP returns 404 | Both `API_EXTERNAL_ENABLED` and `MCP_ENABLED` must be enabled |
| MCP returns 401 | Bearer header, token expiry/revocation and owner account |
| Forbidden operation | Owner role, project access and applicable policy |
| Write tool absent | `MCP_WRITE_TOOLS_ENABLED` and client tool-list refresh |
| 429 response | `Retry-After` and per-instance rate-limit configuration |
| Transfer accepted but unfinished | Destination Jobs and transfer status synchronization, described in the Helm guide |

## Français

### Authentification et activation

L’interface web utilise un cookie de session. Les intégrations externes utilisent des tokens API, désactivés par défaut :

```dotenv
API_EXTERNAL_ENABLED=true
```

Avec Helm, définir `apiExternal.enabled: true` dans les valeurs de déploiement, puis appliquer une mise à jour selon le [guide de déploiement](../../deploy/helm/tessark-gateway/README.md#français).

Créer un token dans **Paramètres → Tokens API** (`/settings/tokens`). Copier le secret à sa création : il n’est affiché qu’une fois. Le token hérite du rôle et des accès aux projets de son propriétaire. Activer la fonctionnalité ne crée aucun token et n’accorde aucun droit.

```bash
# GATEWAY_API_TOKEN contient un token créé dans l’interface.
curl --fail-with-body \
  -H "Authorization: Bearer ${GATEWAY_API_TOKEN}" \
  https://gateway.example.com/api/projects
```

Révoquer les tokens devenus inutiles. Leur durée de vie maximale configurée vaut 365 jours par défaut (`API_TOKEN_MAX_TTL_DAYS`, Helm `apiExternal.tokenMaxTtlDays`).

### Référence interactive

| Point d’accès | Utilité |
| --- | --- |
| `/api/docs` | Interface Swagger |
| `/api/openapi.json` | Document OpenAPI 3.1 |
| `/api/health` | Vérification de la réponse HTTP |
| `/api/ready` | État de la configuration/base et indication de l’état Kubernetes |
| `/api/mcp` | Transport MCP optionnel |

Les ressources Swagger sont servies localement. Le document OpenAPI est généré depuis le catalogue des routes à chaque requête. `/api/docs` et `/api/openapi.json` restent accessibles si l’authentification externe par token est désactivée ; ils décrivent l’API sans renvoyer de données de registres ou de projets. Consulter la référence de l’instance en cours pour les corps de requête, les réponses et les autorisations propres aux routes.

### Limites et erreurs

La limite par défaut est de **60 requêtes/minute**, par token après authentification et par IP avant sa résolution. La modifier avec `API_RATE_LIMIT_PER_MINUTE` / `apiExternal.rateLimitPerMinute`. Les compteurs sont en mémoire et ne sont pas partagés entre réplicas.

Sur les ressources protégées, un token invalide/absent entraîne un échec d’authentification ; des identifiants valides exigent encore le rôle et les accès au projet appropriés. Une requête limitée reçoit `429` avec `Retry-After`. Respecter ce délai avant de réessayer. Une réponse réseau en échec ne prouve pas qu’une écriture n’a pas eu lieu : vérifier la ressource concernée avant de répéter une modification.

### Configuration MCP

Activer les deux variables ; autoriser l’écriture séparément :

```dotenv
API_EXTERNAL_ENABLED=true
MCP_ENABLED=true
MCP_WRITE_TOOLS_ENABLED=false
```

Les équivalents Helm sont `apiExternal.enabled`, `mcp.enabled` et `mcp.writeToolsEnabled`. Si l’une des deux premières activations manque, `/api/mcp` renvoie **404**. Si elles sont actives, un token Bearer absent/invalide renvoie **401**. Un cookie de session navigateur n’authentifie pas les requêtes MCP.

Configurer un client compatible **Streamable HTTP** avec l’adresse `https://gateway.example.com/api/mcp` et l’en-tête `Authorization: Bearer <token>`. Le format dépend du client ; ceux qui utilisent une structure `mcpServers` peuvent accepter :

```json
{
  "mcpServers": {
    "tessark-gateway": {
      "url": "https://gateway.example.com/api/mcp",
      "headers": { "Authorization": "Bearer REPLACE_WITH_YOUR_TOKEN" }
    }
  }
}
```

Conserver cette configuration cliente privée dès qu’elle contient un vrai token. Le transport utilise des réponses JSON ; les outils disponibles dépendent de l’activation de l’écriture, et chaque appel vérifie les autorisations.

### Outils

| Mode | Outils |
| --- | --- |
| Lecture | `list_projects`, `get_project`, `list_registries`, `list_clusters`, `list_transfers`, `get_transfer_status`, `search_images` |
| Écriture, si activée | `create_transfer`, `approve_transfer`, `create_project` |

`list_registries` et `approve_transfer` exigent `ADMIN` ou plus. Les autres outils appliquent leurs règles de rôle/projet ; activer l’écriture ne contourne ni les approbations ni les règles de transfert. La création de robot n’est pas exposée en MCP car elle renvoie un identifiant Harbor en clair.

Les appels sont journalisés avec l’identifiant du token, le nom de l’outil et le résultat, sans les arguments bruts. Consulter [l’enregistrement des outils](../../src/lib/mcp/tools/index.ts) pour l’implémentation.

### Dépannage

| Symptôme | Vérification |
| --- | --- |
| MCP renvoie 404 | `API_EXTERNAL_ENABLED` et `MCP_ENABLED` doivent être actifs |
| MCP renvoie 401 | En-tête Bearer, expiration/révocation du token et compte propriétaire |
| Opération interdite | Rôle, accès au projet et règle applicable |
| Outil d’écriture absent | `MCP_WRITE_TOOLS_ENABLED` et rafraîchissement de la liste d’outils du client |
| Réponse 429 | `Retry-After` et configuration de la limite par instance |
| Transfert accepté mais inachevé | Jobs de destination et synchronisation du statut, décrits dans le guide Helm |

## Transférer tous les tags de l’artefact demandé

L’option **Inclure les autres tags de l’artefact** correspond à `allTags: true` dans REST et
MCP. Le champ `tag` sélectionne l’artefact ; il n’est jamais ignoré (`latest` par défaut).

```json
{
  "sourceId": "source-id",
  "repo": "library/nginx",
  "tag": "latest",
  "allTags": true,
  "targets": [{ "projectId": "destination-id" }]
}
```

Si `latest`, `1.28` et `1.28.0` pointent vers le digest A, ces trois tags sont transférés.
Si `1.27` et `alpine` pointent vers d’autres digests, ils sont exclus. La comparaison porte sur
le manifeste ou l’index multi-architecture complet, pas sur une couche ou une architecture.
Le digest identifie le contenu ; aucun tag artificiel nommé d’après le digest n’est créé.

Le digest sélectionné est figé dans **chaque** demande, y compris pour une source amont.
Si un tag est déplacé avant approbation ou pendant la création des demandes, les copies restent
attachées à l’artefact initial. Chaque tag garde ses destinations, son approbation, son statut et
son retry. Les demandes partagent un `batchId` pour permettre l’approbation groupée. Aucun
transfert des autres artefacts du dépôt n’est lancé. Aucun changement de schéma de base requis.

Harbor fournit directement les tags de l’artefact par digest, avec pagination. Sur un registre
OCI générique (Docker Hub, etc.), Gateway résout le digest demandé puis compare les manifestes
des tags du dépôt pour trouver ses alias. Cette inspection ne télécharge pas leurs couches et
ne les copie pas. Les credentials, la CA et les contrôles d’autorisation habituels s’appliquent.
Un artefact demandé inexistant ou une lecture incomplète renvoie une erreur, sans élargir la
sélection aux autres artefacts.

REST répond `{ "started": [...], "failed": [...] }`, même pour une seule image avec l’option.
`started` désigne les demandes créées/lancées, pas la fin des copies ; `pending: true` indique
une approbation requise. MCP répond `{ batchId, transfers, failed }`. Sans l’option, le contrat
habituel est conservé. Avec `images`, l’option s’applique à l’artefact sélectionné sur chaque
ligne ; deux tags d’un même dépôt peuvent sélectionner deux artefacts différents.

Limites : 500 tags transférés par lot et, pour la recherche d’alias sur un registre générique,
10 000 tags inspectés par dépôt. En cas de dépassement, la sélection concernée échoue sans
troncature silencieuse ; un cumul dépassant 500 tags refuse le lot avant toute création.

Pour les charts OCI, la version reste obligatoire dans le formulaire, même avec l’option.
Seuls les tags de ce même artefact sont inclus, pas les autres versions du chart. Les images
de workloads et les dépendances externes ne sont pas automatiquement transférées.
