import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { browserPreview, cmd, listen, type UpdateStatus } from '../lib/ipc'
import { flushSettings, patchSettings, settings } from '../state/settings'
import { Field, Group, Toggle } from './controls'

/** Check for a newer build and install it in place. Settings and data stay as they are. */
const builtAt = () => {
  try { return new Date(typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '').toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) } catch { return 'unknown' }
}

export default function UpdatesPanel() {
  const [status, setStatus] = createSignal<UpdateStatus | null>(null)
  const [busy, setBusy] = createSignal<'idle' | 'checking' | 'installing'>('idle')
  const [percent, setPercent] = createSignal(0)
  const [problem, setProblem] = createSignal('')

  const check = async () => {
    if (busy() !== 'idle') return
    setBusy('checking')
    setProblem('')
    try {
      setStatus(browserPreview ? { current: '0.1.5', latest: '0.1.6', available: true, notes: 'Wider expanded island, arched collapsed notch, Apple Music lyrics.', checkedAt: Date.now(), error: null } : await cmd.updateCheck())
    } catch {
      setProblem('Couldn’t check for updates.')
    } finally {
      setBusy('idle')
    }
  }

  const install = async () => {
    if (busy() !== 'idle') return
    setBusy('installing')
    setPercent(0)
    setProblem('')
    try {
      if (browserPreview) return
      await flushSettings()
      await cmd.updateInstall()
      // Windows replaces the app and reopens it; this window goes away with it.
    } catch (error) {
      setProblem(typeof error === 'string' ? error : 'The update didn’t install.')
      setBusy('idle')
    }
  }

  onMount(() => {
    void check()
    const stops: Array<() => void> = []
    void listen<UpdateStatus>('updater://status', event => setStatus(event.payload)).then(stop => stops.push(stop)).catch(() => {})
    void listen<number>('updater://progress', event => setPercent(event.payload)).then(stop => stops.push(stop)).catch(() => {})
    onCleanup(() => stops.forEach(stop => stop()))
  })

  const headline = () => {
    const current = status()
    if (busy() === 'installing') return percent() >= 100 ? 'Installing. Hover Island will reopen on its own.' : `Downloading ${percent()}%`
    if (busy() === 'checking') return 'Checking…'
    if (!current) return 'Not checked yet'
    if (current.error) return current.error
    if (current.available) return `Version ${current.latest} is ready`
    return 'You’re up to date'
  }

  return (
    <Group title="Updates" description="Get new builds without uninstalling the old one.">
      <Field label={headline()} hint={`Installed version ${status()?.current ?? ''} · built ${builtAt()}`}>
        <Show when={status()?.available && busy() !== 'checking'} fallback={
          <button type="button" class="button" disabled={busy() !== 'idle'} onClick={() => void check()}>Check for updates</button>
        }>
          <button type="button" class="button button--primary" disabled={busy() !== 'idle'} onClick={() => void install()}>Update now</button>
        </Show>
      </Field>
      <Show when={status()?.available && status()?.notes}>
        <p class="appn__status">{status()?.notes}</p>
      </Show>
      <Show when={problem()}>
        <p class="appn__status">{problem()}</p>
      </Show>
      <Toggle label="Check automatically" hint="Looks once a day and never installs without your click" checked={settings.autoUpdate !== false} onChange={value => patchSettings({ autoUpdate: value })} />
    </Group>
  )
}
