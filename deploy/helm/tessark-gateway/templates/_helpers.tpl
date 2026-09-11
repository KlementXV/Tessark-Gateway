{{/*
Chart name, truncated and DNS-1123-safe.
*/}}
{{- define "tessark-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Release-scoped resource name prefix.
*/}}
{{- define "tessark-gateway.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "tessark-gateway.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Standard labels, applied to every object this chart creates.
*/}}
{{- define "tessark-gateway.labels" -}}
helm.sh/chart: {{ include "tessark-gateway.chart" . }}
{{ include "tessark-gateway.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels — kept minimal and stable across upgrades (never add anything here that could
change between releases, or Deployment/StatefulSet selector updates become immutable-field
errors).
*/}}
{{- define "tessark-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tessark-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
ServiceAccount name the Deployment (and thus the pull-request feature) runs as.
*/}}
{{- define "tessark-gateway.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "tessark-gateway.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Name of the application Secret carrying AUTH_SECRET/GATEWAY_SECRET_KEY/DATABASE_URL etc. —
either the one this chart manages, or an externally-supplied one (existingSecret).
*/}}
{{- define "tessark-gateway.secretName" -}}
{{- .Values.existingSecret | default (printf "%s" (include "tessark-gateway.fullname" .)) -}}
{{- end -}}

{{/*
Name of the embedded Postgres StatefulSet's own credentials Secret.
*/}}
{{- define "tessark-gateway.embeddedDbSecretName" -}}
{{- printf "%s-postgres" (include "tessark-gateway.fullname" .) -}}
{{- end -}}

{{/*
Name of the embedded Postgres headless Service / StatefulSet.
*/}}
{{- define "tessark-gateway.embeddedDbName" -}}
{{- printf "%s-postgres" (include "tessark-gateway.fullname" .) -}}
{{- end -}}

{{/*
DATABASE_URL as a literal string — only valid for modes where the password is resolvable at
template-render time (embedded: via `lookup` on our own generated Secret; external: from
values, unless externalDatabase.existingSecret is set). NOT valid for `cnpg`, whose Secret is
created by the operator and doesn't exist yet on a first install — see
"tessark-gateway.databaseEnv" below, which composes DATABASE_URL for that case instead via
Kubernetes' own $(VAR) env substitution, and is what every Pod template actually uses.
The password segment is always urlquery-escaped — an unescaped `@` or `/` in a generated or
user-supplied password silently breaks Prisma's URL parsing.
*/}}
{{- define "tessark-gateway.databaseUrl" -}}
{{- $mode := .Values.database.mode -}}
{{- if eq $mode "embedded" -}}
{{- $secretName := include "tessark-gateway.embeddedDbSecretName" . -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $secretName -}}
{{- $password := "" -}}
{{- if $existing -}}
{{- $password = index $existing.data "password" | b64dec -}}
{{- else -}}
{{- $password = randAlphaNum 32 -}}
{{- end -}}
{{- printf "postgresql://tessark:%s@%s:5432/tessark_gateway?schema=public&connection_limit=%d" ($password | urlquery) (include "tessark-gateway.embeddedDbName" .) (.Values.database.connectionLimit | int) -}}
{{- else if eq $mode "external" -}}
{{- $ext := .Values.database.external -}}
{{- printf "postgresql://%s:%s@%s:%d/%s?schema=public&connection_limit=%d&sslmode=%s" $ext.username ($ext.password | urlquery) $ext.host ($ext.port | int) $ext.database (.Values.database.connectionLimit | int) $ext.sslMode -}}
{{- end -}}
{{- end -}}

{{/*
Name of the CNPG-managed owner Secret (CloudNativePG's own default naming convention:
`<cluster-name>-app`) — the Cluster this chart renders is named after
"tessark-gateway.fullname" (see templates/database/cnpg-cluster.yaml).
*/}}
{{- define "tessark-gateway.cnpgSecretName" -}}
{{- printf "%s-app" (include "tessark-gateway.fullname" .) -}}
{{- end -}}

{{/*
Extra env: entries every Pod template (Deployment, job-migrate, job-seed) must splice into its
container's `env:` list, on top of `envFrom: secretRef` pointing at the app Secret.

  - embedded / external with a plain password: nothing — DATABASE_URL already sits in the app
    Secret as a resolved literal (see "tessark-gateway.databaseUrl" above).
  - external with existingSecretPasswordKey: DATABASE_URL composed here via Kubernetes' native
    $(VAR) substitution (a feature of env[].value, never available through envFrom) so the
    password never has to pass through `lookup`/urlquery in a template.
  - cnpg: same $(VAR) trick, sourced from the operator-managed Secret instead of ours — that
    Secret doesn't exist yet at first install, so it can't be resolved via `lookup` no matter
    what.

Kubernetes semantics: when the same key is set by both `envFrom` and `env`, the `env:` entry
always wins — so it's safe for the app Secret to also carry a (unused, never selected) fallback
DATABASE_URL key without conflicting.
*/}}
{{- define "tessark-gateway.databaseEnv" -}}
{{- $mode := .Values.database.mode -}}
{{- if eq $mode "cnpg" -}}
- name: DB_USER
  valueFrom:
    secretKeyRef:
      name: {{ include "tessark-gateway.cnpgSecretName" . }}
      key: username
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "tessark-gateway.cnpgSecretName" . }}
      key: password
- name: DATABASE_URL
  value: "postgresql://$(DB_USER):$(DB_PASSWORD)@{{ include "tessark-gateway.fullname" . }}-rw:5432/app?schema=public&connection_limit={{ .Values.database.connectionLimit | int }}"
{{- else if and (eq $mode "external") .Values.database.external.existingSecret -}}
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.external.existingSecret }}
      key: {{ .Values.database.external.existingSecretPasswordKey }}
- name: DATABASE_URL
  value: "postgresql://{{ .Values.database.external.username }}:$(DB_PASSWORD)@{{ .Values.database.external.host }}:{{ .Values.database.external.port }}/{{ .Values.database.external.database }}?schema=public&connection_limit={{ .Values.database.connectionLimit | int }}&sslmode={{ .Values.database.external.sslMode }}"
{{- end -}}
{{- end -}}

{{/*
AUTH_URL: explicit value wins; otherwise derived from the first Ingress host when Ingress is
enabled (decision D6). Empty when neither is available — NextAuth still works without it for
same-origin access, just not correctly behind a reverse proxy that rewrites Host.
*/}}
{{- define "tessark-gateway.authUrl" -}}
{{- if .Values.auth.url -}}
{{- .Values.auth.url -}}
{{- else if and .Values.ingress.enabled (gt (len .Values.ingress.hosts) 0) -}}
{{- $host := (first .Values.ingress.hosts).host -}}
{{- $scheme := "http" -}}
{{- range .Values.ingress.tls -}}
{{- range .hosts -}}
{{- if eq . $host -}}
{{- $scheme = "https" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- printf "%s://%s" $scheme $host -}}
{{- end -}}
{{- end -}}

{{/* Rewrite full references without changing tags/digests. Explicit upstream hosts are
removed only when a global registry is configured. Short names retain their path. */}}
{{- define "tessark-gateway.imageRef" -}}
{{- $ref := .image -}}
{{- if and $ref .root.Values.global.imageRegistry -}}
{{- $parts := splitList "/" $ref -}}
{{- $first := first $parts -}}
{{- if and (gt (len $parts) 1) (or (contains "." $first) (contains ":" $first) (eq $first "localhost")) -}}
{{- $ref = join "/" (rest $parts) -}}
{{- end -}}
{{- $prefix := trimAll "/" .root.Values.global.imageRepositoryPrefix -}}
{{- if $prefix -}}{{- $ref = printf "%s/%s" $prefix $ref -}}{{- end -}}
{{- $ref = printf "%s/%s" (trimSuffix "/" .root.Values.global.imageRegistry) $ref -}}
{{- end -}}
{{- $ref -}}
{{- end -}}

{{- define "tessark-gateway.appImage" -}}
{{- $repo := .Values.image.repository -}}
{{- if .Values.image.registry -}}{{- $repo = printf "%s/%s" .Values.image.registry $repo -}}{{- end -}}
{{- $ref := printf "%s:%s" $repo (.Values.image.tag | default .Chart.AppVersion) -}}
{{- if .Values.image.digest -}}{{- $ref = printf "%s@%s" $repo .Values.image.digest -}}{{- end -}}
{{- include "tessark-gateway.imageRef" (dict "root" . "image" $ref) -}}
{{- end -}}

{{/* Return JSON names so ConfigMap environment values and Pod references share defaults.
App and build imagePullSecrets use {name: ...}; other component and global lists use names. */}}
{{- define "tessark-gateway.pullSecretNames" -}}
{{- $names := list -}}
{{- range concat .root.Values.global.imagePullSecrets .local -}}
{{- if kindIs "map" . -}}{{- $names = append $names .name -}}
{{- else -}}{{- $names = append $names . -}}{{- end -}}
{{- end -}}
{{- uniq $names | toJson -}}
{{- end -}}

{{- define "tessark-gateway.pullSecrets" -}}
{{- $names := include "tessark-gateway.pullSecretNames" . | fromJsonArray -}}
{{- if $names -}}
imagePullSecrets:
{{- range $names }}
  - name: {{ . | quote }}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "tessark-gateway.pullSecretRefs" -}}
{{- $refs := list -}}
{{- range (include "tessark-gateway.pullSecretNames" . | fromJsonArray) -}}
{{- $refs = append $refs (dict "name" .) -}}
{{- end -}}
{{- $refs | toJson -}}
{{- end -}}

{{/*
Embedded Dex (identity.mode=embedded, docs/plan-ldap-sso-local.md lot 6). "true" or empty.
*/}}
{{- define "tessark-gateway.dexEnabled" -}}
{{- if and .Values.oidc.enabled (eq .Values.identity.mode "embedded") -}}true{{- end -}}
{{- end -}}

{{- define "tessark-gateway.dexName" -}}
{{- printf "%s-dex" (include "tessark-gateway.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
A name of its own, not the Gateway's selector labels plus a component: the Gateway Service and
Deployment select on those two labels alone, and Dex's container port is also called "http" —
sharing them would send Gateway traffic to Dex.
*/}}
{{- define "tessark-gateway.dexSelectorLabels" -}}
app.kubernetes.io/name: {{ include "tessark-gateway.name" . }}-dex
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "tessark-gateway.dexLabels" -}}
helm.sh/chart: {{ include "tessark-gateway.chart" . }}
{{ include "tessark-gateway.dexSelectorLabels" . }}
app.kubernetes.io/component: identity
app.kubernetes.io/part-of: {{ include "tessark-gateway.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "tessark-gateway.dexSecretName" -}}
{{- .Values.identity.dex.existingSecret | default (include "tessark-gateway.dexName" .) -}}
{{- end -}}

{{/* The public issuer: explicit, or <auth url>/dex on the Gateway's own host. */}}
{{- define "tessark-gateway.dexIssuer" -}}
{{- if .Values.identity.dex.issuer -}}
{{- trimSuffix "/" .Values.identity.dex.issuer -}}
{{- else -}}
{{- $authUrl := include "tessark-gateway.authUrl" . -}}
{{- if $authUrl -}}{{- printf "%s/dex" (trimSuffix "/" $authUrl) -}}{{- end -}}
{{- end -}}
{{- end -}}

{{/* JSON {"host": …, "path": …} for routing the issuer through an Ingress; {} when not applicable. */}}
{{- define "tessark-gateway.dexRoute" -}}
{{- $issuer := include "tessark-gateway.dexIssuer" . -}}
{{- if and (include "tessark-gateway.dexEnabled" .) $issuer -}}
{{- $url := urlParse $issuer -}}
{{- dict "host" (first (splitList ":" $url.host)) "path" (default "/" $url.path) | toJson -}}
{{- else -}}
{{- "{}" -}}
{{- end -}}
{{- end -}}

{{/*
Fails the render on an identity configuration that would install cleanly and then let nobody in —
the failures that otherwise only show up at the first sign-in (plan lot 5 and 6).
*/}}
{{- define "tessark-gateway.validateIdentity" -}}
{{- if not (has .Values.identity.mode (list "embedded" "external")) -}}
{{- fail "identity.mode must be embedded or external" -}}
{{- end -}}
{{- if .Values.oidc.enabled -}}
{{- if eq .Values.identity.mode "embedded" -}}
{{- if not .Values.identity.dex.connectors -}}
{{- fail "identity.mode=embedded needs at least one Dex connector (type ldap or oidc) in identity.dex.connectors — or identity.mode=external to sign in through a Dex you run yourself" -}}
{{- end -}}
{{- range .Values.identity.dex.connectors -}}
{{- if eq (toString .type) "saml" -}}
{{- fail "identity.dex.connectors: the saml connector is refused — Dex documents it as unmaintained and likely vulnerable to authentication bypass. Put an OIDC issuer in front of the SAML provider and use an oidc connector (docs/authentication/README.md)" -}}
{{- end -}}
{{- if not (has (toString .type) (list "ldap" "oidc")) -}}
{{- fail (printf "identity.dex.connectors: connector type %q is not supported — use ldap or oidc" (toString .type)) -}}
{{- end -}}
{{- end -}}
{{- range $key, $_ := .Values.identity.dex.extraConfig -}}
{{- if has $key (list "issuer" "storage" "web" "telemetry" "staticClients" "connectors") -}}
{{- fail (printf "identity.dex.extraConfig.%s is managed by the chart" $key) -}}
{{- end -}}
{{- if has $key (list "staticPasswords" "enablePasswordDB") -}}
{{- fail (printf "identity.dex.extraConfig.%s is refused: Dex static passwords would be a second recovery account to forget — keep a local Gateway SUPERADMIN instead" $key) -}}
{{- end -}}
{{- end -}}
{{- if hasKey .Values.identity.dex.env "GATEWAY_CLIENT_SECRET" -}}
{{- fail "identity.dex.env.GATEWAY_CLIENT_SECRET is set by the chart — use identity.dex.clientSecret" -}}
{{- end -}}
{{- if or .Values.oidc.issuer .Values.oidc.clientId .Values.oidc.clientSecret -}}
{{- fail "oidc.issuer, oidc.clientId and oidc.clientSecret are derived from the embedded Dex — leave them empty, or set identity.mode=external" -}}
{{- end -}}
{{- if not (include "tessark-gateway.authUrl" .) -}}
{{- fail "identity.mode=embedded needs auth.url (or an Ingress host) to register the Gateway's redirect URI in Dex and to derive the issuer" -}}
{{- end -}}
{{- else if not .Values.oidc.issuer -}}
{{- fail "identity.mode=external needs oidc.issuer — the URL of the Dex you run" -}}
{{- end -}}
{{- if and .Values.oidc.roleMapping (eq .Values.oidc.roleClaim "groups") (not (has "groups" (splitList " " .Values.oidc.scopes))) -}}
{{- fail "oidc.roleMapping is set but oidc.scopes lacks \"groups\": Dex would put no groups claim in the token and every user would silently get oidc.defaultRole" -}}
{{- end -}}
{{- end -}}
{{- end -}}
