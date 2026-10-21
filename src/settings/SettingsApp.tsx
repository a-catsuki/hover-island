import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, Switch as SwitchFlow, Match, type Component } from 'solid-js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Bell, CalendarDays, Check, Command, Hand, Info, LayoutGrid, Link2, MapPin, Palette, PanelTop, RefreshCw, Search, Settings2, Sparkles, X } from 'lucide-solid'
import { browserPreview, cmd, emit, listen, type Settings } from '../lib/ipc'
import { SCENE_PRESETS, TEMPLATES } from '../lib/themes'
import { applySettings, loadSettings, settings, patchSettings, resetSettings, savingSettings, flushSettings } from '../state/settings'
import { dismissFeedback, feedback, reportError } from '../state/feedback'
import WindowsBannersPanel from './WindowsBannersPanel'
import { Field, Group, Segmented, Select, Slider, Subhead, Toggle, searchQuery, setSearchQuery } from './controls'
import WidgetManager from './WidgetManager'
import ConnectionsPanel from './ConnectionsPanel'
import { SIZE_PRESETS } from '../lib/panels'
import { COMPACT_ITEMS, compactItemLimit, normalizeCompactItems, toggleCompactItem } from '../lib/compactConfig'
import { VISUALIZER_STYLES, normalizeVisualizerStyle } from '../lib/visualizerStyles'
import WebsiteConnectionsPanel from '../components/settings/WebsiteConnectionsPanel'
import CalendarConnectionsPanel from '../components/settings/CalendarConnectionsPanel'
import EmailCodesPanel from '../components/settings/EmailCodesPanel'
import ShortcutsPanel from './ShortcutsPanel'
import NativeAppsPanel from './NativeAppsPanel'
import AiPanel from './AiPanel'
import UpdatesPanel from './UpdatesPanel'
import LocationPanel from './LocationPanel'
import { formatShortcut } from '../lib/shortcuts'
import SettingsPreview from './SettingsPreview'

type SectionId =
  | 'general'
  | 'appearance'
  | 'island'
  | 'widgets'
  | 'notifications'
  | 'connections'
  | 'ai'
  | 'shortcuts'
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
  { id: 'general', label: 'General', icon: Settings2, tile: '#8e8e93', group: 0, keywords: 'launch login startup hide maximized windows intro tour welcome replay reset position about version update updates privacy audio speaker output search index files rebuild data local defaults' },
  { id: 'appearance', label: 'Appearance', icon: Palette, tile: '#0a84ff', group: 0, keywords: 'theme palette scene accent colour color size small medium large compact view clock font time format seconds atmosphere visualizer intensity reactivity background opacity preview' },
  { id: 'island', label: 'Island', icon: PanelTop, tile: '#5e5ce6', group: 0, keywords: 'layout hover expand open close delay dock style notch bar sidebar screen edge top bottom left right media playback buttons position shortcuts keyboard hotkey search spotlight key combination record conflict global ctrl alt win' },
  { id: 'widgets', label: 'Widgets', icon: LayoutGrid, tile: '#ff9f0a', group: 0, keywords: 'pages arrange order add remove size lyrics hidden location weather city temperature celsius fahrenheit units automatic windows location services place' },
  { id: 'notifications', label: 'Notifications', icon: Bell, tile: '#ff453a', group: 1, keywords: 'alerts sound chime do not disturb focus dnd peek capture windows access test apps sources shortcuts per-app' },
  { id: 'connections', label: 'Connections', icon: Link2, tile: '#30d158', group: 1, keywords: 'native apps connect disconnect add app discord slack teams whatsapp telegram outlook phone link media spotify email codes gmail websites alert feeds erp pairing calendar ical subscribe feed events google outlook sync' },
  { id: 'ai', label: 'AI tools', icon: Sparkles, tile: '#bf5af2', group: 1, keywords: 'providers codex claude cursor usage quota tracker custom ai activity agent hooks toasts closed island stat response time' },
  { id: 'shortcuts', label: 'Shortcuts', icon: Command, tile: '#636366', group: 2, keywords: 'keyboard hotkey island search spotlight key combination record reset conflict global ctrl alt win' },
  { id: 'about', label: 'About', icon: Info, tile: '#8e8e93', group: 2, keywords: 'reset settings defaults version update updates build' },
]

const EDGE_LABELS = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' } as const

const SECTION_ALIASES: Record<string, SectionId> = { providers: 'ai', weather: 'widgets', location: 'widgets', calendar: 'connections', alerts: 'notifications', hotkeys: 'shortcuts', keyboard: 'shortcuts', updates: 'about', privacy: 'general' }

/** Page id from a hash, a `settings://navigate` payload or a command. Unknown ids give null. */
export function resolveSection(raw: unknown): SectionId | null {
  const id = String(typeof raw === 'object' && raw && 'page' in raw ? (raw as { page: unknown }).page : raw ?? '').replace(/^#/, '').trim().toLowerCase()
  if (!id) return null
  return SECTIONS.find(item => item.id === id)?.id ?? SECTION_ALIASES[id] ?? null
}
function sectionFromHash(): SectionId | null {
  try { return resolveSection(window.location.hash) } catch { return null }
}

export default function SettingsApp() {
  const [section, setSectionRaw] = createSignal<SectionId>(sectionFromHash() ?? 'appearance')
  const [indexing, setIndexing] = createSignal(false)
  const [indexStatus, setIndexStatus] = createSignal('')
  const [accessStatus, setAccessStatus] = createSignal('')
  const [tourStatus, setTourStatus] = createSignal('')
  const [noResults, setNoResults] = createSignal(false)
  let content: HTMLDivElement | undefined
  let searchEl: HTMLInputElement | undefined

  const setSection = (id: SectionId) => {
    setSectionRaw(id)
    try { if (window.location.hash !== `#${id}`) window.history.replaceState(null, '', `#${id}`) } catch { /* The page still switches. */ }
  }
  /** Jump to a page from outside (hash, tray, island, another page). Clears the search so the page is not filtered away. */
  const goTo = (raw: unknown) => {
    const id = resolveSection(raw)
    if (!id) return
    setSearchQuery('')
    setSection(id)
  }

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
    const onHash = () => { const id = sectionFromHash(); if (id) { setSearchQuery(''); setSectionRaw(id) } }
    window.addEventListener('keydown', onKey)
    window.addEventListener('hashchange', onHash)
    // The island and the tray ask an open settings window to switch pages with this event.
    let unlistenNavigate: (() => void) | undefined
    void listen<unknown>('settings://navigate', event => goTo(event.payload)).then(fn => disposed ? fn() : unlistenNavigate = fn).catch(() => {})
    onCleanup(() => { disposed = true; unlisten?.(); unlistenNavigate?.(); window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash) })
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
  /**
   * The tour runs on the island, which lives in another window, so this window
   * cannot call startTour() itself. Resetting the saved tour version is the
   * signal the island watches (it begins the tour when the version drops to 0).
   */
  const replayTour = () => {
    // The event starts the tour even when the saved flag is already 0.
    void applySettings({ onboardingVersion: 0 })
      .then(() => emit('tour://replay'))
      .then(() => setTourStatus('The tour is starting on the island.'))
      .catch(error => reportError('Could not start the tour', error))
  }
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
                    <Field label="Introduction" hint={tourStatus() || 'Watch the short tour of the island again. It plays on the island.'}>
                      <button type="button" class="button" onClick={replayTour}>Replay tour</button>
                    </Field>
                  </Group>
<Group title="Privacy" description="Hover Island reads speaker output only while the island is open. Nothing is recorded or sent anywhere.">
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
                  <Group title="Album cover" description="How the cover looks in the media widget. Vinyl, CD and Float move while music plays." flush>
                    <div class="scene-presets"><For each={[['classic', 'Classic'], ['vinyl', 'Vinyl'], ['cd', 'CD'], ['polaroid', 'Polaroid'], ['stack', 'Stack'], ['float', 'Float']] as const}>{([key, label]) => <button type="button" aria-pressed={settings.coverStyle === key} classList={{ selected: settings.coverStyle === key }} onClick={() => set({ coverStyle: key })}><span class={`cover-swatch cover-swatch--${key}`} aria-hidden="true" /><span>{label}</span></button>}</For></div>
                  </Group>
                  <Group title="Ambient mode" description="A calm full-screen clock, now playing and weather page that appears when you step away. Move the mouse or press any key to leave. It cannot show on the Windows lock screen, which Windows keeps closed to apps.">
                    <Toggle label="Show when idle" hint="Starts after you stop using the PC" checked={settings.ambient.enabled} onChange={value => set({ ambient: { ...settings.ambient, enabled: value } })} />
                    <Select label="Start after" value={String(settings.ambient.idleMinutes)} options={[['1', '1 minute'], ['2', '2 minutes'], ['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour']]} onChange={value => set({ ambient: { ...settings.ambient, idleMinutes: Number(value) } })} />
                    <Toggle label="Clock and date" checked={settings.ambient.clock} onChange={value => set({ ambient: { ...settings.ambient, clock: value } })} />
                    <Toggle label="Now playing" hint="Uses your album cover style" checked={settings.ambient.media} onChange={value => set({ ambient: { ...settings.ambient, media: value } })} />
                    <Toggle label="Weather" checked={settings.ambient.weather} onChange={value => set({ ambient: { ...settings.ambient, weather: value } })} />
                    <Toggle label="Take over from the screen saver" hint="Shows just before the Windows screen saver would, and keeps it and display sleep off while ambient is up. Windows does not let apps draw over the screen saver or lock screen itself." checked={settings.ambient.takeOverScreensaver} onChange={value => set({ ambient: { ...settings.ambient, takeOverScreensaver: value } })} />
                    <Toggle label="Dim and drift" hint="Softer brightness and a slow wander to protect the screen" checked={settings.ambient.dim} onChange={value => set({ ambient: { ...settings.ambient, dim: value } })} />
                    <Field label="Preview" hint="Opens it now. Move the mouse after a couple of seconds to close it.">
                      <button type="button" class="button" onClick={() => void cmd.ambientOpen().catch(error => reportError('Could not open ambient mode', error))}>Preview</button>
                    </Field>
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
<LocationPanel />
                </div>
              </Match>

              <Match when={section() === 'notifications'}>
                <div class="settings__page">
                  <Group title="Alerts" description="The island peeks for a few seconds when something new arrives.">
                    <Toggle label="Show notifications" hint="Alerts in the island and the Alerts widget" checked={settings.notifications.enabled} onChange={value => set({ notifications: { ...settings.notifications, enabled: value } })} />
                    <Toggle label="Do Not Disturb" hint="Silence peeks and keep them in the inbox" checked={settings.dnd} onChange={value => set({ dnd: value })} />
                    <Toggle label="Capture Windows notifications" hint="Read alerts from the system listener" checked={settings.notifications.systemListener} onChange={value => set({ notifications: { ...settings.notifications, systemListener: value } })} />
                  </Group>
                  <WindowsBannersPanel />
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
                  <NativeAppsPanel onNavigate={page => goTo(page)} />
                  <EmailCodesPanel />
                  <WebsiteConnectionsPanel />
<CalendarConnectionsPanel />
                </div>
              </Match>

              <Match when={section() === 'ai'}>
                <div class="settings__page"><AiPanel /></div>
              </Match>

              <Match when={section() === 'shortcuts'}>
                <div class="settings__page"><ShortcutsPanel /></div>
              </Match>

              <Match when={section() === 'about'}>
                <div class="settings__page">
<UpdatesPanel />
                  <Group title="About" description="Hover Island, a Dynamic Island for Windows.">
                    <Field label="Search shortcut" hint="Change it under Shortcuts">
                      <kbd class="set-kbd">{formatShortcut(settings.spotlightHotkey)}</kbd>
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
