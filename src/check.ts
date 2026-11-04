// Small checks shared by validate and the pipelines.

/** The largest value an int32 field on the wire can carry. */
export const maxInt32 = 2 ** 31 - 1;

/** quote shows a value in a problem: strings in quotes, anything else as is. */
export function quote(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** checkRange reports a number outside lo to hi. Undefined is fine. */
export function checkRange(name: string, v: unknown, lo: number, hi: number, add: (problem: string) => void): void {
  if (v === undefined) {
    return;
  }
  if (typeof v !== "number" || !(v >= lo && v <= hi)) {
    add(`${name} ${quote(v)} is outside ${lo} to ${hi}`);
  }
}

/** checkCount reports anything but a whole number from zero up. Undefined is fine. */
export function checkCount(name: string, v: unknown, add: (problem: string) => void): void {
  if (v === undefined) {
    return;
  }
  if (typeof v !== "number" || Number.isNaN(v)) {
    add(`${name} ${quote(v)} is not a number`);
  } else if (v < 0) {
    add(`${name} ${v} cannot be negative`);
  } else if (!Number.isInteger(v) || v > maxInt32) {
    add(`${name} ${v} must be a whole number up to ${maxInt32}`);
  }
}

/** checkDuration reports a duration in milliseconds that cannot be sent. Undefined is fine. */
export function checkDuration(name: string, v: unknown, add: (problem: string) => void, max = maxInt32): void {
  if (v === undefined) {
    return;
  }
  if (typeof v !== "number" || Number.isNaN(v)) {
    add(`${name} ${quote(v)} is not a number of milliseconds`);
  } else if (v < 0) {
    add(`${name} ${v} cannot be negative`);
  } else if (v > max) {
    add(`${name} ${v} is too long: at most ${max}`);
  }
}
