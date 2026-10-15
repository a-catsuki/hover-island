import { createSignal, For, Show } from 'solid-js'
import { Battery, Clock3, CloudSun, FolderUp, Music2, Sparkles } from 'lucide-solid'
import { settings } from '../state/settings'
import { COMPACT_ITEMS } from '../lib/compactConfig'

const sizeWidths = { small: [190, 288], medium: [226, 322], large: [268, 356] } as const
const itemIcons = { media: Music2, clock: Clock3, weather: CloudSun, battery: Battery, ai: Sparkles } as const

export default function SettingsPreview() {
  const [expanded, setExpanded] = createSignal(false)
  const compact = () => COMPACT_ITEMS.filter(item => settings.compactItems.includes(item.id)).slice(0, 4)
  return (
    <section class="appearance-preview" aria-label="Live appearance preview">
      <div class="appearance-preview__topline">
        <span>Notch preview</span><span class="appearance-preview__dot" />
        <div class="appearance-preview__modes" role="group" aria-label="Preview notch state">
          <button type="button" aria-pressed={!expanded()} onClick={() => setExpanded(false)}>Collapsed</button>
          <button type="button" aria-pressed={expanded()} onClick={() => setExpanded(true)}>Expanded</button>
        </div>
      </div>
      <div class="appearance-preview__stage">
        <div
          class={`appearance-preview__island appearance-preview__island--${settings.background}`}
          classList={{ 'appearance-preview__island--expanded': expanded() }}
          style={{ width: `${sizeWidths[settings.sizePreset][expanded() ? 1 : 0]}px`, '--preview-accent': settings.accent, opacity: String(settings.opacity) }}
        >
          <div class="appearance-preview__collapsed">
            <Show when={!expanded()}>
              <Show when={compact().length} fallback={<span class="appearance-preview__empty">No compact items</span>}>
                <span class="appearance-preview__items" role="list" aria-label="Selected compact items">
                  <For each={compact()}>{item => {
                    const Icon = itemIcons[item.id]
                    return <span class="appearance-preview__compact-item" role="listitem" title={item.label} aria-label={item.label}><Icon size={14} strokeWidth={1.8} /></span>
                  }}</For>
                </span>
              </Show>
            </Show>
            <span class="appearance-preview__beam" role="img" aria-label="Beam quick action" title="Beam quick action"><FolderUp size={13} strokeWidth={1.8} /><span>Beam</span></span>
          </div>
          <Show when={expanded()}><div class="appearance-preview__expanded" aria-hidden="true"><span>Expanded notch</span></div></Show>
        </div>
      </div>
      <p class="appearance-preview__caption">Scene: {settings.background} <span aria-hidden="true">·</span> Size: {settings.sizePreset}</p>
    </section>
  )
}
