# The engine alone uses Sysbox. The Coder agent stays in its existing non-root,
# capability-free pod with hive-codex-v1 enforced; never move it into Sysbox.
data "coder_parameter" "workspace_docker" {
  count        = contains(["software", "infrastructure"], local.profile.id) ? 1 : 0
  name         = "workspace_docker"
  display_name = "Workspace Docker engine"
  description  = "Create a private Sysbox engine and 20 GiB data disk. Requires the validated Sysbox canary node. Published ports use the engine hostname, not localhost."
  type         = "bool"
  default      = "false"
  mutable      = false
}

locals {
  docker_enabled = try(data.coder_parameter.workspace_docker[0].value == "true", false)
  docker_name    = "coder-${data.coder_workspace.me.id}-docker"
  docker_labels = {
    "app.kubernetes.io/name"     = "coder-workspace-docker"
    "app.kubernetes.io/instance" = local.docker_name
    "com.coder.workspace.id"     = data.coder_workspace.me.id
  }
  docker_node_selector = {
    "hive.kethalia.com/sysbox-stage"   = "canary"
    "hive.kethalia.com/sysbox-version" = "0.7.1"
    "sysbox-runtime"                   = "running"
  }
  docker_engine_image = "docker:29.9.2-dind@sha256:97545b7bab66319a476800a85b008b25c06681733d484909e2a776281e41574f"
}

# Retained while stopped; destroyed only with the owning Coder workspace.
resource "kubernetes_persistent_volume_claim_v1" "docker" {
  count = local.docker_enabled ? 1 : 0
  metadata {
    name      = local.docker_name
    namespace = "coder"
    labels    = local.docker_labels
  }
  wait_until_bound = false
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "longhorn"
    resources {
      requests = { storage = "20Gi" }
    }
  }
}

# A separate manifest is needed because provider 2.38's typed pod schema cannot
# express hostUsers:false. Keep explicit user namespaces and engine-only policies.
resource "kubernetes_manifest" "docker" {
  count = local.docker_enabled ? data.coder_workspace.me.start_count : 0
  manifest = jsondecode(templatefile("${path.module}/scripts/docker-engine.json.tftpl", {
    name          = local.docker_name
    workspace_id  = data.coder_workspace.me.id
    home_claim    = kubernetes_persistent_volume_claim_v1.home.metadata[0].name
    docker_claim  = kubernetes_persistent_volume_claim_v1.docker[0].metadata[0].name
    image         = local.docker_engine_image
    script_b64    = base64encode(file("${path.module}/scripts/docker-engine.sh"))
    node_selector = jsonencode(local.docker_node_selector)
    labels        = jsonencode(local.docker_labels)
  }))
  # The agent pod seeds the socket directory and chooses the node first.
  depends_on = [kubernetes_deployment_v1.workspace, kubernetes_network_policy_v1.docker]
}

# DNS for published development ports; dockerd itself has no TCP listener.
resource "kubernetes_service_v1" "docker" {
  count = local.docker_enabled ? data.coder_workspace.me.start_count : 0
  metadata {
    name      = local.docker_name
    namespace = "coder"
    labels    = local.docker_labels
  }
  spec {
    cluster_ip = "None"
    selector   = local.docker_labels
    port {
      name        = "published-ports"
      port        = 8080
      target_port = 8080
    }
  }
}

resource "kubernetes_network_policy_v1" "docker" {
  count = local.docker_enabled ? data.coder_workspace.me.start_count : 0
  metadata {
    name      = local.docker_name
    namespace = "coder"
    labels    = local.docker_labels
  }
  spec {
    pod_selector { match_labels = local.docker_labels }
    policy_types = ["Ingress", "Egress"]
    ingress {
      from {
        pod_selector {
          match_labels = {
            "app.kubernetes.io/name"     = "coder-workspace"
            "app.kubernetes.io/instance" = "coder-${data.coder_workspace.me.id}"
          }
        }
      }
    }
    egress {
      to {
        namespace_selector { match_labels = { "kubernetes.io/metadata.name" = "kube-system" } }
        pod_selector { match_labels = { "k8s-app" = "kube-dns" } }
      }
      ports {
        protocol = "UDP"
        port     = "53"
      }
      ports {
        protocol = "TCP"
        port     = "53"
      }
    }
    egress {
      to {
        ip_block {
          cidr = "0.0.0.0/0"
          except = [
            "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
            "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4",
          ]
        }
      }
      ports {
        protocol = "TCP"
        port     = "443"
      }
      ports {
        protocol = "TCP"
        port     = "80"
      }
    }
  }
}

# The baseline agent policy excludes private pod CIDRs. Add only this workspace's
# engine as an egress destination; other engines and cluster services stay denied.
resource "kubernetes_network_policy_v1" "docker_client" {
  count = local.docker_enabled ? data.coder_workspace.me.start_count : 0
  metadata {
    name      = "${local.docker_name}-client"
    namespace = "coder"
    labels    = local.docker_labels
  }
  spec {
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name"     = "coder-workspace"
        "app.kubernetes.io/instance" = "coder-${data.coder_workspace.me.id}"
      }
    }
    policy_types = ["Egress"]
    egress {
      to {
        pod_selector { match_labels = local.docker_labels }
      }
    }
  }
}
