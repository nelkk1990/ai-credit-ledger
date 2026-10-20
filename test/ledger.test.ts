import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreditLedger,
  InsufficientCreditsError,
  InvalidAmountError,
  UnknownActionError,
} from "../src/index.js";

const costs = {
  CHAT_TURN: 20,
  IMAGE_GENERATE: 50,
  VIDEO_RENDER: 100,
};

test("grant then debit moves the balance and chains balanceAfter", async () => {
  const ledger = new CreditLedger();
  assert.equal(await ledger.balance("u1"), 0);

  const granted = await ledger.grant("u1", 1000, { reason: "SIGNUP_GRANT" });
  assert.equal(granted.balanceAfter, 1000);

  const debited = await ledger.debit("u1", 50, { reason: "IMAGE_GENERATE" });
  assert.equal(debited.balanceAfter, 950);
  assert.equal(await ledger.balance("u1"), 950);

  const { items } = await ledger.entries("u1");
  assert.equal(items.length, 2);
  assert.equal(items[0].delta, -50);
  assert.equal(items[0].balanceAfter, 950);
  assert.equal(items[1].delta, 1000);
  assert.equal(items[1].balanceAfter, 1000);
});

test("debit beyond the balance throws and appends nothing", async () => {
  const ledger = new CreditLedger();
  await ledger.grant("u1", 30, { reason: "TOPUP" });

  await assert.rejects(
    () => ledger.debit("u1", 31, { reason: "VIDEO_RENDER" }),
    (err: unknown) => {
      if (!(err instanceof InsufficientCreditsError)) return false;
      assert.equal(err.code, "INSUFFICIENT_CREDITS");
      assert.equal(err.required, 31);
      assert.equal(err.balance, 30);
      return true;
    },
  );

  assert.equal(await ledger.balance("u1"), 30);
  const { items } = await ledger.entries("u1");
  assert.equal(items.length, 1);
});

test("amounts must be positive whole numbers", async () => {
  const ledger = new CreditLedger();
  for (const bad of [0, -5, 2.5, Number.NaN]) {
    await assert.rejects(
      () => ledger.grant("u1", bad, { reason: "TOPUP" }),
      InvalidAmountError,
    );
    await assert.rejects(
      () => ledger.debit("u1", bad, { reason: "CHAT_TURN" }),
      InvalidAmountError,
    );
  }
});

test("grantOnce is idempotent per (reason, refId)", async () => {
  const ledger = new CreditLedger();

  const first = await ledger.grantOnce("u1", 1000, {
    reason: "WELCOME_GRANT",
    refId: "welcome",
  });
  assert.deepEqual(first, { granted: true, balanceAfter: 1000 });

  const second = await ledger.grantOnce("u1", 1000, {
    reason: "WELCOME_GRANT",
    refId: "welcome",
  });
  assert.deepEqual(second, { granted: false, balanceAfter: 1000 });

  // A different period key is a different grant.
  const monthly = await ledger.grantOnce("u1", 500, {
    reason: "PLAN_GRANT",
    refId: "plan:pro:2026-10",
  });
  assert.deepEqual(monthly, { granted: true, balanceAfter: 1500 });
});

test("concurrent debits can never overspend the account", async () => {
  const ledger = new CreditLedger();
  await ledger.grant("u1", 100, { reason: "TOPUP" });

  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      ledger.debit("u1", 30, { reason: "CHAT_TURN" }),
    ),
  );
  const succeeded = attempts.filter((a) => a.status === "fulfilled");
  const failed = attempts.filter((a) => a.status === "rejected");

  assert.equal(succeeded.length, 3);
  assert.equal(failed.length, 7);
  assert.equal(await ledger.balance("u1"), 10);

  const { items } = await ledger.entries("u1");
  assert.equal(items.length, 4); // 1 grant + 3 debits
  for (const entry of items) {
    assert.ok(entry.balanceAfter >= 0, "balance never goes negative");
  }
});

test("debitFor prices actions from the cost schedule, fail-closed", async () => {
  const ledger = new CreditLedger();
  await ledger.grant("u1", 200, { reason: "TOPUP" });

  const after = await ledger.debitFor("u1", "IMAGE_GENERATE", costs, {
    refId: "job-123",
  });
  assert.equal(after.balanceAfter, 150);

  await assert.rejects(
    () => ledger.debitFor("u1", "UNPRICED_FEATURE", costs),
    UnknownActionError,
  );
  assert.equal(await ledger.balance("u1"), 150);
});

test("entries paginate newest-first with a stable cursor", async () => {
  const ledger = new CreditLedger();
  for (let i = 0; i < 7; i++) {
    await ledger.grant("u1", 10, { reason: "TOPUP", refId: `t-${i}` });
  }

  const page1 = await ledger.entries("u1", { limit: 3 });
  assert.equal(page1.items.length, 3);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.items[0].balanceAfter, 70);

  const page2 = await ledger.entries("u1", {
    limit: 3,
    cursor: page1.nextCursor!,
  });
  assert.equal(page2.items.length, 3);
  assert.equal(page2.items[0].balanceAfter, 40);

  const page3 = await ledger.entries("u1", {
    limit: 3,
    cursor: page2.nextCursor!,
  });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, null);
});

test("accounts are isolated", async () => {
  const ledger = new CreditLedger();
  await ledger.grant("alice", 100, { reason: "TOPUP" });
  await ledger.grant("bob", 5, { reason: "TOPUP" });
  await ledger.debit("alice", 40, { reason: "CHAT_TURN" });
  assert.equal(await ledger.balance("alice"), 60);
  assert.equal(await ledger.balance("bob"), 5);
});
