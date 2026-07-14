"use server";

import type { NavigationFavorite, NavigationFavoriteKind } from "@hive/db";
import { getDb } from "@hive/db";
import { z } from "zod";
import { SAFE_IDENTIFIER_RE } from "@/lib/constants";
import {
  isExpectedCloneSessionKey,
  isSafeCloneRelativePath,
  isSafePublicCloneIdentifier,
} from "@/lib/git/clone-public-identifiers";
import { isCloneTerminalSessionName } from "@/lib/git/clone-terminal-session";
import { authActionClient } from "@/lib/safe-action";

const FAVORITE_UNAVAILABLE_MESSAGE = "Favorites are unavailable. Refresh and try again.";
const LABEL_MAX_LENGTH = 120;
const LABEL_INPUT_MAX_LENGTH = 500;

export interface NavigationFavoriteDto {
  id: string;
  kind: NavigationFavoriteKind;
  workspaceId: string;
  targetKey: string;
  label: string | null;
  relativePath: string | null;
  position?: number;
  createdAt: string;
}

const workspaceIdSchema = z
  .string()
  .trim()
  .min(1, "workspaceId is required")
  .max(256, "workspaceId is too long")
  .refine(hasNoNullByte, "workspaceId is invalid");

const terminalTargetKeySchema = z
  .string()
  .trim()
  .min(1, "targetKey is required")
  .max(256, "targetKey is too long")
  .refine((value) => SAFE_IDENTIFIER_RE.test(value), "targetKey is invalid")
  .refine(
    (value) => !isCloneTerminalSessionName(value),
    "clone terminal sessions cannot be favorited as terminal sessions",
  );

const gitTargetKeySchema = z
  .string()
  .trim()
  .min(1, "targetKey is required")
  .max(512, "targetKey is too long")
  .refine(isExpectedCloneSessionKey, "targetKey is invalid");

const gitRelativePathSchema = z
  .string()
  .trim()
  .min(1, "relativePath is required")
  .max(512, "relativePath is too long")
  .refine(isSafeCloneRelativePath, "relativePath must be a root-relative clone path");

const labelSchema = z
  .string()
  .max(LABEL_INPUT_MAX_LENGTH, "label is too long")
  .refine(isSafeDisplayLabel, "label contains unsupported content")
  .optional();

const listNavigationFavoritesSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    kind: z.enum(["terminal", "git"]).optional(),
  })
  .strict();

const upsertNavigationFavoriteSchema = z.union([
  z
    .object({
      kind: z.literal("terminal"),
      workspaceId: workspaceIdSchema,
      targetKey: terminalTargetKeySchema,
      label: labelSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      workspaceId: workspaceIdSchema,
      targetKey: gitTargetKeySchema,
      relativePath: gitRelativePathSchema,
      label: labelSchema,
    })
    .strict()
    .refine(
      ({ targetKey, relativePath }) =>
        isSafePublicCloneIdentifier({ cloneSessionKey: targetKey, relativePath }),
      "Git favorite identifier is invalid",
    ),
]);

const removeNavigationFavoriteSchema = z
  .object({
    kind: z.enum(["terminal", "git"]),
    workspaceId: workspaceIdSchema,
    targetKey: z.string().trim().min(1, "targetKey is required").max(512, "targetKey is too long"),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind === "terminal") {
      if (
        !SAFE_IDENTIFIER_RE.test(input.targetKey) ||
        isCloneTerminalSessionName(input.targetKey)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetKey"],
          message: "targetKey is invalid",
        });
      }
      return;
    }

    if (!isExpectedCloneSessionKey(input.targetKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetKey"],
        message: "targetKey is invalid",
      });
    }
  });

const reorderNavigationFavoritesSchema = z
  .object({ favoriteIds: z.array(z.string().min(1)).max(200) })
  .strict()
  .refine((input) => new Set(input.favoriteIds).size === input.favoriteIds.length, {
    message: "favoriteIds must be unique",
  });

export const listNavigationFavoritesAction = authActionClient
  .inputSchema(listNavigationFavoritesSchema)
  .action(async ({ parsedInput, ctx }): Promise<NavigationFavoriteDto[]> => {
    try {
      const db = getDb();
      const rows = await db.navigationFavorite.findMany({
        where: {
          userId: ctx.user.id,
          workspaceId: parsedInput.workspaceId,
          ...(parsedInput.kind ? { kind: parsedInput.kind } : {}),
        },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });

      return rows.map(serializeFavorite);
    } catch (error) {
      logFavoriteError("list", error);
      throw new Error(FAVORITE_UNAVAILABLE_MESSAGE);
    }
  });

export const upsertNavigationFavoriteAction = authActionClient
  .inputSchema(upsertNavigationFavoriteSchema)
  .action(async ({ parsedInput, ctx }): Promise<NavigationFavoriteDto> => {
    try {
      const db = getDb();
      const label = normalizeLabel(parsedInput.label);
      const relativePath = parsedInput.kind === "git" ? parsedInput.relativePath : null;
      const row = await db.navigationFavorite.upsert({
        where: {
          userId_kind_workspaceId_targetKey: {
            userId: ctx.user.id,
            kind: parsedInput.kind,
            workspaceId: parsedInput.workspaceId,
            targetKey: parsedInput.targetKey,
          },
        },
        update: {
          label,
          relativePath,
        },
        create: {
          userId: ctx.user.id,
          kind: parsedInput.kind,
          workspaceId: parsedInput.workspaceId,
          targetKey: parsedInput.targetKey,
          label,
          relativePath,
        },
      });

      return serializeFavorite(row);
    } catch (error) {
      logFavoriteError("upsert", error);
      throw new Error(FAVORITE_UNAVAILABLE_MESSAGE);
    }
  });

export const removeNavigationFavoriteAction = authActionClient
  .inputSchema(removeNavigationFavoriteSchema)
  .action(async ({ parsedInput, ctx }): Promise<{ success: true }> => {
    try {
      const db = getDb();
      await db.navigationFavorite.deleteMany({
        where: {
          userId: ctx.user.id,
          kind: parsedInput.kind,
          workspaceId: parsedInput.workspaceId,
          targetKey: parsedInput.targetKey,
        },
      });

      return { success: true as const };
    } catch (error) {
      logFavoriteError("remove", error);
      throw new Error(FAVORITE_UNAVAILABLE_MESSAGE);
    }
  });

export const reorderNavigationFavoritesAction = authActionClient
  .inputSchema(reorderNavigationFavoritesSchema)
  .action(async ({ parsedInput, ctx }): Promise<{ success: true }> => {
    try {
      const db = getDb();
      const owned = await db.navigationFavorite.findMany({
        where: { userId: ctx.user.id, id: { in: parsedInput.favoriteIds } },
        select: { id: true },
      });
      if (owned.length !== parsedInput.favoriteIds.length) {
        throw new Error("favorite_order_scope_mismatch");
      }
      await db.$transaction(
        parsedInput.favoriteIds.map((id, position) =>
          db.navigationFavorite.updateMany({
            where: { id, userId: ctx.user.id },
            data: { position },
          }),
        ),
      );
      return { success: true };
    } catch (error) {
      logFavoriteError("reorder", error);
      throw new Error(FAVORITE_UNAVAILABLE_MESSAGE);
    }
  });

function serializeFavorite(row: NavigationFavorite): NavigationFavoriteDto {
  if (
    !row ||
    typeof row.id !== "string" ||
    !isNavigationFavoriteKind(row.kind) ||
    typeof row.workspaceId !== "string" ||
    typeof row.targetKey !== "string" ||
    typeof row.position !== "number" ||
    !(row.createdAt instanceof Date)
  ) {
    throw new Error("navigation_favorite_row_malformed");
  }

  return {
    id: row.id,
    kind: row.kind,
    workspaceId: row.workspaceId,
    targetKey: row.targetKey,
    label: typeof row.label === "string" ? row.label : null,
    relativePath: typeof row.relativePath === "string" ? row.relativePath : null,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}

function isNavigationFavoriteKind(kind: unknown): kind is NavigationFavoriteKind {
  return kind === "terminal" || kind === "git";
}

function normalizeLabel(label: string | undefined): string | null {
  const normalized = label?.trim().slice(0, LABEL_MAX_LENGTH) ?? "";
  return normalized.length > 0 ? normalized : null;
}

function hasNoNullByte(value: string): boolean {
  return !value.includes("\0");
}

function isSafeDisplayLabel(value: string): boolean {
  const trimmedValue = value.trim();
  if (!hasNoNullByte(trimmedValue) || /[\r\n]/.test(trimmedValue)) {
    return false;
  }

  if (!trimmedValue) {
    return true;
  }

  if (
    trimmedValue.startsWith("/") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmedValue) ||
    /cloneProof=/i.test(trimmedValue)
  ) {
    return false;
  }

  return true;
}

function logFavoriteError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.name : typeof error;
  console.error(`[navigation-favorites] ${operation} failed (${reason})`);
}
