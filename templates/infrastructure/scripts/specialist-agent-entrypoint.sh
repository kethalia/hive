#!/bin/sh

# Clear inherited owner authentication before the agent can launch any process.
# Its own CODER_AGENT_TOKEN continues to serve workspace-local and Git auth.
unset CODER_SESSION_TOKEN || exit 1
python3 - '${coder_access_url_b64}' '${workspace_profile_b64}' <<'HIVE_CODER_CLEANUP' || exit 1
${coder_credential_cleanup_script}
HIVE_CODER_CLEANUP

${agent_init_script}
