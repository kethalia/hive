resource "coder_app" "copy_web" {
  agent_id     = coder_agent.main.id
  slug         = "copy-web"
  display_name = "COPY Web (run copy web)"
  url          = "http://localhost:8787"
  icon         = "/icon/terminal.svg"
  subdomain    = true
  share        = "owner"
  order        = 2

  # This is a manual preview, so it has no healthcheck while the server is stopped.
}
