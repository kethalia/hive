import type { CoderCredentialSource } from "@hive/auth";

/** Keep OAuth CLI requests independent of the host's persisted owner login. */
export async function prepareCoderCliEnvironment(options: {
  coderUrl?: string;
  token?: string;
  credentialSource?: CoderCredentialSource;
}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.coderUrl ? { CODER_URL: options.coderUrl } : {}),
    ...(options.token ? { CODER_SESSION_TOKEN: options.token } : {}),
  };
  if (options.credentialSource !== "oauth") return { env, cleanup: async () => {} };
  if (!options.coderUrl || !options.token) throw new Error("OAuth CLI credentials required");
  const [{ mkdtemp, rm }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "hive-coder-oauth-"));
  delete env.CODER_SESSION_TOKEN;
  delete env.CODER_HEADER_COMMAND;
  env.CODER_HEADER = `Authorization=Bearer ${options.token}`;
  env.CODER_CONFIG_DIR = directory;
  return { env, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
