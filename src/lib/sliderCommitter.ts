/** Keep slider feedback immediate while serializing native writes, latest value wins. */
export function createSliderCommitter(send: (value: number) => Promise<void>, onError: (error: unknown) => void, interval = 80) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: number | undefined
  let inFlight = false
  let urgent = false
  let generation = 0
  const drain = async () => {
    timer = undefined
    if (inFlight || pending === undefined) return
    const value = pending, current = generation
    pending = undefined
    urgent = false
    inFlight = true
    try { await send(value) }
    catch (error) { if (current === generation) onError(error) }
    finally {
      inFlight = false
      if (pending !== undefined) {
        if (urgent) void drain()
        else timer = setTimeout(() => void drain(), interval)
      }
    }
  }
  return {
    push(value: number) {
      pending = value
      if (!timer && !inFlight) timer = setTimeout(() => void drain(), interval)
    },
    flush() {
      clearTimeout(timer)
      timer = undefined
      urgent = true
      void drain()
    },
    cancel() {
      generation++
      clearTimeout(timer)
      timer = undefined
      pending = undefined
      urgent = false
    },
  }
}
