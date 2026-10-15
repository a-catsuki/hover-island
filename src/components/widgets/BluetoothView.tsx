import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Bluetooth } from 'lucide-solid'
import { cmd, type DeviceSnapshot } from '../../lib/ipc'
export default function BluetoothView() {
  const [snapshot,setSnapshot] = createSignal<DeviceSnapshot | null>(null)
  const [error,setError] = createSignal('')
  const [page,setPage] = createSignal(0)
  const pages = () => Math.max(1,Math.ceil((snapshot()?.bluetooth.length ?? 0)/2))
  const currentPage = () => Math.min(page(),pages()-1)
  onMount(() => { let disposed=false; const load=() => void cmd.devicesGet().then(value => { if(!disposed) setSnapshot(value) }).catch(error => { if(!disposed) setError(String(error)) }); load(); const timer=setInterval(load,5000); onCleanup(() => {disposed=true;clearInterval(timer)}) })
  return <><header class="widget__head"><span class="widget__title"><Bluetooth size={15}/>Connections</span><span class="widget__eyebrow">Bluetooth</span></header><Show when={snapshot()} fallback={<p class="muted">{error() || 'Checking devices…'}</p>}>{value => <><For each={value().bluetooth.slice(currentPage()*2,currentPage()*2+2)}>{name => <div class="bluetooth-device"><Bluetooth size={14}/><span>{name}</span><small>Connected</small></div>}</For><Show when={!value().bluetooth.length}><p class="muted">{value().error || 'No connected Bluetooth devices.'}</p></Show><Show when={value().charging !== null}><p class="bluetooth-power">{value().charging ? 'Power connected' : 'On battery'}</p></Show><Show when={pages()>1}><nav class="widget-list-pager" aria-label="Bluetooth devices"><button aria-label="Previous Bluetooth devices" disabled={currentPage()===0} onClick={()=>setPage(currentPage()-1)}>‹</button><span>{currentPage()+1} / {pages()}</span><button aria-label="Next Bluetooth devices" disabled={currentPage()>=pages()-1} onClick={()=>setPage(currentPage()+1)}>›</button></nav></Show></>}</Show></>
}
