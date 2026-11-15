import { randomUUID } from "node:crypto";
import { SESSION_MAX_AGE_SECONDS } from "@hive/auth";
import type { Prisma, PrismaClient } from "@hive/db";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth } from "better-auth/minimal";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { fetchCoderApi } from "./coder-fetch";
import { getCoderOAuthConfig } from "./coder-oauth-config";
import { exchangeCoderOAuth, verifyCoderOAuthIdentity } from "./coder-oauth-provider";

type Database = PrismaClient | Prisma.TransactionClient;
export type CoderAuthOptions = {
  send?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  refreshing?: boolean;
  expectedCoderUserId?: string;
  onRefreshError?: (error: unknown) => void;
};

/** Auth instances capture one request's database and provider deadline. */
export function createCoderAuth(db: Database, options: CoderAuthOptions = {}) {
  const config = getCoderOAuthConfig();
  const send = options.send ?? fetchCoderApi;
  const secure = config.publicOrigin.startsWith("https://");
  const cookieName = (name: string) => `${secure ? "__Host-" : ""}hive-${name}`;
  const activateAccount = async (account: {
    id: string;
    userId: string;
    accessToken?: string | null;
  }) => {
    if (options.refreshing || !account.accessToken) return;
    if (!("$transaction" in db)) throw Error("coder_oauth_database_scope");
    await db.$transaction(async (tx) => {
      const changed = await tx.coderOAuthAccount.updateMany({
        where: { id: account.id, accessToken: account.accessToken, refreshState: "idle" },
        data: {
          refreshState: "idle",
          refreshHolder: null,
          refreshUntil: null,
        },
      });
      if (changed.count !== 1) throw Error("coder_oauth_grant_changed");
      await tx.user.update({ where: { id: account.userId }, data: { authMode: "oauth" } });
    });
  };
  return betterAuth({
    appName: "Hive",
    baseURL: config.publicOrigin,
    basePath: "/api/auth",
    secret: config.secret,
    database: prismaAdapter(db, { provider: "postgresql", transaction: !options.refreshing }),
    trustedOrigins: [config.publicOrigin],
    emailAndPassword: { enabled: false },
    user: {
      modelName: "user",
      fields: { name: "username" },
      additionalFields: {
        coderUrl: { type: "string", required: true },
        coderUserId: { type: "string", required: true },
      },
      validateUserInfo: ({ user, source }) => {
        const profile = source.oauth?.profile;
        if (
          source.oauth?.providerId !== "coder" ||
          !profile ||
          profile.coderUrl !== config.coderOrigin ||
          typeof profile.coderUserId !== "string" ||
          ("coderUserId" in user && user.coderUserId !== profile.coderUserId)
        )
          return {
            error: "coder_identity_mismatch",
            errorDescription: "Reconnect your Coder account.",
          };
      },
    },
    session: {
      modelName: "session",
      fields: { token: "authToken" },
      expiresIn: SESSION_MAX_AGE_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        sessionId: {
          type: "string",
          required: true,
          input: false,
          defaultValue: () => randomUUID(),
        },
      },
    },
    account: {
      modelName: "coderOAuthAccount",
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
      additionalFields: {
        refreshState: { type: "string", input: false },
        refreshHolder: { type: "string", required: false, input: false },
        refreshUntil: { type: "date", required: false, input: false },
      },
    },
    verification: { modelName: "bAVerification" },
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: false,
      cookiePrefix: "hive-auth",
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: "lax", path: "/" },
      cookies: {
        session_token: { name: cookieName("auth") },
        oauth_state: { name: cookieName("oauth-state") },
        state: { name: cookieName("oauth-state") },
      },
    },
    logger: { disabled: true },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            await db.session.deleteMany({ where: { userId: session.userId, authToken: null } });
            return { data: session };
          },
        },
      },
      account: {
        create: { after: activateAccount },
        update: {
          before: async (account) => {
            if (options.refreshing) return { data: account };
            // Callback credentials and lease reset share the same atomic write.
            return {
              data: {
                ...account,
                refreshState: "idle",
                refreshHolder: null,
                refreshUntil: null,
              },
            };
          },
          after: activateAccount,
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: "coder",
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            authorizationUrl: `${config.coderOrigin}/oauth2/authorize`,
            tokenUrl: `${config.coderOrigin}/oauth2/tokens`,
            scopes: ["coder:all"],
            pkce: true,
            overrideUserInfo: true,
            mapProfileToUser: (profile) => ({
              coderUrl: profile.coderUrl,
              coderUserId: profile.coderUserId,
            }),
            getToken: async ({ code, codeVerifier, redirectURI }) => {
              if (!codeVerifier || redirectURI !== config.callbackUrl)
                throw Error("coder_oauth_flow_invalid");
              const tokens = await exchangeCoderOAuth(
                config,
                {
                  grant_type: "authorization_code",
                  code,
                  code_verifier: codeVerifier,
                  redirect_uri: redirectURI,
                },
                send,
                options.signal,
              );
              if (!tokens.refreshToken) throw Error("coder_oauth_refresh_missing");
              return {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                accessTokenExpiresAt: tokens.expiresAt,
                tokenType: "bearer",
                scopes: ["coder:all"],
              };
            },
            getUserInfo: async (tokens) => {
              if (!tokens.accessToken) return null;
              const user = await verifyCoderOAuthIdentity(
                config,
                tokens.accessToken,
                send,
                options.signal,
              );
              const existing = await db.user.findUnique({
                where: {
                  coderUrl_coderUserId: { coderUrl: config.coderOrigin, coderUserId: user.id },
                },
              });
              if (existing)
                await db.coderOAuthAccount.upsert({
                  where: { userId_providerId: { userId: existing.id, providerId: "coder" } },
                  create: {
                    userId: existing.id,
                    providerId: "coder",
                    accountId: `${config.coderOrigin}|${user.id}`,
                  },
                  update: {},
                });
              return {
                id: `${config.coderOrigin}|${user.id}`,
                name: user.username,
                email: user.email,
                emailVerified: false,
                coderUrl: config.coderOrigin,
                coderUserId: user.id,
              };
            },
          },
        ],
      }),
      {
        id: "hive-coder-provider-transport",
        init: (context) => ({
          context: {
            socialProviders: context.socialProviders.map((provider) =>
              provider.id !== "coder"
                ? provider
                : {
                    ...provider,
                    refreshAccessToken: async (refreshToken: string) => {
                      try {
                        const tokens = await exchangeCoderOAuth(
                          config,
                          { grant_type: "refresh_token", refresh_token: refreshToken },
                          send,
                          options.signal,
                        );
                        if (!tokens.refreshToken) throw Error("coder_oauth_refresh_missing");
                        const identity = await verifyCoderOAuthIdentity(
                          config,
                          tokens.accessToken,
                          send,
                          options.signal,
                        );
                        if (
                          options.expectedCoderUserId &&
                          identity.id !== options.expectedCoderUserId
                        )
                          throw Error("coder_identity_mismatch");
                        return {
                          accessToken: tokens.accessToken,
                          refreshToken: tokens.refreshToken,
                          accessTokenExpiresAt: tokens.expiresAt,
                          tokenType: "bearer",
                          scopes: ["coder:all"],
                        };
                      } catch (error) {
                        options.onRefreshError?.(error);
                        throw error;
                      }
                    },
                  },
            ),
          },
        }),
      },
    ],
  });
}
