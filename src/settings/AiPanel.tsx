import { createMemo, createSignal, For, onMount, Show } from 'solid-js'
import { cmd, type HookPreview, type HookStatus } from '../lib/ipc'
import { patchSettings, settings } from '../state/settings'
import { detected, refreshDetected } from '../state/usage'
import { reportError } from '../state/feedback'
import { Field, Group, Select, Toggle } from './controls'
import ProvidersPanel from './ProvidersPanel'

const STAT_OPTIONS = [
  ['usage-left', 'Usage left'],
  ['response-time', 'Response time'],
  ['active-count', 'Active agents'],
  ['off', 'Hidden'],
] as const

const STAT_HINTS = {
  'usage-left': 'The lowest quota you have left across your AI tools.',
  'response-time': 'How long the last agent reply took.',
  'active-count': 'How many agents are working right now.',
  off: 'Nothing from your AI tools on the closed island.',
} as const

type Pending = { kind: 'install' | 'uninstall'; preview: HookPreview }

/** Agent hooks: preview the exact file change, then confirm. Nothing is written before that. */
function HooksGroup() {
  const [hooks, setHooks] = createSignal<HookStatus[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [pending, setPending] = createSignal<Record<string, Pending>>({})
  const [errors, setErrors] = createSignal<Record<string, string>>({})

  const refresh = async () => {
    try { setHooks(await cmd.agentHooksStatus()) } catch (error) { reportError('Could not read agent hooks', error) }
    setLoaded(true)
  }
  onMount(() => void refresh())

  const setKey = <T,>(setter: (fn: (previous: Record<string, T>) => Record<string, T>) => void, id: string, value: T | null) =>
    setter(previous => { const next = { ...previous }; if (value === null) delete next[id]; else next[id] = value; return next })

  const preview = async (hook: HookStatus, kind: Pending['kind']) => {
    setBusy(hook.provider); setKey(setErrors, hook.provider, null)
    try {
      const result = await (kind === 'install' ? cmd.agentHooksInstall(hook.provider, true) : cmd.agentHooksUninstall(hook.provider, true))
      setKey(setPending, hook.provider, { kind, preview: result })
    } catch (error) { setKey(setErrors, hook.provider, error instanceof Error ? error.message : String(error)) }
    finally { setBusy(null) }
  }
  const confirm = async (hook: HookStatus) => {
    const entry = pending()[hook.provider]
    if (!entry) return
    setBusy(hook.provider)
    try {
      await (entry.kind === 'install' ? cmd.agentHooksInstall(hook.provider, false) : cmd.agentHooksUninstall(hook.provider, false))
      setKey(setPending, hook.provider, null)
      await refresh()
    } catch (error) { setKey(setErrors, hook.provider, error instanceof Error ? error.message : String(error)) }
    finally { setBusy(null) }
  }

  return <Group
    title="Agent hooks"
    description="Hooks let a CLI tell the island when it finishes, fails or needs you. Hover Island shows the exact change to the tool's config file first, keeps a backup, and writes nothing until you confirm."
  >
    <Show when={loaded()} fallback={<p class="set-note" style={{ padding: '12px 16px' }}>Looking for tools…</p>}>
      <Show when={hooks().length} fallback={<p class="set-note" style={{ padding: '12px 16px' }}>No supported tools found on this PC.</p>}>
        <For each={hooks()}>{hook => {
          const entry = () => pending()[hook.provider]
          return <div class="hook">
            <div class="set-row">
              <span class="set-row__text">
                <strong>{hook.label}</strong>
                <small>{!hook.available ? 'Not found on this PC' : hook.installed ? (hook.stale ? 'Installed, but out of date. Reinstall to update it.' : 'Installed') : 'Not installed'}</small>
              </span>
              <span class="set-row__control">
                <Show when={entry()} fallback={<>
                  <Show when={hook.installed}>
                    <button type="button" class="button button--danger" disabled={busy() === hook.provider} onClick={() => void preview(hook, 'uninstall')}>Remove</button>
                  </Show>
                  <button type="button" class="button" disabled={!hook.available || busy() === hook.provider} onClick={() => void preview(hook, 'install')}>{hook.installed ? (hook.stale ? 'Update…' : 'Reinstall…') : 'Set up…'}</button>
                </>}>
                  <button type="button" class="button" disabled={busy() === hook.provider} onClick={() => setKey(setPending, hook.provider, null)}>Cancel</button>
                  <button type="button" class="button button--primary" disabled={busy() === hook.provider || !entry()!.preview.changed} onClick={() => void confirm(hook)}>{entry()!.kind === 'install' ? 'Install' : 'Remove'}</button>
                </Show>
              </span>
            </div>
            <Show when={entry()}>
              <div class="hook__preview">
                <p class="hook__path">{entry()!.preview.path}</p>
                <Show when={entry()!.preview.changed} fallback={<p class="set-note">Nothing to change. {entry()!.preview.note ?? ''}</p>}>
                  <pre class="hook__diff" aria-label={`Proposed change to ${entry()!.preview.path}`}>
                    <For each={entry()!.preview.diff.split('\n')}>{line => <span classList={{ 'hook__add': line.startsWith('+') && !line.startsWith('+++'), 'hook__del': line.startsWith('-') && !line.startsWith('---') }}>{line + '\n'}</span>}</For>
                  </pre>
                  <p class="set-note">{entry()!.preview.exists ? 'A backup of the current file is saved first.' : 'This file does not exist yet and will be created.'}{entry()!.preview.note ? ` ${entry()!.preview.note}` : ''}</p>
                </Show>
              </div>
            </Show>
            <Show when={errors()[hook.provider]}><p class="hook__error" role="alert">{errors()[hook.provider]}</p></Show>
          </div>
        }}</For>
      </Show>
    </Show>
  </Group>
}

/** AI page: what shows on the closed island, agent alerts, hooks, then the tools and custom tracker. */
export default function AiPanel() {
  const stat = () => settings.compactAiStat
  onMount(() => void refreshDetected())
  const toastIds = createMemo(() => settings.aiToastProviders)
  const allowed = (id: string) => toastIds().length === 0 || toastIds().includes(id)
  const toggleProvider = (id: string, on: boolean) => {
    const everyone = detected().map(item => item.id)
    const current = toastIds().length ? toastIds() : everyone
    const next = on ? [...new Set([...current, id])] : current.filter(item => item !== id)
    // Every provider on is stored as an empty list, which means "all".
    patchSettings({ aiToastProviders: next.length >= everyone.length && everyone.every(item => next.includes(item)) ? [] : next })
  }

  return <>
    <Group title="Closed island" description={STAT_HINTS[stat()] ?? ''}>
      <Select
        label="AI stat"
        hint="One small number next to the AI icon when the island is closed"
        value={stat()}
        options={STAT_OPTIONS}
        onChange={value => patchSettings({ compactAiStat: value })}
      />
    </Group>
    <Group title="Agent alerts" description="A short notice on the island when an agent finishes, fails or needs you. Do Not Disturb keeps them quiet.">
      <Toggle label="Show agent alerts" hint="Task finished, failed or waiting for an answer" checked={settings.aiToastsEnabled} onChange={value => patchSettings({ aiToastsEnabled: value })} />
      <Show when={settings.aiToastsEnabled && detected().length}>
        <For each={detected()}>{item => <Toggle label={item.label} hint="Allow alerts from this tool" checked={allowed(item.id)} onChange={value => toggleProvider(item.id, value)} />}</For>
      </Show>
      <Show when={settings.dnd}><p class="set-note" role="status" style={{ padding: '0 16px 10px' }}>Do Not Disturb is on, so alerts stay in the inbox for now.</p></Show>
    </Group>
    <HooksGroup />
    <ProvidersPanel />
  </>
}
