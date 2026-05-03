{{/*
Expand the name of the chart.
*/}}
{{- define "hive-web.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name (truncated to 63 chars per DNS spec).
If the release name already contains the chart name, the release name is used as-is.
*/}}
{{- define "hive-web.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name + version, used as the helm.sh/chart label.
*/}}
{{- define "hive-web.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every rendered object.
*/}}
{{- define "hive-web.labels" -}}
helm.sh/chart: {{ include "hive-web.chart" . }}
{{ include "hive-web.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: hive
app.kubernetes.io/component: web
{{- end }}

{{/*
Selector labels — IMMUTABLE. Locked to name + instance only;
adding more labels here will break `helm upgrade` after first install.
*/}}
{{- define "hive-web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hive-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name resolver.
*/}}
{{- define "hive-web.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "hive-web.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolve the Secret name supplying envFrom secret references.
Falls back to "<fullname>-secrets" when .Values.existingSecret is empty.
*/}}
{{- define "hive-web.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- printf "%s-secrets" (include "hive-web.fullname" .) }}
{{- end }}
{{- end }}

{{/*
ConfigMap name (always chart-rendered).
*/}}
{{- define "hive-web.configMapName" -}}
{{- printf "%s-config" (include "hive-web.fullname" .) }}
{{- end }}
