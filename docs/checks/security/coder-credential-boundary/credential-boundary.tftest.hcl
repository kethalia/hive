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
  target = coder_agent.main
  override_during = plan
  values = { id = "33333333-3333-4333-8333-333333333333", token = "fixture-agent-token", init_script = "printf 'mock-agent'" }
}
run "credential_boundary" {
  command = plan
  assert {
    condition = length(module.coder-login) == (local.profile.id == "software" ? 1 : 0)
    error_message = "Only software may provision owner login."
  }
  assert {
    condition = local.profile.id == "software" ? kubernetes_deployment_v1.workspace[0].spec[0].template[0].spec[0].container[0].command[2] == coder_agent.main.init_script : strcontains(kubernetes_deployment_v1.workspace[0].spec[0].template[0].spec[0].container[0].command[2], "unset CODER_SESSION_TOKEN")
    error_message = "Primary command must be preserved; specialist cleanup must precede agent start."
  }
}
