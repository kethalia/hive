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
mock_provider "external" {}
override_resource {
  target          = coder_agent.main
  override_during = plan
  values          = { id = "33333333-3333-4333-8333-333333333333", token = "fixture-agent-token", init_script = "printf 'mock-agent'" }
}

run "running_workspace" {
  command = plan
  assert {
    condition     = coder_script.tools_ai.run_on_start && coder_script.tools_ai.start_blocks_login && coder_script.tools_ai.script == file("${path.module}/scripts/tools-ai.sh")
    error_message = "Hive's AI Tools startup script must install and refresh the ordinary CLI."
  }
  assert {
    condition     = coder_app.codex_cli.command == "cd /home/coder && exec codex" && coder_app.codex_cli.slug == "codex-cli"
    error_message = "Keep Hive's native Codex launcher."
  }
}

run "stopped_workspace" {
  command = plan
  override_data {
    target = data.coder_workspace.me
    values = { id = "11111111-1111-4111-8111-111111111111", name = "fixture", start_count = 0, access_url = "https://coder.example.test" }
  }
  assert {
    condition     = length(kubernetes_deployment_v1.workspace) == 0
    error_message = "A stopped workspace must have no running deployment."
  }
  assert {
    condition     = coder_app.codex_cli.command == "cd /home/coder && exec codex" && coder_app.codex_cli.slug == "codex-cli"
    error_message = "The native Codex launcher must retain its ordinary CLI entry point."
  }
}
