import { createSignal, For, onMount, Show } from 'solid-js'
import { RefreshCw, Sparkles } from 'lucide-solid'
import { emit, EVT, type AiEvent, type DetectedProvider, type Settings } from '../lib/ipc'
import { patchSettings, settings } from '../state/settings'
import { detected, detectError, detecting, providerEnabled, refreshDetected, setProviderEnabled } from '../state/usage'
import { reportError } from '../state/feedback'
import { Field, Group, Toggle } from './controls'
import BrandIcon from '../components/BrandIcon'
import './ProvidersPanel.css'

const CAPABILITY_LABELS: Record<string, string> = {
  'live-quota': 'Live quota',
  'local-activity': 'Local activity',
}

const KIND_LABELS: Record<DetectedProvider['kind'], string> = {
  cli: 'CLI',
  app: 'App',
  config: 'Config',
}

/** Detected providers that already have a native settings switch. */
const SETTINGS_KEY: Record<string, 'codex' | 'claudeCode' | 'cursor'> = {
  codex: 'codex',
  'claude-code': 'claudeCode',
  cursor: 'cursor',
}

function ProviderRow(props: { provider: DetectedProvider }) {
  const provider = () => props.provider
  const key = () => SETTINGS_KEY[provider().id]
  const enabled = () => key() ? settings.usage[key()!] : providerEnabled(provider().id)
  const capability = () => {
    const active = provider().evidence.some((item) => item.endsWith(' running'))
    const capabilities = provider().capabilities.map((item) => CAPABILITY_LABELS[item] ?? item).join(' · ')
    if (active) return capabilities ? `Active now · ${capabilities}` : 'Active now · Usage data unavailable'
    return capabilities ? `Recent activity · ${capabilities}` : 'Recently active · Usage data unavailable'
  }
  const evidence = () => {
    const items = provider().evidence
    const shown = items.slice(0, 3).join(' · ')
    return items.length > 3 ? `${shown} · +${items.length - 3}` : shown
  }
  const toggle = () => {
    const settingsKey = key()
    if (settingsKey) {
      const usage = { ...settings.usage, [settingsKey]: !settings.usage[settingsKey] } as Settings['usage']
      patchSettings({ usage })
    } else {
      setProviderEnabled(provider().id, !providerEnabled(provider().id))
    }
  }
  return (
    <div class="providers__row" classList={{ 'providers__row--off': !enabled() }}>
      <span class="providers__icon" aria-hidden="true"><BrandIcon name={provider().id} size={20} /></span>
      <div class="providers__meta">
        <div class="providers__name-line">
          <strong>{provider().label}</strong>
          <span class="providers__kind">{KIND_LABELS[provider().kind]}</span>
        </div>
        <span class="providers__cap" classList={{ 'providers__cap--none': !provider().supported }}>{capability()}</span>
        <span class="providers__evidence" title={provider().evidence.join('\n')}>{evidence()}</span>
      </div>
      <button
        type="button"
        class="set-switch"
        classList={{ 'set-switch--on': enabled() }}
        role="switch"
        aria-checked={enabled()}
        aria-label={`${enabled() ? 'Hide' : 'Show'} ${provider().label}`}
        onClick={toggle}
      >
        <span />
      </button>
    </div>
  )
}

export default function ProvidersPanel() {
  const [previewNote, setPreviewNote] = createSignal('')
  onMount(() => { void refreshDetected() })

  const setManual = (patch: Partial<Settings['usage']['manualConfig']>) =>
    patchSettings({ usage: { ...settings.usage, manualConfig: { ...settings.usage.manualConfig, ...patch } } })

  const preview = () => {
    if (settings.dnd || !settings.notifications.enabled) {
      setPreviewNote('Turn off Do Not Disturb and enable notifications to preview alerts.')
      return
    }
    const fire = (kind: AiEvent['kind'], title: string, body: string) => {
      const event: AiEvent = { id: `ai-preview:${kind}:${Date.now()}`, kind, provider: 'Hover Island', title, body, timestamp: Date.now() }
      return emit(EVT.aiEvent, event)
    }
    void fire('complete', 'Task completed', 'Your AI task finished.').catch((error) => reportError('Could not preview AI alerts', error))
    setPreviewNote('Showing task complete…')
    window.setTimeout(() => {
      void fire('needs-input', 'Needs your input', 'Waiting for your approval.').catch((error) => reportError('Could not preview AI alerts', error))
      setPreviewNote('Showing needs input…')
    }, 3400)
    window.setTimeout(() => setPreviewNote(''), 7400)
  }

  return (
    <div class="providers">
      <Group title="Active and recently used AI tools" description="Based on running apps and recent local session activity. Nothing is uploaded and no secrets are read.">
        <div class="providers__toolbar">
          <span class="providers__summary" role="status">
            {detecting() ? 'Scanning…' : `${detected().length} ${detected().length === 1 ? 'tool' : 'tools'} active or recently used`}
          </span>
          <button type="button" class="button button--secondary providers__rescan" disabled={detecting()} onClick={() => void refreshDetected()}>
            <RefreshCw size={13} class={detecting() ? 'providers__spin' : undefined} />
            {detecting() ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
        <Show when={detectError()}>
          <p class="providers__error" role="status">{detectError()}</p>
        </Show>
        <Show when={!detecting() && !detectError() && detected().length === 0}>
          <p class="providers__empty">No active or recently used AI tools found.</p>
        </Show>
        <For each={detected()}>{(provider) => <ProviderRow provider={provider} />}</For>
        <p class="providers__note">
          Toggles control which supported usage reports appear in the widget. A running tool may appear here even when it does not expose local quota data.
        </p>
      </Group>

      <Group title="Custom tracker" description="A limit and usage you enter yourself.">
        <Toggle
          label="Enable custom tracker"
          hint="Shows your own figures in the AI usage widget"
          checked={settings.usage.manual}
          onChange={(value) => patchSettings({ usage: { ...settings.usage, manual: value } })}
        />
        <Show when={settings.usage.manual}>
          <div class="set-manual">
            <Field label="Label">
              <input
                aria-label="Custom usage label"
                value={settings.usage.manualConfig.label}
                onChange={(event) => setManual({ label: event.currentTarget.value })}
              />
            </Field>
            <Field label="Used">
              <input
                aria-label="Custom usage used"
                type="number"
                min="0"
                value={settings.usage.manualConfig.used ?? ''}
                onChange={(event) => setManual({ used: event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber })}
              />
            </Field>
            <Field label="Limit">
              <input
                aria-label="Custom usage limit"
                type="number"
                min="0"
                value={settings.usage.manualConfig.limit ?? ''}
                onChange={(event) => setManual({ limit: event.currentTarget.value === '' ? null : event.currentTarget.valueAsNumber })}
              />
            </Field>
            <Field label="Unit">
              <input
                aria-label="Custom usage unit"
                value={settings.usage.manualConfig.unit}
                onChange={(event) => setManual({ unit: event.currentTarget.value })}
              />
            </Field>
          </div>
        </Show>
      </Group>

      <Group title="AI activity alerts" description="Task-complete and needs-input can appear in the notch with an animated bot.">
        <Field label="Preview AI alerts" hint="Fires a task-complete alert, then a needs-input alert a moment later">
          <button type="button" class="button" disabled={settings.dnd || !settings.notifications.enabled} onClick={preview}>
            <Sparkles size={13} /> Preview AI alert
          </button>
        </Field>
        <Show when={previewNote()}>
          <p class="set-note" role="status">{previewNote()}</p>
        </Show>
        <p class="providers__note">
          Live AI events need a provider integration. Today Hover Island raises a task-complete alert when your own Focus
          session finishes, and the preview above. Providers with no local source stay clearly labelled.
        </p>
      </Group>
    </div>
  )
}
