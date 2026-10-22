/** One budget covers camera startup, model loading, frames and native checks. */
export const FACE_SCAN_MS = 2500
export const BLINK_SCAN_MS = 6000

export class FaceScanExpired extends Error {
  constructor() { super('Face scan timed out') }
}

export class FaceScanCancelled extends Error {
  constructor() { super('Face scan cancelled') }
}

export class FaceScan {
  readonly deadline: number
  private readonly controller = new AbortController()

  constructor(limit: number) { this.deadline = Date.now() + limit }

  get cancelled(): boolean { return this.controller.signal.aborted }
  get remaining(): number { return Math.max(0, this.deadline - Date.now()) }
  cancel(): void { this.controller.abort() }

  /** Clears both the timer and cancellation listener on every exit, including success. */
  wait<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = this.controller.signal
      const finish = (action: () => void) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        action()
      }
      const abort = () => finish(() => reject(new FaceScanCancelled()))
      const timer = setTimeout(() => finish(() => reject(new FaceScanExpired())), this.remaining)
      signal.addEventListener('abort', abort, { once: true })
      // Always consume late rejections, even when already cancelled or expired.
      work.then(value => finish(() => {
        if (signal.aborted) reject(new FaceScanCancelled())
        else if (!this.remaining) reject(new FaceScanExpired())
        else resolve(value)
      }), error => finish(() => reject(error)))
      if (signal.aborted) abort()
      else if (!this.remaining) finish(() => reject(new FaceScanExpired()))
    })
  }
}
