# Independent workspace voice signaling, enabled only for the software profile.
# Deployment-owned public issuer and Coder provisioner identity bind this service.
data "coder_parameter" "enable_hive_voice" {
  name         = "enable_hive_voice"
  display_name = "Hive voice signaling"
  description  = "Enable signed Codex voice signaling after Hive configures this workspace."
  type         = "bool"
  default      = "false"
  mutable      = true
}

locals {
  hive_voice_enabled         = data.coder_parameter.enable_hive_voice.value == "true" && local.profile.id == "software"
  hive_voice_label           = "hive-voice--main--${data.coder_workspace.me.name}--${data.coder_workspace_owner.me.name}"
  hive_voice_origin          = "https://${local.hive_voice_label}.${var.hive_coder_app_domain}"
  hive_voice_manifest_sha256 = trimspace(file("${path.module}/assets/voice.manifest.sha256"))
  hive_voice_archive_sha256  = trimspace(file("${path.module}/assets/voice.tar.sha256"))
}

data "external" "hive_voice_build_identity" {
  count   = local.hive_voice_enabled ? 1 : 0
  program = ["sh", "${path.module}/scripts/hive-build-identity.sh"]
  lifecycle {
    postcondition {
      condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", self.result.build_id))
      error_message = "Voice signaling requires the Coder provisioner's build identity."
    }
  }
}

resource "coder_app" "hive_voice" {
  count        = local.hive_voice_enabled ? 1 : 0
  agent_id     = coder_agent.main.id
  slug         = "hive-voice"
  display_name = "Hive voice signaling"
  url          = "http://127.0.0.1:13343"
  subdomain    = true
  share        = "owner"
  hidden       = true
}

locals {
  hive_voice_bootstrap_data = local.hive_voice_enabled ? {
    "hive.kethalia.com/voice-request" = jsonencode({
      schemaVersion  = 1
      imageArchiveSha256   = filesha256("${path.module}/assets/voice.tar.gz")
      imageInstallerSha256 = filesha256("${path.module}/scripts/install-voice.py")
      archiveSha256  = local.hive_voice_archive_sha256
      manifestSha256 = local.hive_voice_manifest_sha256
      config = {
        schemaVersion      = 1
        home               = "/home/coder"
        hiveOrigin         = var.hive_control_origin
        issuerPublicKeyPem = var.hive_issuer_public_key_pem
        issuerKeyId        = var.hive_issuer_key_id
        packageDirectory   = "/home/coder/.local/share/hive/voice/${local.hive_voice_archive_sha256}"
        manifestSha256     = local.hive_voice_manifest_sha256
        port               = 13343
        binding = {
          coderOrigin = trimsuffix(data.coder_workspace.me.access_url, "/")
          ownerId     = data.coder_workspace_owner.me.id
          workspaceId = data.coder_workspace.me.id
          buildId     = data.external.hive_voice_build_identity[0].result.build_id
          agentId     = coder_agent.main.id
          templateId  = data.coder_workspace.me.template_id
          appOrigin   = local.hive_voice_origin
          appId       = coder_app.hive_voice[0].id
        }
      }
    })
  } : {}
}

# The projected request contains public issuer material and image asset pins only.
resource "coder_script" "hive_voice" {
  count              = local.hive_voice_enabled ? 1 : 0
  agent_id           = coder_agent.main.id
  display_name       = "Hive voice signaling service"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/install-voice.sh.tftpl")
  lifecycle {
    precondition {
      condition     = sum([for key, content in local.hive_voice_bootstrap_data : length(base64encode(key)) * 3 / 4 + length(base64encode(content)) * 3 / 4]) <= 16384
      error_message = "Voice request exceeds its annotation capacity."
    }
    precondition {
      condition     = can(regex("^https://[a-z0-9.-]+$", var.hive_control_origin)) && var.hive_issuer_public_key_pem != "" && can(regex("^[A-Za-z0-9._-]{1,64}$", var.hive_issuer_key_id))
      error_message = "Voice signaling requires the deployment's HTTPS origin and public issuer key."
    }
    precondition {
      condition     = length(local.hive_voice_label) <= 63 && can(regex("^[a-z0-9-]+$", local.hive_voice_label))
      error_message = "Voice signaling requires a valid app DNS label of at most 63 characters."
    }
  }
}
