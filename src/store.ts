import type { LedgerEntry } from "./types.js";

/**
 * Persistence contract for the ledger. The `CreditLedger` serializes all
 * writes per account, so stores only need to implement plain,
 * non-transactional reads and appends. Bring your own store for production
 * (Postgres, DynamoDB, ...): hold the per-account write lock for the
 * whole read-modify-write, and enforce a unique constraint on
 * (accountId, reason, refId) so `grantOnce` stays idempotent even when
 * two processes race.
 */
export interface LedgerStore {
  /** Append an entry. The entry is fully populated by the caller. */
  append(entry: LedgerEntry): Promise<LedgerEntry>;
  /** Newest entry for the account, or null when the account has none. */
  latest(accountId: string): Promise<LedgerEntry | null>;
  /**
   * Entry for the account with the given (reason, refId), or null.
   * Backs `grantOnce` idempotency.
   */
  findByRef(
    accountId: string,
    reason: string,
    refId: string,
  ): Promise<LedgerEntry | null>;
  /**
   * Entries for the account, newest first, ordered by (createdAt, id).
   * When `before` is given, only entries strictly older than it are
   * returned — this is what makes cursor pagination stable under
   * concurrent inserts.
   */
  list(
    accountId: string,
    opts: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<LedgerEntry[]>;
}

/**
 * Zero-dependency in-memory store. Great for tests, demos, and single-
 * process services. Data lives in the process — swap in a real store for
 * anything that must survive a restart.
 *
 * Ordering note: pagination here uses insertion order, which is the
 * ground truth for "older" — entries created within the same millisecond
 * still paginate correctly, unlike a (createdAt, id) comparison over
 * random UUID ids.
 */
export class InMemoryLedgerStore implements LedgerStore {
  private readonly rows = new Map<string, LedgerEntry[]>();

  async append(entry: LedgerEntry): Promise<LedgerEntry> {
    const list = this.rows.get(entry.accountId) ?? [];
    const stored: LedgerEntry = { ...entry, createdAt: new Date(entry.createdAt) };
    list.push(stored);
    this.rows.set(entry.accountId, list);
    return stored;
  }

  async latest(accountId: string): Promise<LedgerEntry | null> {
    const list = this.rows.get(accountId);
    return list && list.length > 0 ? list[list.length - 1] : null;
  }

  async findByRef(
    accountId: string,
    reason: string,
    refId: string,
  ): Promise<LedgerEntry | null> {
    const list = this.rows.get(accountId) ?? [];
    return (
      list.find((e) => e.reason === reason && e.refId === refId) ?? null
    );
  }

  async list(
    accountId: string,
    opts: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<LedgerEntry[]> {
    const list = this.rows.get(accountId) ?? [];
    let end = list.length;
    if (opts.before) {
      const idx = list.findIndex((e) => e.id === opts.before!.id);
      if (idx >= 0) {
        end = idx;
      } else {
        // Cursor entry unknown to this store (e.g. written by another
        // process): fall back to a strict timestamp comparison.
        end = list.filter(
          (e) => e.createdAt.getTime() < opts.before!.createdAt.getTime(),
        ).length;
      }
    }
    return list.slice(Math.max(0, end - opts.limit), end).reverse();
  }
}
