/** An error meant for the person or mod running hmod: printed without a stack trace. */
export class HmodError extends Error {
  constructor(
    message: string,
    /** Process exit code: 1 = failed, 2 = bad usage. */
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "HmodError";
  }
}

export class UsageError extends HmodError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}
