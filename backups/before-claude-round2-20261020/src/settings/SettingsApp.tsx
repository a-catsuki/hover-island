import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, Switch as SwitchFlow, Match, type Component } from 'solid-js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Bell, CalendarDays, Check, Command, Hand, Info, LayoutGrid, Link2, Palette, PanelTop, RefreshCw, Search, Settings2, Sparkles, X } from 'lucide-solid'
import { browserPreview, cmd, type Settings } from '../lib/ipc'
import { SCENE_PRESETS, TEMPLATES } from '../lib/themes'
import { loadSettings, settings, patchSettings, resetSettings, savingSettings, flushSettings } from '../state/settings'
import { dismissFeedback, feedback, reportError } from '../state/feedback'
import { Field, Group, Segmented, Select, Slider, Subhead, Toggle, searchQuery, setSearchQuery } from './controls'
import WidgetManager from './WidgetManager'
import ConnectionsPanel from './ConnectionsPanel'
import { SIZE_PRESETS } from '../lib/panels'
import { COMPACT_ITEMS, compactItemLimit, normalizeCompactItems, toggleCompactItem } from '../lib/compactConfig'
import { VISUALIZER_STYLES, normalizeVisualizerStyle } from '../lib/visualizerStyles'
import WebsiteConnectionsPanel from '../components/settings/WebsiteConnectionsPanel'
import CalendarConnectionsPanel from '../components/settings/CalendarConnectionsPanel'
import EmailCodesPanel from '../components/settings/EmailCodesPanel'
import ProvidersPanel from './ProvidersPanel'
import SettingsPreview from './SettingsPreview'
import { requestNotificationAccess } from '../state/notifications'

type SectionId =
  | 'general'
  | 'appearance'
  | 'island'
  | 'widgets'
  | 'notifications'
  | 'connections'
  | 'providers'
  | 'shortcuts'
  | 'calendar'
  | 'privacy'
  | 'about'

interface SectionDef {
  id: SectionId
  label: string
  icon: Component<{ size?: number | string; strokeWidth?: number | string }>
  /** Tile colour, as in System Settings. */
  tile: string
  group: number
  /** Words the sidebar search matches besides the label. */
  keywords: string
}

const SECTIONS: SectionDef[] = [
  { id: 'general', label: 'General', icon: Settings2, tile: '#8e8e93', group: 0, keywords: 'launch login startup hide maximized windows intro tour welcome reset position' },
  { id: 'appearance', label: 'Appearance', icon: Palette, tile: '#0a84ff', group: 0, keywords: 'theme palette scene accent colour color size small medium large compact view clock font time format seconds atmosphere visualizer intensity reactivity background opacity preview' },
  { id: 'island', label: 'Island', icon: PanelTop, tile: '#5e5ce6', group: 0, keywords: 'layout hover expand open close delay dock style notch bar sidebar screen edge top bottom left right media playback buttons position' },
  { id: 'widgets', label: 'Widgets', icon: LayoutGrid, tile: '#ff9f0a', group: 0, keywords: 'pages arrange order add remove size lyrics hidden' },
  { id: 'notifications', label: 'Notifications', icon: Bell, tile: '#ff453a', group: 1, keywords: 'alerts sound chime do not disturb focus dnd peek capture windows access test apps sources shortcuts per-app' },
  { id: 'connections', label: 'Connections', icon: Link2, tile: '#30d158', group: 1, keywords: 'email codes gmail outlook websites alert feeds pairing' },
  { id: 'providers', label: 'AI tools', icon: Sparkles, tile: '#bf5af2', group: 1, keywords: 'providers codex claude cursor usage quota tracker custom ai activity' },
  { id: 'shortcuts', label: 'Shortcuts', icon: Command, tile: '#636366', group: 2, keywords: 'keyboard hotkey island search spotlight key combination' },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, tile: '#ff453a', group: 2, keywords: 'ical subscribe feed events google outlook sync' },
  { id: 'privacy', label: 'Privacy', icon: Hand, tile: '#0a84ff', group: 2, keywords: 'audio speaker output search index files rebuild data local' },
  { id: 'about', label: 'About', icon: Info, tile: '#8e8e93', group: 2, keywords: 'reset settings defaults version' },
]

const EDGE_LABELS = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' } as const

export default function SettingsApp() {
  const [section, setSection] = createSignal<SectionId>('appearance')
  const [indexing, setIndexing] = createSignal(false)
  const [indexStatus, setIndexStatus] = createSignal('')
  const [accessStatus, setAccessStatus] = createSignal('')
  const [noResults, setNoResults] = createSignal(false)
  let content: HTMLDivElement | undefined
  let searchEl: HTMLInputElement | undefined

  const query = () => searchQuery().trim().toLowerCase()
  const visibleSections = createMemo(() => {
    const q = query()
    if (!q) return SECTIONS
    return SECTIONS.filter(item => `${item.label} ${item.keywords}`.toLowerCase().includes(q))
  })
  const current = () => SECTIONS.find(item => item.id === section())!

  onMount(() => {
    void loadSettings()
    let disposed = false
    let unlisten: (() => void) | undefined
    let closing = false
    if (!browserPreview) {
      const window = getCurrentWindow()
      void window.onCloseRequested(async event => {
        event.preventDefault()
        if (closing) return
        closing = true
        try {
          await flushSettings()
          await window.destroy()
        } catch (error) {
          reportError('Could not save before closing settings', error)
          closing = false
        }
      }).then(fn => disposed ? fn() : unlisten = fn).catch(error => reportError('Could not protect unsaved preferences', error))
    }
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchEl?.focus(); searchEl?.select() }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => { disposed = true; unlisten?.(); window.removeEventListener('keydown', onKey) })
  })

  // While searching, jump to the first page that has a match.
  createEffect(() => {
    const matches = visibleSections()
    if (query() && matches.length && !matches.some(item => item.id === section())) setSection(matches[0].id)
  })

  // Row and group filtering. Works on the DOM so panels we do not own are covered too.
  const applyFilter = () => {
    const root = content
    if (!root) return
    const q = query()
    const page = root.firstElementChild as HTMLElement | null
    if (!page) return
    let shown = 0
    for (const unit of Array.from(page.children) as HTMLElement[]) {
      if (!q) {
        unit.hidden = false
        unit.querySelectorAll<HTMLElement>('[data-filtered]').forEach(node => { node.hidden = false; node.removeAttribute('data-filtered') })
        shown++
        continue
      }
      if (unit.classList.contains('appearance-preview')) { unit.hidden = true; continue }
      const titleText = (unit.dataset.searchTitle ?? '').toLowerCase()
      const groupMatch = titleText.includes(q)
      const card = unit.querySelector<HTMLElement>(':scope > .set-card')
      if (!card) {
        const match = (unit.textContent ?? '').toLowerCase().includes(q)
        unit.hidden = !match
        if (match) shown++
        continue
      }
      let any = false
      for (const child of Array.from(card.children) as HTMLElement[]) {
        const match = groupMatch || (child.textContent ?? '').toLowerCase().includes(q) || (child.getAttribute('aria-label') ?? '').toLowerCase().includes(q)
        child.hidden = !match
        child.setAttribute('data-filtered', '')
        if (match) any = true
      }
      unit.hidden = !any
      if (any) shown++
    }
    setNoResults(!!q && shown === 0)
  }
  let scroller: HTMLDivElement | undefined
  createEffect(() => {
    section()
    scroller?.scrollTo(0, 0)
  })
  createEffect(() => {
    query(); section()
    queueMicrotask(applyFilter)
  })
  onMount(() => {
    if (!content) return
    let frame = 0
    const observer = new MutationObserver(() => {
      if (!query()) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(applyFilter)
    })
    observer.observe(content, { childList: true, subtree: true })
    onCleanup(() => { observer.disconnect(); cancelAnimationFrame(frame) })
  })

  const set = (patch: Partial<Settings>) => patchSettings(patch)
  const interaction = (patch: Partial<Settings['interaction']>) =>
    set({ interaction: { ...settings.interaction, ...patch } })

  const reindex = async () => {
    setIndexing(true)
    try {
      setIndexStatus(`Indexed ${(await cmd.spotlightReindex()).toLocaleString()} files.`)
    } catch (error) {
      reportError('Index refresh failed', error)
    } finally {
      setIndexing(false)
    }
  }

  const dockOptions = () => [['notch', 'Notch'], ['bar', 'Bar'], ['sidebar', 'Sidebar']] as const
  const edgeOptions = () => {
    const mode = settings.placement.mode
    const edges: (keyof typeof EDGE_LABELS)[] = mode === 'sidebar' ? ['left', 'right'] : mode === 'bar' ? ['top', 'bottom'] : ['top', 'left', 'right']
    return edges.map(edge => [edge, EDGE_LABELS[edge]] as const)
  }

  return (
    <div class="settings">
      <aside class="settings__aside">
        <div class="settings__search">
          <Search size={13} strokeWidth={2} aria-hidden="true" />
          <input
            ref={searchEl}
            type="search"
            aria-label="Search settings"
            placeholder="Search"
            value={searchQuery()}
            onInput={event => setSearchQuery(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === 'Escape') { setSearchQuery(''); event.currentTarget.blur() } }}
          />
          <Show when={searchQuery()}>
            <button type="button" aria-label="Clear search" onClick={() => { setSearchQuery(''); searchEl?.focus() }}><X size={12} strokeWidth={2.4} /></button>
          </Show>
        </div>
        <nav class="settings__nav" aria-label="Settings sections">
          <For each={[0, 1, 2]}>{group => <Show when={visibleSections().some(item => item.group === group)}>
            <div class="settings__nav-group">
              <For each={visibleSections().filter(item => item.group === group)}>{item => {
                const Icon = item.icon
                return <button type="button" classList={{ active: section() === item.id }} aria-current={section() === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>
                  <span class="settings__tile" style={{ background: item.tile }} aria-hidden="true"><Icon size={13} strokeWidth={2} /></span>
                  <span class="settings__nav-label">{item.label}</span>
                </button>
              }}</For>
            </div>
          </Show>}</For>
          <Show when={!visibleSections().length}>
            <p class="settings__nav-empty">No results for “{searchQuery().trim()}”</p>
          </Show>
        </nav>
      </aside>

      <main class="settings__main">
        <header class="settings__head">
          <h1>{current().label}</h1>
          <span class="settings__saved" role="status" classList={{ 'settings__saved--busy': savingSettings() }}>
            {savingSettings() ? 'Saving' : 'Saved'}
          </span>
        </header>

        <Show when={feedback()}>
          <div class="settings__error" role="alert">
            <span>{feedback()}</span>
            <button type="button" aria-label="Dismiss error" onClick={dismissFeedback}>Dismiss</button>
          </div>
        </Show>

        <div class="settings__scroll" ref={scroller}>
          <div class="settings__content" ref={content}>
            <SwitchFlow>
              <Match when={section() === 'general'}>
                <div class="settings__page">
                  <Group title="Startup">
                    <Toggle label="Launch at login" hint="Start Hover Island with Windows" checked={settings.launchAtLogin} onChange={value => set({ launchAtLogin: value })} />
                    <Toggle label="Hide behind maximized windows" hint="Fade the island out until you reach for it" checked={settings.hideBehindWindows} onChange={value => set({ hideBehindWindows: value })} />
                  </Group>
                  <Group title="Welcome">
                    <Field label="Introduction" hint="Replay the short tour of the island">
                      <button type="button" class="button" onClick={() => set({ onboardingVersion: 0 })}>Replay</button>
                    </Field>
                  </Group>
                </div>
              </Match>

              <Match when={section() === 'appearance'}>
                <div class="settings__page">
                  <SettingsPreview />
                  <Group title="Theme" description={`Current: ${SCENE_PRESETS.find(item => item.theme === settings.theme && item.background === settings.background)?.label ?? 'Custom'}. A theme sets the material, accent and background scene together.`} flush>
                    <div class="scene-cards">
                      <For each={SCENE_PRESETS}>{preset => {
                        const theme = TEMPLATES.find(item => item.id === preset.theme)!
                        const active = () => settings.theme === preset.theme && settings.background === preset.background
                        return <button type="button" class="scene-card" classList={{ 'scene-card--active': active() }} aria-pressed={active()} title={preset.description} onClick={() => set({ theme: theme.id, accent: theme.accent, background: preset.background, visualizer: { ...settings.visualizer, style: theme.visualizer } })}>
                          <span class={`scene-card__art scene-card__art--${preset.id}`}><span class="scene-card__mini-notch"><i /><i /><i /></span><Show when={active()}><span class="scene-card__check"><Check size={11} strokeWidth={3} /></span></Show></span>
                          <span class="scene-card__name">{preset.label}</span>
                        </button>
                      }}</For>
                    </div>
                  </Group>
                  <Group title="Size" description="How much room the island takes up." flush>
                    <div class="size-presets"><For each={['small', 'medium', 'large'] as const}>{key => <button type="button" aria-pressed={settings.sizePreset === key} classList={{ selected: settings.sizePreset === key }} onClick={() => set({ sizePreset: key, collapsed: { ...SIZE_PRESETS[key].collapsed }, expanded: { ...SIZE_PRESETS[key].expanded }, compactItems: normalizeCompactItems(settings.compactItems, key) })}><span class={`size-preview size-preview--${key}`} aria-hidden="true" /><strong>{SIZE_PRESETS[key].label}</strong><small>{key === 'small' ? 'Subtle' : key === 'medium' ? 'Balanced' : 'Roomier'}</small></button>}</For></div>
                  </Group>
                  <Group title="Compact view" description={`Pick up to ${compactItemLimit(settings.sizePreset)} things to show while the island is closed.`} flush>
                    <div class="compact-picks"><For each={COMPACT_ITEMS}>{item => { const selected = () => normalizeCompactItems(settings.compactItems, settings.sizePreset).includes(item.id); return <button type="button" class="compact-picks__item" classList={{ 'compact-picks__item--active': selected() }} aria-pressed={selected()} disabled={!selected() && normalizeCompactItems(settings.compactItems, settings.sizePreset).length >= compactItemLimit(settings.sizePreset)} onClick={() => set({ compactItems: toggleCompactItem(settings.compactItems, item.id, settings.sizePreset) })}><span class="compact-picks__label">{item.label}</span><small>{item.hint}</small></button> }}</For></div>
                  </Group>
                  <Group title="Color">
                    <Field label="Accent color" hint="Buttons, meters and selected controls"><input class="set-color" type="color" aria-label="Accent color" value={settings.accent} onInput={event => set({ accent: event.currentTarget.value })} /></Field>
                    <Slider label="Opacity" hint={`${Math.round(settings.opacity * 100)}%`} min={0.9} max={1} step={0.01} value={settings.opacity} onInput={value => set({ opacity: value })} />
                  </Group>
                  <Group title="Clock">
                    <Select label="Time font" value={settings.clockTypography} options={[['rounded', 'Rounded'], ['serif', 'Classic serif'], ['mono', 'Monospaced']]} onChange={value => set({ clockTypography: value })} />
                    <Select label="Time format" value={settings.clockHourCycle} options={[['12', '12-hour'], ['24', '24-hour']]} onChange={value => set({ clockHourCycle: value })} />
                    <Toggle label="Show seconds" checked={settings.clockSeconds} onChange={value => set({ clockSeconds: value })} />
                    <Segmented label="Clock face" hint="How the clock looks on the closed island" ariaLabel="Collapsed clock face" value={settings.compactClockStyle} options={[['digital', 'Digital'], ['analog', 'Analog']]} onChange={value => set({ compactClockStyle: value })} />
                  </Group>
                  <Group title="Atmosphere" description="Soft light that follows the sound playing on your PC. Audio is read only while the island is open." flush>
                    <div class="viz-picker" role="radiogroup" aria-label="Music visualizer style"><For each={VISUALIZER_STYLES}>{item => { const active = () => normalizeVisualizerStyle(settings.visualizer.style) === item.id; return <button type="button" role="radio" aria-checked={active()} class="viz-picker__item" classList={{ 'viz-picker__item--active': active() }} onClick={() => set({ visualizer: { ...settings.visualizer, style: item.id }, modules: { ...settings.modules, visualizer: item.id !== 'off' } })}><span class={`viz-picker__swatch viz-picker__swatch--${item.id}`} aria-hidden="true" /><span class="viz-picker__label">{item.label}</span></button> }}</For></div>
                    <Slider label="Intensity" hint={`${Math.round(settings.visualizer.intensity * 100)}%`} min={0.1} max={1.6} step={0.05} value={settings.visualizer.intensity} onInput={value => set({ visualizer: { ...settings.visualizer, intensity: value } })} />
                    <Slider label="Reactivity" hint="How quickly it follows the music" min={0} max={1} step={0.05} value={settings.visualizer.reactivity} onInput={value => set({ visualizer: { ...settings.visualizer, reactivity: value } })} />
                  </Group>
                  <Group title="Background scene" description="Reactive lights the island from the sound playing on your PC. Pattern scenes use a tiled texture." flush>
                    <div class="scene-presets"><For each={[['aurora', 'Aurora'], ['reactive', 'Reactive'], ['artwork', 'Album art'], ['ember', 'Ember'], ['plain', 'Still'], ['contours', 'Contours'], ['dots', 'Dots'], ['grid', 'Grid'], ['waves', 'Waves']] as const}>{([key, label]) => <button type="button" aria-pressed={settings.background === key} classList={{ selected: settings.background === key }} onClick={() => set({ background: key })}><span class={`scene-preview scene-preview--${key}`} aria-hidden="true" /><span>{label}</span></button>}</For></div>
                  </Group>
                </div>
              </Match>

              <Match when={section() === 'island'}>
                <div class="settings__page">
                  <Group title="Open and close" description="How the island responds to the pointer. Clicking always opens it.">
                    <Toggle label="Expand on hover" checked={settings.interaction.hoverOpen} onChange={value => interaction({ hoverOpen: value })} />
                    <Slider label="Hover delay" hint={`${settings.interaction.openDelayMs} ms before opening`} min={0} max={1000} step={20} value={settings.interaction.openDelayMs} onInput={value => interaction({ openDelayMs: value })} />
                    <Slider label="Close delay" hint={`${settings.interaction.closeDelayMs} ms after leaving`} min={100} max={2000} step={50} value={settings.interaction.closeDelayMs} onInput={value => interaction({ closeDelayMs: value })} />
                  </Group>
                  <Group title="Position" description="You can also drag the island's handle to snap it to another edge.">
                    <Select
                      label="Dock style"
                      hint="A floating notch, an edge to edge bar, or a sidebar"
                      value={settings.placement.mode}
                      options={dockOptions()}
                      onChange={mode => {
                        const edge = (mode === 'bar' && ['left', 'right'].includes(settings.placement.edge)) || (mode === 'notch' && settings.placement.edge === 'bottom') ? 'top' : mode === 'sidebar' && ['top', 'bottom'].includes(settings.placement.edge) ? 'left' : settings.placement.edge
                        set({ placement: { ...settings.placement, mode, edge } })
                      }}
                    />
                    <Select label="Screen edge" ariaLabel="Notch dock position" value={settings.placement.edge} options={edgeOptions()} onChange={edge => set({ placement: { ...settings.placement, edge } })} />
                    <Field label="Reset position" hint="Back to the top center of your main display">
                      <button type="button" class="button" onClick={() => set({ placement: { mode: 'notch', edge: 'top', monitor: null } })}>Reset</button>
                    </Field>
                  </Group>
                  <Group title="Closed island">
                    <Toggle label="Media playback buttons" hint="Show play, previous and next on the closed island" checked={settings.compactMediaControls} onChange={value => set({ compactMediaControls: value })} />
                  </Group>
                </div>
              </Match>

              <Match when={section() === 'widgets'}>
                <div class="settings__page">
                  <Group title="Arrange" description="Drag tiles to move them. Select a tile for size and page, or use Alt with the arrow keys to reorder." flush>
                    <WidgetManager />
                  </Group>
                </div>
              </Match>

              <Match when={section() === 'notifications'}>
                <div class="settings__page">
                  <Group title="Alerts" description="The island peeks for a few seconds when something new arrives.">
                    <Toggle label="Show notifications" hint="Alerts in the island and the Alerts widget" checked={settings.notifications.enabled} onChange={value => set({ notifications: { ...settings.notifications, enabled: value } })} />
                    <Toggle label="Do Not Disturb" hint="Silence peeks and keep them in the inbox" checked={settings.dnd} onChange={value => set({ dnd: value })} />
                    <Toggle label="Capture Windows notifications" hint="Read alerts from the system listener" checked={settings.notifications.systemListener} onChange={value => set({ notifications: { ...settings.notifications, systemListener: value } })} />
                  </Group>
                  <Group title="Sound" description="Short original tones. Do Not Disturb silences them.">
                    <Select label="Alert sound" hint="Connections and file transfers" value={settings.notifications.sound} options={[['soft', 'Soft chime'], ['glass', 'Glass chime'], ['off', 'Silent']]} onChange={value => set({ notifications: { ...settings.notifications, sound: value } })} />
                    <Field label="Preview" hint="Play the selected chime">
                      <button type="button" class="button" disabled={settings.notifications.sound === 'off' || settings.dnd} onClick={() => void cmd.playAlertSound(settings.notifications.sound).catch(error => reportError('Could not play chime', error))}>Play sound</button>
                    </Field>
                    <Field label="Test alert" hint="Checks the chime, expansion and badge. Windows delivery is separate.">
                      <button type="button" class="button" disabled={settings.dnd || !settings.notifications.enabled} onClick={() => void cmd.sendTestAlert().then(() => setAccessStatus('Test alert sent. Look at the island.')).catch(error => reportError('Could not send a test alert', error))}>Send</button>
                    </Field>
                  </Group>
                  <Group title="App notifications" description={accessStatus() || 'Choose which apps can send notifications into the island.'}>
                    <ConnectionsPanel />
                  </Group>
                </div>
              </Match>

              <Match when={section() === 'connections'}>
                <div class="settings__page">
                  <EmailCodesPanel />
                  <WebsiteConnectionsPanel />
                </div>
              </Match>

              <Match when={section() === 'providers'}>
                <div class="settings__page"><ProvidersPanel /></div>
              </Match>

              <Match when={section() === 'shortcuts'}>
                <div class="settings__page">
                  <Group title="Global shortcuts" description="Use modifier keys with a letter or Space, for example Alt+Space or Control+K. Pick a different combination for each.">
                    <Field label="Island" hint="Open or close the island">
                      <input class="set-input" aria-label="Island shortcut" value={settings.hotkey} placeholder="Alt+Space" onChange={event => set({ hotkey: event.currentTarget.value.trim() })} />
                    </Field>
                    <Field label="Search" hint="Open search from anywhere">
                      <input class="set-input" aria-label="Search shortcut" value={settings.spotlightHotkey} placeholder="Control+Space" onChange={event => set({ spotlightHotkey: event.currentTarget.value.trim() })} />
                    </Field>
                  </Group>
                </div>
              </Match>

              <Match when={section() === 'calendar'}>
                <div class="settings__page"><CalendarConnectionsPanel /></div>
              </Match>

              <Match when={section() === 'privacy'}>
                <div class="settings__page">
                  <Group title="Audio" description="Hover Island reads speaker output only while the island is open. Nothing is recorded or sent anywhere.">
                    <Toggle label="Sound reactive effects" hint="Let the atmosphere follow what you hear" checked={settings.modules.visualizer} onChange={value => set({ modules: { ...settings.modules, visualizer: value } })} />
                  </Group>
                  <Group title="Search index" description="File names are indexed on this PC from your user folders. Nothing leaves it.">
                    <Field label="Rebuild index" hint={indexStatus() || 'Runs in the background'}>
                      <button type="button" class="button" disabled={indexing()} onClick={() => void reindex()}>
                        <RefreshCw size={12} />
                        {indexing() ? 'Indexing…' : 'Rebuild'}
                      </button>
                    </Field>
                  </Group>
                </div>
              </Match>

              <Match when={section() === 'about'}>
                <div class="settings__page">
                  <Group title="Hover Island" description="A Dynamic Island for Windows.">
                    <Field label="Search shortcut" hint="Open or close search">
                      <kbd class="set-kbd">{settings.spotlightHotkey}</kbd>
                    </Field>
                    <Field label="Reset all settings" hint="Restore every preference to its default">
                      <button type="button" class="button button--danger" onClick={() => void resetSettings()}>Reset</button>
                    </Field>
                  </Group>
                </div>
              </Match>
            </SwitchFlow>
            <Show when={noResults()}>
              <p class="settings__empty">Nothing here matches “{searchQuery().trim()}”.</p>
            </Show>
          </div>
        </div>
      </main>
    </div>
  )
}
