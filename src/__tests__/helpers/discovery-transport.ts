export const discoveryTransport = {
  readDiscovery: async (resource: string, target: { workspaceId?: string } = {}) => {
    let response: { data?: unknown; serverError?: string } | undefined;
    const input = { workspaceId: target.workspaceId! };
    switch (resource) {
      case "repositories": {
        const { listGitClonesAction } = await import("@/lib/actions/git-clones");
        const result = await listGitClonesAction(input);
        if (result?.data?.ok) return result.data.tree;
        throw new Error(
          result?.serverError ?? result?.data?.message ?? "Could not read repositories.",
        );
      }
      case "agent-tools": {
        const { inspectAgentToolsAction } = await import("@/lib/actions/agent-tools");
        response = await inspectAgentToolsAction(input);
        break;
      }
      case "templates": {
        const { listTemplateStatusesAction } = await import("@/lib/actions/templates");
        response = await listTemplateStatusesAction();
        break;
      }
      default: {
        const actions = await import("@/lib/actions/workspaces");
        if (resource === "workspaces") response = await actions.listWorkspacesAction();
        if (resource === "template-options")
          response = await actions.listWorkspaceTemplatesAction();
        if (resource === "agent") response = await actions.getWorkspaceAgentAction(input);
        if (resource === "sessions") response = await actions.getWorkspaceSessionsAction(input);
      }
    }
    if (response?.data !== undefined) return response.data;
    throw new Error(response?.serverError ?? "Could not refresh workspace data.");
  },
};
