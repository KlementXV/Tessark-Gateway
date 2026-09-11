# Changelog

Les changements destinés à la prochaine release sont regroupés dans **Unreleased**.
Chaque release applicative indiquera sa version, sa date et la version du chart Helm associé.
L’historique des publications antérieures n’a pas été reconstitué : les numéros présents dans
les manifests ne constituent pas, à eux seuls, une preuve de publication.

Voir le [guide des releases](docs/releases.md) pour préparer, vérifier et déployer une version.

## [Unreleased]

### Added

- Authentification LDAP/AD et SSO OIDC via Dex, embarqué dans le chart ou exploité séparément.
- Recherche d’utilisateurs et de groupes dans l’annuaire Harbor, correspondances d’identité par cluster et diagnostic des configurations LDAP.
- Configuration LDAP des Harbor depuis Gateway, avec activation explicite et test préalable sur chaque membre.
- Préparation des releases et contrôle CI de la cohérence entre version applicative, lockfile, chart, tag Git et changelog.
- Workflows GitHub **Prepare release** et **Publish release** : PR de versions, contrôle du commit validé, publication GHCR et GitHub Release avec chart, digests et sommes de contrôle.
- Version applicative issue de `package.json`, affichée dans les paramètres et annoncée par le serveur MCP.

### Fixed

- Conservation des rôles attribués dans Gateway lorsque le mapping SSO est vide, y compris lors de la migration d’un compte local.
- Déconnexion SSO : résolution de la destination avant suppression de la session Gateway, puis navigation vers le fournisseur ; repli local si la destination est indisponible.

### Security

- Le rattachement par email exige un compte local sans identité externe ; une écriture conditionnelle empêche deux migrations simultanées de remplacer la même identité.
- Un rôle explicitement associé à un groupe reste prioritaire sur un rôle par défaut plus privilégié.

### Upgrade notes

- Appliquer les migrations Prisma livrées avec l’image ; les hooks Helm les exécutent à l’installation et à la mise à niveau. Sauvegarder la base et conserver sa `GATEWAY_SECRET_KEY`.
- Avec Dex embarqué, inclure son image dans le lot airgap et prévoir ses Secrets, CA, CRD/RBAC et son exposition réseau. Le NodePort de Gateway seul ne publie pas Dex.
- Conserver un `SUPERADMIN` local distinct pour le secours. Le rattachement par email ne migre pas un compte déjà fédéré vers un autre issuer ou sujet OIDC.
- La validation sur le LDAP/Dex et le cluster de destination reste nécessaire ; les tests automatisés ne remplacent pas cette recette.
