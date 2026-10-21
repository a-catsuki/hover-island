import { createMemo, For, Show } from 'solid-js'
import { Battery, Clock3, CloudSun, Music2, Sparkles } from 'lucide-solid'
import { settings } from '../state/settings'
import { COMPACT_ITEMS, normalizeCompactItems } from '../lib/compactConfig'
import { WIDGETS } from '../components/widgets/registry'
import { widgetPanel } from '../lib/panels'
import { createSignal } from 'solid-js'

const itemIcons = { media: Music2, clock: Clock3, weather: CloudSun, battery: Battery, ai: Sparkles } as const
const COLLAPSED_SCALE = 0.75
const EXPANDED_SCALE = 0.5

/** Small, faithful stand-in for the real island: pure black, platters, same proportions. */
export default function SettingsPreview() {
  const [expanded, setExpanded] = createSignal(false)
  const compact = createMemo(() => {
    const ids = normalizeCompactItems(settings.compactItems, settings.sizePreset)
    return COMPACT_ITEMS.filter(item => ids.includes(item.id))
  })
  const firstPage = () => settings.panelOrder[0] ?? 'today'
  const tiles = createMemo(() => settings.widgets
    .filter(widget => widget.enabled && widget.kind !== 'airdrop' && widgetPanel(widget, settings.panelOrder) === firstPage())
    .sort((a, b) => a.order - b.order)
    .slice(0, 4))
  const size = () => expanded()
    ? { w: Math.round(settings.expanded.w * EXPANDED_SCALE), h: Math.round(settings.expanded.h * EXPANDED_SCALE) }
    : { w: Math.round(settings.collapsed.w * COLLAPSED_SCALE), h: Math.round(settings.collapsed.h * COLLAPSED_SCALE) }

  return (
    <section class="appearance-preview" aria-label="Live appearance preview">
      <div class="appearance-preview__stage">
        <div class="appearance-preview__bar" aria-hidden="true" />
        <div
          class={`appearance-preview__island appearance-preview__island--${settings.background}`}
          classList={{ 'appearance-preview__island--expanded': expanded() }}
          style={{ width: `${size().w}px`, height: `${size().h}px`, '--preview-accent': settings.accent, opacity: String(Math.max(0.9, settings.opacity)) }}
        >
          <Show when={!expanded()}>
            <div class="appearance-preview__collapsed">
              <Show when={compact().length} fallback={<span class="appearance-preview__empty">No compact items</span>}>
                <span class="appearance-preview__items" role="list" aria-label="Selected compact items">
                  <For each={compact()}>{item => {
                    const Icon = itemIcons[item.id]
                    return <span class="appearance-preview__compact-item" role="listitem" title={item.label} aria-label={item.label}><Icon size={12} strokeWidth={2} /></span>
                  }}</For>
                </span>
              </Show>
            </div>
          </Show>
          <Show when={expanded()}>
            <div class="appearance-preview__expanded" aria-hidden="true">
              <div class="appearance-preview__tabs">
                <For each={settings.panelOrder.slice(0, 4)}>{(panel, i) => <span classList={{ on: i() === 0 }}>{settings.panels[panel]}</span>}</For>
              </div>
              <div class="appearance-preview__grid">
                <Show when={tiles().length} fallback={<span class="appearance-preview__empty">No widgets on this page</span>}>
                  <For each={tiles()}>{widget => {
                    const def = () => WIDGETS[widget.kind]
                    return <span class="appearance-preview__tile" classList={{ 'appearance-preview__tile--wide': widget.size === 'wide' || widget.size === 'full' }}>{def()?.icon()}<em>{def()?.label ?? widget.kind}</em></span>
                  }}</For>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
      <div class="appearance-preview__foot">
        <div class="set-seg appearance-preview__modes" role="group" aria-label="Preview notch state" style={{ '--n': 2, '--i': expanded() ? 1 : 0 }}>
          <span class="set-seg__thumb" aria-hidden="true" />
          <button type="button" aria-pressed={!expanded()} classList={{ 'set-seg__item--on': !expanded() }} onClick={() => setExpanded(false)}>Collapsed</button>
          <button type="button" aria-pressed={expanded()} classList={{ 'set-seg__item--on': expanded() }} onClick={() => setExpanded(true)}>Expanded</button>
        </div>
      </div>
    </section>
  )
}
