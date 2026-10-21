import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import { Activity, BatteryCharging, Cpu, MemoryStick } from 'lucide-solid'
import { cmd, type SystemStats } from '../../lib/ipc'
import { open } from '../../state/ui'
import Ring from './Ring'
import './widgetKit.css'
import './SystemView.css'

export default function SystemView() {
  const [stats, setStats] = createSignal<SystemStats | null>(null)
  const [error, setError] = createSignal('')
  createEffect(() => {
    if (!open()) return
    let active = true
    let busy = false
    const refresh = async () => {
      if (busy) return
      busy = true
      try { const value = await cmd.systemStats(); if (active) { setStats(value); setError('') } }
      catch (reason) { if (active) setError(String(reason)) }
      finally { busy = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    onCleanup(() => { active = false; clearInterval(timer) })
  })
  const memory = () => stats()?.memoryTotalBytes ? stats()!.memoryUsedBytes / stats()!.memoryTotalBytes : 0
  const heat = (value: number, base: string) => value > 0.9 ? '#FF453A' : value > 0.75 ? '#FF9F0A' : base
  const gb = (bytes: number) => (bytes / 1073741824).toFixed(1)
  return (
    <section class="wk sys" aria-label="System activity">
      <header class="wk-head">
        <span class="wk-title"><span class="wk-glyph" style={{ background: '#30D158' }}><Activity size={13} strokeWidth={2.2} /></span><span>System</span></span>
      </header>
      <Show when={stats()} fallback={<div class="wk-empty"><p>{error() ? 'System stats are unavailable.' : 'Reading system activity'}</p></div>}>
        {(value) => {
          const cpu = () => (value().cpuPercent ?? 0) / 100
          const battery = () => value().batteryPercent == null ? null : value().batteryPercent! / 100
          return (
            <div class="sys__rings" style={{ '--sys-n': battery() == null ? 2 : 3 }}>
              <div class="sys__item">
                <Ring value={value().cpuPercent == null ? null : cpu()} color={heat(cpu(), '#30D158')} label={`CPU ${value().cpuPercent == null ? 'unavailable' : Math.round(value().cpuPercent!) + '%'}`}>
                  <strong class="sys__value">{value().cpuPercent == null ? '…' : `${Math.round(value().cpuPercent!)}%`}</strong>
                </Ring>
                <span class="sys__label"><Cpu size={11} aria-hidden="true" />CPU</span>
                <span class="sys__sub">In use</span>
              </div>
              <div class="sys__item">
                <Ring value={memory()} color={heat(memory(), '#0A84FF')} label={`Memory ${Math.round(memory() * 100)}%`}>
                  <strong class="sys__value">{Math.round(memory() * 100)}%</strong>
                </Ring>
                <span class="sys__label"><MemoryStick size={11} aria-hidden="true" />Memory</span>
                <span class="sys__sub">{gb(value().memoryUsedBytes)} of {gb(value().memoryTotalBytes)} GB</span>
              </div>
              <Show when={battery() != null}>
                <div class="sys__item">
                  <Ring value={battery()} color={battery()! <= 0.2 && !value().charging ? '#FF453A' : '#30D158'} label={`Battery ${value().batteryPercent}%${value().charging ? ', charging' : ''}`}>
                    <strong class="sys__value">{value().batteryPercent}%</strong>
                  </Ring>
                  <span class="sys__label"><BatteryCharging size={11} aria-hidden="true" />Battery</span>
                  <span class="sys__sub">{value().charging ? 'Charging' : 'On battery'}</span>
                </div>
              </Show>
            </div>
          )
        }}
      </Show>
      <Show when={error() && stats()}><p class="wk-error">{error()}</p></Show>
    </section>
  )
}
