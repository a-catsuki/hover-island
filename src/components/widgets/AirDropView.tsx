import { createSignal, onMount, Show } from 'solid-js'
import { Radio } from 'lucide-solid'
import { cmd, type AirDropCapability } from '../../lib/ipc'
import './widgetKit.css'

export default function AirDropView() {
  const [capability, setCapability] = createSignal<AirDropCapability | null>(null)
  const [error, setError] = createSignal('')
  onMount(() => { void cmd.airDropCapability().then(setCapability).catch((reason) => setError(String(reason))) })
  return (
    <section class="wk" aria-label="AirDrop">
      <header class="wk-head">
        <span class="wk-title"><span class="wk-glyph" style={{ background: '#0A84FF' }}><Radio size={13} strokeWidth={2.2} /></span><span>AirDrop</span></span>
        <span class="wk-sub">iPhone</span>
      </header>
      <Show when={capability()} fallback={<div class="wk-empty"><p>{error() || 'Checking radio support'}</p></div>}>
        {(value) => (
          <div class="wk-empty">
            <strong>{value().ready ? 'Ready' : 'Radio backend required'}</strong>
            <p>{value().reason}</p>
            <p>{value().adapter}</p>
          </div>
        )}
      </Show>
    </section>
  )
}
