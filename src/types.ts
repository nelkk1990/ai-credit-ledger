/**
 * Core types for the AI credit ledger.
 *
 * The ledger is append-only: every grant and debit appends one entry and
 * entries are never updated or deleted. An account's balance is always the
 * `balanceAfter` of its newest entry, so the entry list is a complete,
 * auditable history of how the balance came to be.
 */

export interface LedgerEntry {
  /** Unique entry id. */
  id: string;
  /** The account (user, workspace, tenant, ...) this entry belongs to. */
  accountId: string;
  /** Signed change: positive for grants, negative for debits. */
  delta: number;
  /** Balance immediately after this entry is applied. */
  balanceAfter: number;
  /**
   * Machine-readable reason for the entry, e.g. "SIGNUP_GRANT",
   * "PLAN_GRANT", "IMAGE_GENERATE". Reasons are free-form strings so each
   * product can define its own vocabulary.
   */
  reason: string;
  /** Optional grouping for related entries, e.g. "order" or "job". */
  refType?: string;
  /**
   * Optional reference / idempotency key. The pair (reason, refId) is
   * unique per account: `grantOnce` uses it to make a grant safely
   * repeatable (retries, webhook redeliveries, periodic grants).
   */
  refId?: string;
  /** Optional human-readable note. */
  note?: string;
  createdAt: Date;
}

export interface GrantOptions {
  reason: string;
  refType?: string;
  refId?: string;
  note?: string;
}

export interface DebitOptions {
  reason: string;
  refType?: string;
  refId?: string;
  note?: string;
}

export interface GrantOnceResult {
  /** False when an entry with the same (reason, refId) already existed. */
  granted: boolean;
  balanceAfter: number;
}

export interface ListEntriesOptions {
  /** Page size. Defaults to 50, capped at 200. */
  limit?: number;
  /**
   * Opaque cursor from a previous page's `nextCursor`. Entries are
   * returned newest-first; pass the cursor to walk backwards in time.
   */
  cursor?: string;
}

export interface ListEntriesResult {
  items: LedgerEntry[];
  /** Cursor for the next (older) page, or null when this page is last. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * A per-action price table: action name -> credits charged. Lets an app
 * meter heterogeneous AI features (a chat turn, an image generation, a
 * video render) in one shared currency.
 */
export type CostSchedule = Record<string, number>;
