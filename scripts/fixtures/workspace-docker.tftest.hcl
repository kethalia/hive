mock_provider "coder" {
  mock_data "coder_workspace" {
    defaults = { id = "11111111-1111-4111-8111-111111111111", name = "fixture", start_count = 1, access_url = "https://coder.example.test" }
  }
  mock_data "coder_workspace_owner" {
    defaults = { id = "22222222-2222-4222-8222-222222222222", name = "fixture-owner", full_name = "Fixture Owner", email = "owner@example.test", session_token = "fixture-owner-session" }
  }
  mock_resource "coder_agent" {
    defaults = { id = "33333333-3333-4333-8333-333333333333", token = "fixture-agent-token", init_script = "printf 'mock-agent'" }
  }
}
mock_provider "kubernetes" {}
override_resource {
  target          = coder_agent.main
  override_during = plan
  values          = { id = "33333333-3333-4333-8333-333333333333", token = "fixture-agent-token", init_script = "printf 'mock-agent'" }
}

run "docker_disabled" {
  command = plan
  override_data {
    target = data.coder_parameter.workspace_docker[0]
    values = { value = "false" }
  }
  assert {
    condition = length(kubernetes_manifest.docker) == 0 && length(kubernetes_persistent_volume_claim_v1.docker) == 0 && length(kubernetes_network_policy_v1.docker_client) == 0
    error_message = "Disabled workspaces must not provision Docker resources or relax network policies."
  }
}
run "docker_enabled" {
  command = plan
  override_data {
    target = data.coder_parameter.workspace_docker[0]
    values = { value = "true" }
  }
  assert {
    condition = length(kubernetes_manifest.docker) == 1 && kubernetes_manifest.docker[0].manifest.spec.template.spec.hostUsers == false
    error_message = "The engine must use an explicit user namespace."
  }
  assert {
    condition = kubernetes_deployment_v1.workspace[0].spec[0].template[0].spec[0].container[0].security_context[0].run_as_non_root && !kubernetes_deployment_v1.workspace[0].spec[0].template[0].spec[0].container[0].security_context[0].allow_privilege_escalation
    error_message = "Docker must not weaken the agent process security context."
  }
  assert {
    condition = length(kubernetes_persistent_volume_claim_v1.docker) == 1 && length(kubernetes_network_policy_v1.docker_client) == 1
    error_message = "An enabled workspace needs its own persistent engine and explicit client policy."
  }
}
run "docker_stopped" {
  command = plan
  override_data {
    target = data.coder_parameter.workspace_docker[0]
    values = { value = "true" }
  }
  override_data {
    target = data.coder_workspace.me
    values = { id = "11111111-1111-4111-8111-111111111111", name = "fixture", start_count = 0, access_url = "https://coder.example.test" }
  }
  assert {
    condition = length(kubernetes_manifest.docker) == 0 && length(kubernetes_service_v1.docker) == 0 && length(kubernetes_persistent_volume_claim_v1.docker) == 1 && kubernetes_persistent_volume_claim_v1.home.metadata[0].name == "coder-11111111-1111-4111-8111-111111111111-home"
    error_message = "Stopping must remove engine workloads and preserve both disks."
  }
}
