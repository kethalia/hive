import { describe, expect, it } from "vitest";
import { createCloneTerminalProof } from "./clone-terminal-proof";
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
    const { requestTarget: _target, ...identity } = claims;
    expect(verifyTerminalTicket(ticket(), secret, claims, now)).toMatchObject({
      ...identity,
      issuedAt: now,
      expiresAt: now + 30_000,
    });
    expect(verifyTerminalTicket(ticket(), secret, claims, now + 30_000)).toBeNull();
  });
  it("keeps a legal long clone request compact without exposing the path or proof", () => {
    const clonePath = `/home/coder/${Array.from({ length: 5 }, () => "r".repeat(198)).join("/")}`;
    const cloneProof = createCloneTerminalProof(
      {
        workspaceId: "workspace",
        agentId: "agent",
        sessionId: claims.sessionId,
        sessionName: "clone:repo",
        clonePath,
        nowMs: now,
      },
      secret,
    );
    const requestTarget = `/ws?${new URLSearchParams({ agentId: "agent", workspaceId: "workspace", clonePath, cloneProof })}`;
    expect(`wss://${claims.audience}${requestTarget}`.length).toBeLessThan(3000);
    const proof = createTerminalTicket({ ...claims, requestTarget }, secret, now + 60_000, now);
    expect(proof.length).toBeLessThan(1024);
    const payload = JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString());
    expect(payload).not.toHaveProperty("requestTarget");
    expect(payload.requestTargetHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(payload)).not.toContain(clonePath);
    expect(JSON.stringify(payload)).not.toContain(cloneProof);
    expect(verifyTerminalTicket(proof, secret, { ...claims, requestTarget }, now)).not.toBeNull();
    expect(
      verifyTerminalTicket(
        proof,
        secret,
        { ...claims, requestTarget: `${requestTarget}&changed=1` },
        now,
      ),
    ).toBeNull();
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
