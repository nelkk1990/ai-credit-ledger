# ai-credit-ledger

An append-only credit ledger for metering AI usage. One shared credit
currency across every AI feature and every provider, with idempotent
grants, atomic debits that can never overspend an account, and a complete
audit trail of how every balance came to be.

Built for products that meter heterogeneous AI work — a chat turn, an
image generation, a video render — behind plan allowances and top-ups,
and got tired of scattered `balance = balance - cost` updates racing each
other.

## Install

```bash
npm install ai-credit-ledger
```

## Quick start

```ts
import { CreditLedger, InsufficientCreditsError } from "ai-credit-ledger";

const ledger = new CreditLedger(); // in-memory store by default

// Price every AI feature in one schedule.
const COSTS = {
  CHAT_TURN: 20,
  IMAGE_GENERATE: 50,
  VIDEO_RENDER: 100,
};

// One-time welcome grant — safe to call on every request; the refId makes
// it apply exactly once.
await ledger.grantOnce("user-42", 1000, {
  reason: "WELCOME_GRANT",
  refId: "welcome",
});

// Monthly plan allowance — one grant per period, retries included.
await ledger.grantOnce("user-42", 5000, {
  reason: "PLAN_GRANT",
  refId: "plan:pro:2026-10",
});

// Meter a feature run.
try {
  await ledger.debitFor("user-42", "IMAGE_GENERATE", COSTS, {
    refType: "job",
    refId: "job-123",
  });
} catch (err) {
  if (err instanceof InsufficientCreditsError) {
    // Prompt for a top-up or an upgrade; nothing was charged.
  }
  throw err;
}

await ledger.balance("user-42"); // current balance
await ledger.entries("user-42", { limit: 20 }); // newest-first audit trail
```

## Design

- **Append-only.** Entries are never updated or deleted. The balance is
  the `balanceAfter` of the newest entry, so the ledger *is* the audit
  trail — disputes are answered by reading it, not by reconstructing it.
- **Idempotent grants.** `grantOnce` keys on `(accountId, reason, refId)`.
  Welcome grants, monthly plan grants, and webhook-driven top-ups can be
  retried and raced freely; an account is never double-credited.
- **Atomic debits.** Every read-modify-write for an account is serialized.
  Concurrent debits cannot both read the same balance and overspend: with
  100 credits and ten concurrent 30-credit debits, exactly three succeed
  and the balance ends at 10, never negative.
- **Fail-closed pricing.** `debitFor` throws `UnknownActionError` for an
  action missing from the cost schedule. An unpriced feature fails loudly
  instead of running for free.
- **Stable pagination.** `entries` uses cursor pagination over the
  append-only log, so pages don't shift while new entries arrive.

## Storage

The default `InMemoryLedgerStore` is for tests, demos, and single-process
services. For production, implement the small `LedgerStore` interface
(`append`, `latest`, `findByRef`, `list`) over your database:

- Hold a per-account write lock for the whole read-modify-write
  (e.g. a Postgres advisory lock), matching the serialization the
  in-memory path gets from its per-account promise chain.
- Add a unique constraint on `(accountId, reason, refId)` so `grantOnce`
  stays idempotent even when two processes race.

## API

| Method | Description |
| --- | --- |
| `balance(accountId)` | Current balance. Pure read, no side effects. |
| `grant(accountId, amount, opts)` | Grant credits; returns the new balance. |
| `grantOnce(accountId, amount, opts & { refId })` | Idempotent grant; reports whether it applied. |
| `debit(accountId, amount, opts)` | Debit credits; throws `InsufficientCreditsError` rather than going negative. |
| `debitFor(accountId, action, schedule, extra?)` | Debit the scheduled cost of a named action. |
| `entries(accountId, { limit, cursor })` | Newest-first pages of the audit trail. |

Amounts must be positive whole numbers; violations throw
`InvalidAmountError`. All errors carry a stable machine-readable `code`.

## Development

```bash
npm install
npm test   # builds, then runs the node:test suite
```

## License

MIT © Shoaib Hassan
