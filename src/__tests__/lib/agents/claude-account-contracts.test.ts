import { expect, it } from "vitest";
import { claudeAccountStatusSchema } from "@/lib/agents/claude-account-contracts";

const url =
  "https://claude.com/cai/oauth/authorize?state=fixture-state-complete&code_challenge=full-pkce-challenge&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback";
const status = (verificationUrl: string) => ({
  scope: "workspace-cli",
  lifetimeId: "00000000-0000-4000-8000-000000000001",
  generation: 1,
  state: "pending",
  pending: { verificationUrl, codeSubmitted: false, expiresAt: 1_900_000_000_000 },
});

it("preserves the official OAuth query and encoded HTTPS redirect byte-for-byte", () => {
  const input = status(url);
  expect(claudeAccountStatusSchema.parse(input)).toEqual(input);
  expect(claudeAccountStatusSchema.parse(input).pending?.verificationUrl).toBe(url);
});

it("rejects literal terminal controls before URL normalization can hide them", () => {
  for (const code of [
    ...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
  ]) {
    const control = String.fromCharCode(code);
    expect(claudeAccountStatusSchema.safeParse(status(url + control)).success).toBe(false);
    expect(claudeAccountStatusSchema.safeParse(status(url + control + url)).success).toBe(false);
  }
  expect(claudeAccountStatusSchema.safeParse(status(url + url)).success).toBe(false);
  expect(
    claudeAccountStatusSchema.safeParse(status(`${url}\u001b\\${url}\u001b]8;;\u001b\\`)).success,
  ).toBe(false);
});
