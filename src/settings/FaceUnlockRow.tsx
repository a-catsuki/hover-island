import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { cmd } from '../lib/ipc'
import { describeFaceTiming, lastFaceTiming } from '../lib/faceTiming'
import { reportError } from '../state/feedback'
import { Field } from './controls'

/** Set up or remove face unlock for the ambient soft lock. Setup asks Windows Hello first. */
export default function FaceUnlockRow(props: { disabled: boolean }) {
  const [enrolled, setEnrolled] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [timing, setTiming] = createSignal(lastFaceTiming())
  const refresh = () => {
    setTiming(lastFaceTiming())
    void cmd.faceStatus().then(status => setEnrolled(status.enrolled)).catch(() => {})
  }

  onMount(() => {
    refresh()
    // Enrollment finishes in its own window; pick up the result when Settings is focused again.
    window.addEventListener('focus', refresh)
    onCleanup(() => window.removeEventListener('focus', refresh))
  })

  const setUp = async () => {
    setBusy(true)
    try {
      await cmd.faceEnrollStart()
    } catch (error) {
      reportError('Could not start face setup', error)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    try {
      await cmd.faceReset()
      setEnrolled(false)
    } catch (error) {
      reportError('Could not remove face unlock', error)
    }
  }

  return (
    <Field label="Face unlock" hint={enrolled() ? `Set up. Move the mouse or press a key on the ambient screen and look at your PC. Your face data stays encrypted on this PC.${timing() ? ` ${describeFaceTiming(timing()!)}.` : ''}` : 'Use your webcam to unlock the ambient screen. Windows Hello stays as a backup.'}>
      <Show when={enrolled()} fallback={
        <button type="button" class="button button--primary" disabled={props.disabled || busy()} onClick={() => void setUp()}>Set Up</button>
      }>
        <button type="button" class="button" disabled={props.disabled || busy()} onClick={() => void setUp()}>Set Up Again</button>
        <button type="button" class="button button--danger" onClick={() => void remove()}>Remove</button>
      </Show>
    </Field>
  )
}
