import { randomUUID } from "node:crypto";
import {
  InsufficientCreditsError,
  InvalidAmountError,
  InvalidCursorError,
  UnknownActionError,
} from "./errors.js";
import { InMemoryLedgerStore, type LedgerStore } from "./store.js";
import type {
  CostSchedule,
  DebitOptions,
  GrantOnceResult,
  GrantOptions,
  LedgerEntry,
  ListEntriesOptions,
  ListEntriesResult,
} from "./types.js";

export interface CreditLedgerOptions {
  /** Persistence adapter. Defaults to {@link InMemoryLedgerStore}. */
  store?: LedgerStore;
  /** Id generator for new entries. Defaults to `crypto.randomUUID`. */
  idGen?: () => string;
  /** Clock used to stamp entries. Defaults to `() => new Date()`. */
  now?: () => Date;
}

function assertPositiveAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new InvalidAmountError(amount);
  }
}

function encodeCursor(entry: LedgerEntry): string {
  const payload = `${entry.createdAt.toISOString()}|${entry.id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [iso, ...rest] = decoded.split("|");
    const id = rest.join("|");
    const createdAt = new Date(iso);
    if (!iso || !id || Number.isNaN(createdAt.getTime())) {
      throw new Error("bad cursor payload");
    }
    return { createdAt, id };
  } catch {
    throw new InvalidCursorError();
  }
}

/**
 * Append-only credit ledger for metering AI usage.
 *
 * One shared credit currency meters any number of AI features across any
 * number of providers: define a {@link CostSchedule} (action -> credits),
 * grant accounts credits when they top up or their plan renews, and debit
 * as features run. Debits are atomic and can never drive a balance
 * negative; grants can be made idempotent so retries and webhook
 * redeliveries never double-credit an account.
 */
export class CreditLedger {
  private readonly store: LedgerStore;
  private readonly idGen: () => string;
  private readonly now: () => Date;
  /** Per-account promise chains serializing read-modify-write cycles. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: CreditLedgerOptions = {}) {
    this.store = options.store ?? new InMemoryLedgerStore();
    this.idGen = options.idGen ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Serialize writes per account. Credits are the classic lost-update
   * trap: two concurrent debits that both read the same latest entry
   * would both succeed and overspend the account. Chaining every
   * read-modify-write for an account onto one promise chain closes that
   * hole for single-process stores; persistent stores should additionally
   * hold a per-account write lock for the whole cycle.
   */
  private withLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.locks.get(accountId) ?? Promise.resolve();
    const run = tail.then(fn, fn);
    this.locks.set(
      accountId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async appendLocked(
    accountId: string,
    delta: number,
    opts: GrantOptions | DebitOptions,
  ): Promise<LedgerEntry> {
    const last = await this.store.latest(accountId);
    const balanceAfter = (last?.balanceAfter ?? 0) + delta;
    if (balanceAfter < 0) {
      throw new InsufficientCreditsError(accountId, -delta, last?.balanceAfter ?? 0);
    }
    return this.store.append({
      id: this.idGen(),
      accountId,
      delta,
      balanceAfter,
      reason: opts.reason,
      refType: opts.refType,
      refId: opts.refId,
      note: opts.note,
      createdAt: this.now(),
    });
  }

  /** Current balance. Pure read — never creates entries as a side effect. */
  async balance(accountId: string): Promise<number> {
    const last = await this.store.latest(accountId);
    return last?.balanceAfter ?? 0;
  }

  /**
   * Grant credits (top-up, plan allowance, goodwill, ...). Returns the
   * new balance.
   */
  async grant(
    accountId: string,
    amount: number,
    opts: GrantOptions,
  ): Promise<{ balanceAfter: number }> {
    assertPositiveAmount(amount);
    const entry = await this.withLock(accountId, () =>
      this.appendLocked(accountId, amount, opts),
    );
    return { balanceAfter: entry.balanceAfter };
  }

  /**
   * Idempotent grant: if an entry with the same `refId` already exists
   * for this account and reason, the call is a no-op returning
   * `granted: false`. Use it for one-time welcome grants
   * (`refId: "welcome"`) and periodic plan grants
   * (`refId: "plan:pro:2026-10"`) so retries, races, and webhook
   * redeliveries can never double-credit.
   */
  async grantOnce(
    accountId: string,
    amount: number,
    opts: GrantOptions & { refId: string },
  ): Promise<GrantOnceResult> {
    assertPositiveAmount(amount);
    return this.withLock(accountId, async () => {
      const existing = await this.store.findByRef(
        accountId,
        opts.reason,
        opts.refId,
      );
      if (existing) {
        return {
          granted: false,
          balanceAfter: await this.balance(accountId),
        };
      }
      const entry = await this.appendLocked(accountId, amount, opts);
      return { granted: true, balanceAfter: entry.balanceAfter };
    });
  }

  /**
   * Debit credits for work done. Throws {@link InsufficientCreditsError}
   * — and appends nothing — when the debit would take the balance below
   * zero. Returns the new balance.
   */
  async debit(
    accountId: string,
    amount: number,
    opts: DebitOptions,
  ): Promise<{ balanceAfter: number }> {
    assertPositiveAmount(amount);
    const entry = await this.withLock(accountId, () =>
      this.appendLocked(accountId, -amount, opts),
    );
    return { balanceAfter: entry.balanceAfter };
  }

  /**
   * Debit the scheduled cost of a named action from a cost schedule,
   * e.g. `debitFor(user, "IMAGE_GENERATE", costs, { refId: jobId })`.
   * Throws {@link UnknownActionError} for actions missing from the
   * schedule — pricing is fail-closed so an unpriced feature can never
   * run for free by accident.
   */
  async debitFor(
    accountId: string,
    action: string,
    schedule: CostSchedule,
    extra: Omit<DebitOptions, "reason"> = {},
  ): Promise<{ balanceAfter: number }> {
    const cost = schedule[action];
    if (cost === undefined) throw new UnknownActionError(action);
    return this.debit(accountId, cost, { ...extra, reason: action });
  }

  /**
   * Page through an account's entries, newest first. Cursor pagination
   * keeps pages stable while new entries are appended concurrently.
   */
  async entries(
    accountId: string,
    opts: ListEntriesOptions = {},
  ): Promise<ListEntriesResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const before = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    const rows = await this.store.list(accountId, {
      limit: limit + 1,
      before,
    });
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastItem = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
    };
  }
}
