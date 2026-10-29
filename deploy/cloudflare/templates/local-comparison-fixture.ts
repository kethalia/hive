// Local workerd validation only. No deployment configuration imports this fixture.
import { hashLocalTemplate, hashRemoteTar } from "../../../src/lib/templates/staleness";

type Environment = { PROOF_BEARER: string };
export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`)
      return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const name = new URL(request.url).searchParams.get("name") ?? "";
    const input = await request.arrayBuffer();
    if (input.byteLength > 1024 * 1024) return new Response(null, { status: 413 });
    try {
      const [localHash, remoteHash] = await Promise.all([
        hashLocalTemplate(name),
        hashRemoteTar(Buffer.from(input)),
      ]);
      return Response.json({ localHash, remoteHash, stale: localHash !== remoteHash });
    } catch {
      return Response.json({ rejected: true }, { status: 422 });
    }
  },
};
