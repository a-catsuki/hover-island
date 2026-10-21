import { createSignal, onMount, Show } from 'solid-js'
import { Radio } from 'lucide-solid'
import { cmd,type AirDropCapability } from '../../lib/ipc'
export default function AirDropView() {
  const [capability,setCapability]=createSignal<AirDropCapability|null>(null)
  const [error,setError]=createSignal('')
  onMount(()=>{void cmd.airDropCapability().then(setCapability).catch(error=>setError(String(error)))})
  return <><header class="widget__head"><span class="widget__title"><Radio size={15}/>AirDrop</span><span class="widget__eyebrow">iPhone</span></header><Show when={capability()} fallback={<p class="muted">Checking radio support…</p>}>{value=><div class="airdrop-state"><strong>{value().ready?'Ready':'Radio backend required'}</strong><p>{value().reason}</p><small>{value().adapter}</small></div>}</Show><Show when={error()}><p class="inline-error">{error()}</p></Show></>
}
