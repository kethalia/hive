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
run "plain_tmux_app" {
  command = plan
  assert {
    condition     = length(coder_app.tmux) == 1 && coder_app.tmux[0].slug == "tmux-default" && coder_app.tmux[0].command == "tmux new-session -A -s default"
    error_message = "Keep the existing tmux app with a plain attach-or-create command."
  }
  assert {
    condition     = strcontains(coder_agent.main.startup_script, "retire(Path.home())") && strcontains(coder_agent.main.startup_script, "e45a0903111e83c29f608989536af754f60b70f4e8974f8aad4ababeb2d287f4")
    error_message = "Include the generated-config retirement before agent startup completes."
  }
}
run "stopped_tmux_app" {
  command = plan
  override_data {
    target = data.coder_workspace.me
    values = { id = "11111111-1111-4111-8111-111111111111", name = "fixture", start_count = 0, access_url = "https://coder.example.test" }
  }
  assert {
    condition     = length(coder_app.tmux) == 0
    error_message = "Do not create a terminal app for a stopped workspace."
  }
}
