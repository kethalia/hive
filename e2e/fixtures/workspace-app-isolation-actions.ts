export async function getWorkspaceAppToolAction(input: unknown) {
  const response = await fetch("/authorize-tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, scenario: window.location.pathname }),
  });
  return response.json();
}

export async function getWorkspaceSessionToolsAction() {
  return {};
}
