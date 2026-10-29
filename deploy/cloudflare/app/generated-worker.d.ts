declare module "*.open-next/worker.js" {
  const handler: {
    fetch(request: Request, env: unknown, context: unknown): Promise<Response>;
  };
  export default handler;
}
