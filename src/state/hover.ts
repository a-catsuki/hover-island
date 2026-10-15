/** A hover must remain valid for the full configured delay before it opens. */
export function shouldExpandAfterSustainedHover(
  enteredAt: number,
  now: number,
  delayMs: number,
  stillInside: boolean,
): boolean {
  return stillInside && Number.isFinite(enteredAt) && now - enteredAt >= Math.max(0, delayMs)
}
