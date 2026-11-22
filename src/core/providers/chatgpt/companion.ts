/**
 * Verified per-account Codex companion pairing for Sign in with ChatGPT
 * (`chatgpt/<id>`).
 *
 * Security & correctness rules:
 * - Never scrape `~/.codex/auth.json` or copy credentials directly.
 * - Always read account & rate-limit metadata through `codex app-server`
 *   (`account/read` and `account/rateLimits/read`) and verify against the
 *   cryptographically verified OIDC `id_token` (`ChatGptVerifiedIdentity`).
 * - Never silently pair by email alone when workspace/account IDs cannot be
 *   cross-checked (one email can own multiple workspaces such as Personal + Business).
 */
import type { RateLimitWindow } from "../spi.js";
import type { JsonRpcPeer } from "../stdio.js";
import { asRecord, asString, CODEX_METHODS } from "../codex/protocol.js";
import { codexWindowsOf } from "../codex/usage.js";
import type { ChatGptVerifiedIdentity } from "./oauth.js";

export interface CodexCompanionAccount {
  readonly type: string | null;
  readonly email: string | null;
  readonly planType: string | null;
  readonly workspaceName: string | null;
  readonly userId: string | null;
}

export interface CodexCompanionRateLimits {
  readonly accountId: string | null;
  readonly windows: readonly RateLimitWindow[];
}

export interface CodexCompanionProbeResult {
  readonly account: CodexCompanionAccount;
  readonly rateLimits: CodexCompanionRateLimits;
}

export interface CodexCompanionVerifyResult {
  readonly verified: boolean;
  readonly needsConfirmation: boolean;
  readonly reason: string | null;
  readonly codexEmail: string | null;
  readonly codexPlanType: string | null;
  readonly codexWorkspaceName: string | null;
  readonly codexAccountId: string | null;
}

function normEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Compare a verified Sign in with ChatGPT OIDC identity against a Codex
 * companion's live `account/read` and `account/rateLimits/read` responses.
 */
export function verifyCodexCompanion(
  identity: ChatGptVerifiedIdentity,
  codexAccount: CodexCompanionAccount,
  codexRateLimits: CodexCompanionRateLimits,
  options: { readonly confirmWorkspace?: boolean | undefined } = {},
): CodexCompanionVerifyResult {
  const base = {
    codexEmail: codexAccount.email,
    codexPlanType: codexAccount.planType,
    codexWorkspaceName: codexAccount.workspaceName,
    codexAccountId: codexRateLimits.accountId,
  };

  if (codexAccount.type?.toLowerCase() !== "chatgpt") {
    return {
      ...base,
      verified: false,
      needsConfirmation: false,
      reason: "The Codex CLI at this CODEX_HOME is not signed in with a ChatGPT account. Run `codex login` there first.",
    };
  }

  const oidcEmail = normEmail(identity.email);
  const codexEmail = normEmail(codexAccount.email);
  if (oidcEmail && codexEmail && oidcEmail !== codexEmail) {
    return {
      ...base,
      verified: false,
      needsConfirmation: false,
      reason: `Email mismatch: Sign in with ChatGPT is ${identity.email}, while Codex is signed in as ${codexAccount.email}.`,
    };
  }

  const oidcAccountId = normId(identity.accountId);
  const codexAccountId = normId(codexRateLimits.accountId);
  if (oidcAccountId && codexAccountId && oidcAccountId !== codexAccountId) {
    return {
      ...base,
      verified: false,
      needsConfirmation: false,
      reason: `Workspace/account mismatch: ChatGPT account ID (${oidcAccountId}) does not match Codex account ID (${codexAccountId}).`,
    };
  }

  const oidcWorkspace = normId(identity.workspaceName)?.toLowerCase() ?? null;
  const codexWorkspace = normId(codexAccount.workspaceName)?.toLowerCase() ?? null;
  if (oidcWorkspace && codexWorkspace && oidcWorkspace !== codexWorkspace) {
    return {
      ...base,
      verified: false,
      needsConfirmation: false,
      reason: `Workspace mismatch: ChatGPT workspace is "${identity.workspaceName}", while Codex is in "${codexAccount.workspaceName}".`,
    };
  }

  const oidcUserId = normId(identity.userId);
  const codexUserId = normId(codexAccount.userId);
  const accountIdMatched = Boolean(oidcAccountId && codexAccountId && oidcAccountId === codexAccountId);
  const userIdMatched = Boolean(oidcUserId && codexUserId && oidcUserId === codexUserId);
  const emailMatched = Boolean(oidcEmail && codexEmail && oidcEmail === codexEmail && identity.emailVerified);

  // Automatic verification requires matching email (when present) AND a matching
  // non-email identifier (accountId or userId) so Personal vs Business workspaces
  // under the same email are never silently linked.
  if (accountIdMatched || (userIdMatched && (!oidcAccountId || !codexAccountId))) {
    return {
      ...base,
      verified: true,
      needsConfirmation: false,
      reason: null,
    };
  }

  if (emailMatched) {
    if (options.confirmWorkspace === true) {
      return {
        ...base,
        verified: true,
        needsConfirmation: false,
        reason: null,
      };
    }
    const wsDesc = codexAccount.workspaceName
      ? `workspace "${codexAccount.workspaceName}"`
      : codexAccount.planType
        ? `${codexAccount.planType} workspace`
        : "this workspace";
    return {
      ...base,
      verified: false,
      needsConfirmation: true,
      reason: `Email ${codexAccount.email} matches, but workspace ID could not be cross-checked automatically. Confirm pairing with Codex ${wsDesc}.`,
    };
  }

  return {
    ...base,
    verified: false,
    needsConfirmation: false,
    reason: "Could not verify that this Codex login belongs to the same ChatGPT account.",
  };
}

/** Read account and rate-limit metadata from a live `codex app-server` peer. */
export async function probeCodexCompanion(peer: JsonRpcPeer): Promise<CodexCompanionProbeResult> {
  const accountResp = asRecord(await peer.request(CODEX_METHODS.accountRead, {}, 10_000));
  const accountRaw = asRecord(accountResp?.account);
  const limitsRaw = asRecord(await peer.request(CODEX_METHODS.rateLimitsRead, {}, 10_000));
  const buckets = asRecord(limitsRaw?.rateLimitsByLimitId);
  const snapshot = asRecord(buckets?.codex) ?? asRecord(limitsRaw?.rateLimits);

  const account: CodexCompanionAccount = {
    type: asString(accountRaw?.type) ?? null,
    email: asString(accountRaw?.email) ?? null,
    planType: asString(accountRaw?.planType) ?? null,
    workspaceName: asString(accountRaw?.workspaceName) ?? null,
    // `GetAccountResponse` puts `userId` at the top level, alongside `account`.
    userId: asString(accountResp?.userId) ?? asString(accountRaw?.userId) ?? null,
  };
  const accountId =
    asString(snapshot?.accountId) ??
    asString(limitsRaw?.accountId) ??
    asString(accountRaw?.accountId) ??
    null;
  const windows = snapshot
    ? codexWindowsOf({
        limitId: asString(snapshot.limitId) ?? undefined,
        planType: account.planType ?? undefined,
        primary: snapshot.primary,
        secondary: snapshot.secondary,
      })
    : [];

  return {
    account,
    rateLimits: { accountId, windows },
  };
}

/**
 * Native Codex tools disabled on hidden `image_generation` sessions so the
 * model cannot run shell commands, spawn subagents, browse, or edit files.
 */
export function codexImageGenDisabledTools(hasReferences: boolean): readonly string[] {
  const base = ["shell", "subagents", "web_search", "browser", "computer", "apps", "sleep", "goals"];
  return hasReferences ? base : [...base, "view_image"];
}
