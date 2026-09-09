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
