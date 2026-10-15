import { createSignal, Show } from 'solid-js'
import { AppWindow, Bluetooth, BatteryCharging, FolderUp, Timer, Music } from 'lucide-solid'
const aliases: Record<string, string> = { codex:'openai', 'claude-code':'claude', 'whatsapp web':'whatsapp', 'google mail':'gmail', 'microsoft outlook':'outlook' }
const brands = new Set(['openai','claude','cursor','gmail','whatsapp','instagram','telegram','outlook','discord'])
export default function BrandIcon(props: { name:string; size?:number; class?:string }) {
  if (props.name === 'Bluetooth') return <Bluetooth size={props.size ?? 20} class={props.class} aria-hidden="true"/>
  if (props.name === 'Battery') return <BatteryCharging size={props.size ?? 20} class={props.class} aria-hidden="true"/>
  if (props.name === 'Phone bucket') return <FolderUp size={props.size ?? 20} class={props.class} aria-hidden="true"/>
  if (props.name === 'Focus timer') return <Timer size={props.size ?? 20} class={props.class} aria-hidden="true"/>
  if (props.name === 'Media') return <Music size={props.size ?? 20} class={props.class} aria-hidden="true"/>
  const [failed, setFailed] = createSignal(false)
  const brand = () => { const name=props.name.toLowerCase();return aliases[name] ?? [...brands].find(brand=>name===brand||name.startsWith(`${brand} `)) ?? name }
  return <Show when={brands.has(brand()) && !failed()} fallback={<AppWindow size={props.size ?? 20} class={props.class} aria-hidden="true" />}><img class={props.class} src={`/brands/${brand()}.svg`} alt="" width={props.size ?? 20} height={props.size ?? 20} style={{ 'object-fit':'contain', 'flex-shrink':0 }} onError={() => setFailed(true)} draggable={false} /></Show>
}
