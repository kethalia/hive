import { describe, expect, it } from "vitest";
import { signCookie, verifyCookie } from "./cookie";
import { createTerminalTicket, verifyTerminalTicket } from "./terminal-ticket";

const secret = "test-ticket-secret";
const now = 1_000_000;
const claims = {
  sessionId: "victim-session",
  audience: "terminal.example.com",
  origin: "https://hive.example.com",
  requestTarget: "/ws?agentId=agent&workspaceId=workspace",
};
const ticket = () => createTerminalTicket(claims, secret, now + 60_000, now);

describe("terminal tickets", () => {
  it("authorizes only the bound request and caps its lifetime at 30 seconds", () => {
    expect(verifyTerminalTicket(ticket(), secret, claims, now)).toMatchObject({
      ...claims,
      issuedAt: now,
      expiresAt: now + 30_000,
    });
    expect(verifyTerminalTicket(ticket(), secret, claims, now + 30_000)).toBeNull();
  });
  it.each([
    { audience: "another-terminal.example.com" },
    { origin: "https://attacker.example.com" },
    { requestTarget: "/ws?agentId=another&workspaceId=workspace" },
    { requestTarget: "/ws/audio?agentId=agent&workspaceId=workspace" },
  ])("rejects substitution of request authority or target: %o", (change) => {
    expect(verifyTerminalTicket(ticket(), secret, { ...claims, ...change }, now)).toBeNull();
  });
  it("rejects wrong keys, tampering, malformed input, and future issuance", () => {
    expect(verifyTerminalTicket(ticket(), "wrong-key", claims, now)).toBeNull();
    for (const value of ["", "invalid", "a".repeat(5000), `${ticket()}x`, `x${ticket()}`])
      expect(verifyTerminalTicket(value, secret, claims, now)).toBeNull();
    expect(verifyTerminalTicket(ticket(), secret, claims, now - 5001)).toBeNull();
  });
  it("expires with the underlying session and rejects an expired session", () => {
    const short = createTerminalTicket(claims, secret, now + 1000, now);
    expect(verifyTerminalTicket(short, secret, claims, now + 1000)).toBeNull();
    expect(() => createTerminalTicket(claims, secret, now, now)).toThrow();
  });
  it("cannot be replayed as a web cookie and cannot accept a cookie as a ticket", () => {
    expect(verifyCookie(ticket(), secret)).toBeNull();
    expect(
      verifyTerminalTicket(signCookie("victim-session", secret), secret, claims, now),
    ).toBeNull();
  });
});
