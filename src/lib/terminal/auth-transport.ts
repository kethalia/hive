// Tickets are short-lived, bound to one request, and never persisted or placed in URLs.
async function terminalTicket(url: string): Promise<string> {
  const response = await fetch("/api/auth/terminal-ticket", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Terminal authentication unavailable");
  const body = await response.json();
  if (typeof body?.ticket !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(body.ticket))
    throw new Error("Invalid terminal authentication response");
  return body.ticket;
}

export async function terminalAuthProtocols(url: string, protocol: string): Promise<string[]> {
  return [protocol, `hive-ticket.${await terminalTicket(url)}`];
}

export async function fetchTerminal(url: string, options: RequestInit = {}): Promise<Response> {
  const ticket = await terminalTicket(url);
  options.signal?.throwIfAborted();
  return fetch(url, {
    ...options,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { Authorization: `Bearer ${ticket}` },
  });
}
