/** Stable machine-readable error codes carried by every ledger error. */
export const ErrorCodes = {
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
  INVALID_CURSOR: "INVALID_CURSOR",
} as const;

/**
 * Thrown by `debit` (and `debitFor`) when the debit would take the
 * account's balance below zero. Nothing is appended to the ledger when
 * this is thrown. Catch it to prompt for a top-up or an upgrade.
 */
export class InsufficientCreditsError extends Error {
  readonly code = ErrorCodes.INSUFFICIENT_CREDITS;

  constructor(
    readonly accountId: string,
    /** Credits the attempted action required. */
    readonly required: number,
    /** Balance at the time of the attempt. */
    readonly balance: number,
  ) {
    super(
      `Insufficient credits: this action costs ${required} credits but the balance is ${balance}.`,
    );
    this.name = "InsufficientCreditsError";
  }
}

/** Thrown when an amount is not a positive whole number of credits. */
export class InvalidAmountError extends Error {
  readonly code = ErrorCodes.INVALID_AMOUNT;

  constructor(amount: number) {
    super(`Credit amounts must be positive whole numbers; got ${amount}.`);
    this.name = "InvalidAmountError";
  }
}

/** Thrown by `debitFor` when the action is missing from the cost schedule. */
export class UnknownActionError extends Error {
  readonly code = ErrorCodes.UNKNOWN_ACTION;

  constructor(action: string) {
    super(`Unknown metered action "${action}" — not present in the cost schedule.`);
    this.name = "UnknownActionError";
  }
}

/** Thrown when a pagination cursor cannot be decoded. */
export class InvalidCursorError extends Error {
  readonly code = ErrorCodes.INVALID_CURSOR;

  constructor() {
    super("The supplied pagination cursor is malformed.");
    this.name = "InvalidCursorError";
  }
}
