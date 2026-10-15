import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { Activity, BatteryCharging } from 'lucide-solid'
import { cmd,type SystemStats } from '../../lib/ipc'
import { open } from '../../state/ui'
export default function SystemView() {
  const [stats,setStats]=createSignal<SystemStats|null>(null)
  const [error,setError]=createSignal('')
  createEffect(()=>{if(!open())return;let active=true;let busy=false;const refresh=async()=>{if(busy)return;busy=true;try{const value=await cmd.systemStats();if(active){setStats(value);setError('')}}catch(error){if(active)setError(String(error))}finally{busy=false}};void refresh();const timer=setInterval(()=>void refresh(),2000);onCleanup(()=>{active=false;clearInterval(timer)})})
  const memory=()=>stats()?.memoryTotalBytes ? stats()!.memoryUsedBytes/stats()!.memoryTotalBytes*100:0
  return <><header class="widget__head"><span class="widget__title"><Activity size={15}/>System</span><Show when={stats()?.batteryPercent!=null}><span class="widget__eyebrow">{stats()?.charging?<BatteryCharging size={13}/>:null}{stats()?.batteryPercent}%</span></Show></header><Show when={stats()} fallback={<p class="muted">Reading system activity…</p>}>{value=><div class="system-lines"><div><span>CPU</span><meter min="0" max="100" value={value().cpuPercent??0}/><strong>{value().cpuPercent==null?'…':`${Math.round(value().cpuPercent!)}%`}</strong></div><div><span>Memory</span><meter min="0" max="100" value={memory()}/><strong>{Math.round(memory())}%</strong></div><small>{(value().memoryUsedBytes/1073741824).toFixed(1)} of {(value().memoryTotalBytes/1073741824).toFixed(1)} GB</small></div>}</Show><Show when={error()}><p class="inline-error">{error()}</p></Show></>
}
