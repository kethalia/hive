import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage<Request>();
export const runWithRequest = <T>(request: Request, callback: () => T) =>
  requests.run(request, callback);
export async function headers(): Promise<Headers> {
  return new Headers(requests.getStore()?.headers);
}
export async function cookies() {
  const header = requests.getStore()?.headers.get("cookie") || "";
  const pairs = header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index < 0
      ? []
      : [{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() }];
  });
  return {
    get: (name: string) => pairs.find((value) => value.name === name),
    getAll: (name: string) => pairs.filter((value) => value.name === name),
  };
}
