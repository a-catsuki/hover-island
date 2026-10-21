import NotificationAccessPanel from './NotificationAccessPanel'
import { createSignal, For, onCleanup, onMount, Show, Switch, Match } from 'solid-js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Bell, Blocks, Cable, Check, ChevronDown, Info, Palette, Plus, Puzzle, RefreshCw, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-solid'
import { browserPreview, cmd, type Settings } from '../lib/ipc'
import { SCENE_PRESETS, TEMPLATES } from '../lib/themes'
import { loadSettings, settings, patchSettings, resetSettings, savingSettings, flushSettings } from '../state/settings'
import { dismissFeedback, feedback, reportError } from '../state/feedback'
import { Field, Group, Slider, Toggle } from './controls'
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
  | 'appearance'
  | 'widgets'
  | 'connections'
  | 'notifications'
  | 'behavior'
  | 'providers'
  | 'about'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette, group: 'Personalize' },
  { id: 'widgets', label: 'Widgets', icon: Blocks, group: 'Personalize' },
  { id: 'connections', label: 'Connections', icon: Cable, group: 'Personalize' },
  { id: 'notifications', label: 'Notifications', icon: Bell, group: 'Personalize' },
  { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal, group: 'App settings' },
  { id: 'providers', label: 'Providers', icon: Puzzle, group: 'App settings' },
  { id: 'about', label: 'About', icon: Info, group: 'App settings' },
]

export default function SettingsApp() {
  const [section, setSection] = createSignal<SectionId>('appearance')
  const [indexing, setIndexing] = createSignal(false)
  const [indexStatus, setIndexStatus] = createSignal('')
  const [accessStatus, setAccessStatus] = createSignal('')
  const [requestingNotificationAccess, setRequestingNotificationAccess] = createSignal(false)

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
    onCleanup(() => { disposed = true; unlisten?.() })
  })

  const set = (patch: Partial<Settings>) => patchSettings(patch)
  const module = (key: keyof Settings['modules'], value: boolean) =>
    set({ modules: { ...settings.modules, [key]: value } })
  const interaction = (patch: Partial<Settings['interaction']>) =>
    set({ interaction: { ...settings.interaction, ...patch } })
  const sizeInput = (key: 'collapsed' | 'expanded', dim: 'w' | 'h', value: number) => {
    if (Number.isFinite(value)) set({ [key]: { ...settings[key], [dim]: value } } as Partial<Settings>)
  }

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

  const requestAccess = async () => {
    setRequestingNotificationAccess(true)
    setAccessStatus('')
    try {
      const allowed = await requestNotificationAccess()
      if (allowed) {
        setAccessStatus('Access granted. Windows alerts are enabled and will appear as they arrive.')
      } else {
        setAccessStatus('Windows did not grant access. Open Windows Settings → Privacy & security → Notification access, allow Hover Island, then retry.')
      }
    } catch (error) {
      setAccessStatus(String(error))
      reportError('Notification access failed', error)
    } finally {
      setRequestingNotificationAccess(false)
    }
  }

  return (
    <div class="settings">
      <aside class="settings__aside">
        <div class="settings__brand">
          <span class="settings__mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Hover Island<small>SETTINGS</small></span>
        </div>
        <nav class="settings__nav" aria-label="Settings sections">
          <For each={['Personalize', 'App settings'] as const}>{group => <div class="settings__nav-group">
            <span class="settings__nav-label">{group}</span>
            <For each={SECTIONS.filter(item => item.group === group)}>{item => {
              const Icon = item.icon
              return <button type="button" classList={{ active: section() === item.id }} aria-current={section() === item.id ? 'page' : undefined} onClick={() => setSection(item.id as SectionId)}><Icon size={16} strokeWidth={1.8} /><span>{item.label}</span><Show when={section() === item.id}><span class="settings__nav-current" aria-hidden="true" /></Show></button>
            }}</For>
          </div>}</For>
        </nav>
        <div class="settings__aside-foot"><span class="settings__online" /> Preferences save automatically</div>
      </aside>

      <main class="settings__main">
        <header class="settings__head">
          <div><span class="settings__head-kicker">HOVER ISLAND / SETTINGS</span><h1>{SECTIONS.find((item) => item.id === section())?.label}</h1></div>
          <span class="settings__saved" role="status">
            {savingSettings() ? 'Saving preferences…' : 'Changes save automatically'}
          </span>
        </header>

        <Show when={feedback()}>
          <div class="settings__error" role="alert">
            <span>{feedback()}</span>
            <button type="button" aria-label="Dismiss error" onClick={dismissFeedback}>Dismiss</button>
          </div>
        </Show>

        <div class="settings__content">
          <Switch>
            <Match when={section() === 'appearance'}>
              <div class="appearance-intro">
                <div class="appearance-intro__copy"><span class="appearance-eyebrow"><Sparkles size={13} /> Appearance</span><h2>Make it yours.</h2><p>Choose a palette and size, then preview the notch closed or open.</p></div>
                <SettingsPreview />
              </div>
              <section class="appearance-section" aria-labelledby="appearance-palette-title">
                <div class="appearance-section__head"><div><h2 id="appearance-palette-title">Palette</h2><p>A complete combination of material, accent and background scene.</p></div><span class="appearance-current">{SCENE_PRESETS.find(item => item.theme === settings.theme && item.background === settings.background)?.label ?? 'Custom look'}</span></div>
                <div class="scene-cards">
                  <For each={SCENE_PRESETS}>{preset => {
                    const theme = TEMPLATES.find(item => item.id === preset.theme)!
                    const active = () => settings.theme === preset.theme && settings.background === preset.background
                    return <button type="button" class="scene-card" classList={{ 'scene-card--active': active() }} aria-pressed={active()} onClick={() => set({ theme: theme.id, accent: theme.accent, background: preset.background, visualizer: { ...settings.visualizer, style: theme.visualizer } })}>
                      <span class={`scene-card__art scene-card__art--${preset.id}`}><span class="scene-card__mini-notch"><i /><i /><i /></span><Show when={active()}><span class="scene-card__check"><Check size={13} /></span></Show></span>
                      <span class="scene-card__name">{preset.label}</span><span class="scene-card__description">{preset.description}</span>
                    </button>
                  }}</For>
                </div>
              </section>
              <Group title="Size" description="Choose how much room the island takes up.">
                <div class="size-presets"><For each={['small', 'medium', 'large'] as const}>{key => <button type="button" aria-pressed={settings.sizePreset === key} classList={{ selected: settings.sizePreset === key }} onClick={() => set({ sizePreset: key, collapsed: { ...SIZE_PRESETS[key].collapsed }, expanded: { ...SIZE_PRESETS[key].expanded }, compactItems: normalizeCompactItems(settings.compactItems, key) })}><span class={`size-preview size-preview--${key}`} aria-hidden="true"/><strong>{SIZE_PRESETS[key].label}</strong><small>{key === 'small' ? 'Subtle' : key === 'medium' ? 'Balanced' : 'Roomier'}</small></button>}</For></div>
              </Group>
              <Group title="Compact view" description={`Choose up to ${compactItemLimit(settings.sizePreset)} items to show while the notch is closed.`}>
                <div class="compact-picks"><For each={COMPACT_ITEMS}>{item => { const selected = () => normalizeCompactItems(settings.compactItems, settings.sizePreset).includes(item.id); return <button type="button" class="compact-picks__item" classList={{ 'compact-picks__item--active': selected() }} aria-pressed={selected()} disabled={!selected() && normalizeCompactItems(settings.compactItems, settings.sizePreset).length >= compactItemLimit(settings.sizePreset)} onClick={() => set({ compactItems: toggleCompactItem(settings.compactItems, item.id, settings.sizePreset) })}><span class="compact-picks__label">{item.label}</span><small>{item.hint}</small></button> }}</For></div>
              </Group>
              <details class="appearance-advanced">
                <summary><span><strong>Advanced appearance</strong><small>Fine-tune colors, atmosphere, and clock details</small></span><ChevronDown size={16} /></summary>
                <div class="appearance-advanced__body">
                  <Group title="Palette" description="Adjust the accent and material opacity.">
                    <Field label="Accent color" hint="Buttons, meters and selected controls"><input type="color" aria-label="Accent color" value={settings.accent} onInput={(event) => set({ accent: event.currentTarget.value })} /></Field>
                    <Slider label="Opacity" hint={`${Math.round(settings.opacity * 100)}%`} min={0.9} max={1} step={0.01} value={settings.opacity} onInput={(value) => set({ opacity: value })} />
                  </Group>
                  <Group title="Collapsed controls" description="Playback buttons and clock details shown while the notch is closed.">
                    <Toggle label="Media playback buttons" hint="Show play, previous and next on the closed notch" checked={settings.compactMediaControls} onChange={(value) => set({ compactMediaControls: value })} />
                    <Field label="Time font"><select aria-label="Time font" value={settings.clockTypography} onChange={event => set({ clockTypography: event.currentTarget.value as Settings['clockTypography'] })}><option value="rounded">Rounded</option><option value="serif">Classic serif</option><option value="mono">Monospaced</option></select></Field>
                    <Field label="Time format"><select aria-label="Time format" value={settings.clockHourCycle} onChange={event => set({ clockHourCycle: event.currentTarget.value as Settings['clockHourCycle'] })}><option value="12">12-hour</option><option value="24">24-hour</option></select></Field>
                    <Toggle label="Show seconds" checked={settings.clockSeconds} onChange={value => set({ clockSeconds: value })} />
                    <div class="set-subhead"><strong>Clock face on the closed notch</strong><small>How the clock item looks while collapsed</small></div>
                    <div class="clock-face-picks" role="radiogroup" aria-label="Collapsed clock face"><For each={[['digital', 'Digital'], ['analog', 'Analog']] as const}>{([key, label]) => <button type="button" role="radio" aria-checked={settings.compactClockStyle === key} classList={{ 'clock-face-picks__item': true, 'clock-face-picks__item--active': settings.compactClockStyle === key }} onClick={() => set({ compactClockStyle: key })}>{label}</button>}</For></div>
                  </Group>
                  <Group title="Atmosphere" description="Soft light that follows your pointer and the sound playing on your PC.">
                    <div class="viz-picker" role="radiogroup" aria-label="Music visualizer style"><For each={VISUALIZER_STYLES}>{item => { const active = () => normalizeVisualizerStyle(settings.visualizer.style) === item.id; return <button type="button" role="radio" aria-checked={active()} class="viz-picker__item" classList={{ 'viz-picker__item--active': active() }} onClick={() => set({ visualizer: { ...settings.visualizer, style: item.id }, modules: { ...settings.modules, visualizer: item.id !== 'off' } })}><span class={`viz-picker__swatch viz-picker__swatch--${item.id}`} aria-hidden="true"/><span class="viz-picker__label">{item.label}</span><small>{item.hint}</small></button> }}</For></div>
                    <Slider label="Intensity" hint={`${Math.round(settings.visualizer.intensity * 100)}% · how far it moves`} min={0.1} max={1.6} step={0.05} value={settings.visualizer.intensity} onInput={value => set({ visualizer: { ...settings.visualizer, intensity: value } })} />
                    <Slider label="Reactivity" hint="How quickly it follows the music" min={0} max={1} step={0.05} value={settings.visualizer.reactivity} onInput={value => set({ visualizer: { ...settings.visualizer, reactivity: value } })} />
                    <div class="set-subhead"><strong>Background scene</strong><small>Ambient light and patterns inside the open notch</small></div>
                    <div class="scene-presets"><For each={[['aurora', 'Aurora'], ['reactive', 'Reactive'], ['artwork', 'Album art'], ['ember', 'Ember'], ['plain', 'Still'], ['contours', 'Contours'], ['dots', 'Dots'], ['grid', 'Grid'], ['waves', 'Waves']] as const}>{([key, label]) => <button type="button" aria-pressed={settings.background === key} classList={{ selected: settings.background === key }} onClick={() => set({ background: key })}><span class={`scene-preview scene-preview--${key}`} aria-hidden="true"/>{label}</button>}</For></div>
                    <p class="set-note"><strong>Reactive</strong> lights the notch from the sound playing on your PC. Pattern scenes use a tiled procedural texture.</p><p class="set-note">Audio reactivity uses speaker output only while the island is open. Reduced motion follows Windows preferences.</p>
                  </Group>
                  <Group title="Getting started" description="You can replay the short introduction whenever you need it."><button type="button" class="button button--secondary" onClick={() => set({ onboardingVersion: 0 })}>Replay the introduction</button></Group>
                </div>
              </details>
            </Match>

            <Match when={section() === 'widgets'}>
              <Group title="Notch widgets" description="Arrange your pages, choose your widgets, and make each space yours.">
                <WidgetManager />
              </Group>

            </Match>

            <Match when={section() === 'connections'}>
              <Group title="Windows app alerts" description="Choose the app sources that can send notifications into your notch.">
                <ConnectionsPanel />
              </Group>
              <CalendarConnectionsPanel/>
              <EmailCodesPanel/>
              <WebsiteConnectionsPanel/>
            </Match>

            <Match when={section() === 'notifications'}>
              <Group title="Alerts" description="The notch peeks for a few seconds when something new arrives.">
                <Field label="Connection & transfer sound" hint="Short original tones. Do Not Disturb silences them."><select aria-label="Alert sound" value={settings.notifications.sound} onChange={event=>set({notifications:{...settings.notifications,sound:event.currentTarget.value as Settings['notifications']['sound']}})}><option value="soft">Soft chime</option><option value="glass">Glass chime</option><option value="off">Silent</option></select></Field>
                <Field label="Listen" hint="Preview the selected chime"><button class="button button--secondary" disabled={settings.notifications.sound==='off'||settings.dnd} onClick={()=>void cmd.playAlertSound(settings.notifications.sound).catch(error=>reportError('Could not play chime',error))}>Test sound</button></Field>
                <Field label="Test notch feedback" hint="Checks the chime, notch expansion and badge; Windows delivery is separate"><button class="button" disabled={settings.dnd || !settings.notifications.enabled} onClick={()=>void cmd.sendTestAlert().then(()=>setAccessStatus('Test alert sent — look at the notch.')).catch(error=>reportError('Could not send a test alert',error))}>Send test alert</button></Field>
                <Toggle
                  label="Show notifications"
                  hint="Display alerts in the notch and the Alerts widget"
                  checked={settings.notifications.enabled}
                  onChange={(value) => set({ notifications: { ...settings.notifications, enabled: value } })}
                />
                <Toggle
                  label="Do Not Disturb"
                  hint="Silence peeks and hold them in the inbox"
                  checked={settings.dnd}
                  onChange={(value) => set({ dnd: value })}
                />
                <Toggle
                  label="Capture Windows notifications"
                  hint="Read alerts from the system listener"
                  checked={settings.notifications.systemListener}
                  onChange={(value) => set({ notifications: { ...settings.notifications, systemListener: value } })}
                />
                <NotificationAccessPanel/>
                <Show when={accessStatus()}>
                  <p class="set-note" role="status">
                    {accessStatus()}
                  </p>
                </Show>
              </Group>
            </Match>

            <Match when={section() === 'behavior'}>
              <Group title="Open & close" description="How the notch responds to the pointer.">
                <Toggle
                  label="Expand on hover"
                  hint="Clicking always opens the notch"
                  checked={settings.interaction.hoverOpen}
                  onChange={(value) => interaction({ hoverOpen: value })}
                />
                <Slider
                  label="Hover delay"
                  hint={`${settings.interaction.openDelayMs} ms before opening`}
                  min={0}
                  max={1000}
                  step={20}
                  value={settings.interaction.openDelayMs}
                  onInput={(value) => interaction({ openDelayMs: value })}
                />
                <Slider
                  label="Close delay"
                  hint={`${settings.interaction.closeDelayMs} ms after leaving`}
                  min={100}
                  max={2000}
                  step={50}
                  value={settings.interaction.closeDelayMs}
                  onInput={(value) => interaction({ closeDelayMs: value })}
                />
              </Group>

              <Group title="Desktop presence">
                <Field label="Dock style" hint="A floating notch, an edge-to-edge bar, or a vertical sidebar."><select aria-label="Dock style" value={settings.placement.mode} onChange={event=>{const mode=event.currentTarget.value as Settings['placement']['mode'];const edge=(mode==='bar'&&['left','right'].includes(settings.placement.edge))||(mode==='notch'&&settings.placement.edge==='bottom')?'top':mode==='sidebar'&&['top','bottom'].includes(settings.placement.edge)?'left':settings.placement.edge;set({placement:{...settings.placement,mode,edge}})}}><option value="notch">Notch</option><option value="bar">Bar</option><option value="sidebar">Sidebar</option></select></Field>
                <Field label="Screen edge" hint="Drag the handle to snap to another edge."><select aria-label="Notch dock position" value={settings.placement.edge} onChange={event=>set({placement:{...settings.placement,edge:event.currentTarget.value as Settings['placement']['edge']}})}><Show when={settings.placement.mode!=='sidebar'}><option value="top">Top</option><Show when={settings.placement.mode==='bar'}><option value="bottom">Bottom</option></Show></Show><Show when={settings.placement.mode!=='bar'}><option value="left">Left</option><option value="right">Right</option></Show></select></Field>
                <Field label="Reset position" hint="Return to the top center of the primary display"><button class="button button--secondary" onClick={()=>set({placement:{mode:'notch',edge:'top',monitor:null}})}>Reset notch position</button></Field>
                <Toggle
                  label="Hide behind maximized windows"
                  hint="Fade the notch until you reach for it"
                  checked={settings.hideBehindWindows}
                  onChange={(value) => set({ hideBehindWindows: value })}
                />
                <Toggle
                  label="Launch at login"
                  hint="Start with Windows"
                  checked={settings.launchAtLogin}
                  onChange={(value) => set({ launchAtLogin: value })}
                />
                <Field label="Island shortcut" hint="Open or close the island. Use a distinct key combination for search.">
                  <input
                    aria-label="Island shortcut"
                    value={settings.hotkey}
                    placeholder="Alt+Space"
                    onChange={(event) => set({ hotkey: event.currentTarget.value.trim() })}
                  />
                </Field>
                <Field label="Search shortcut" hint="Open Spotlight from anywhere. For example, Control+Space or Alt+K.">
                  <input aria-label="Search shortcut" value={settings.spotlightHotkey} placeholder="Control+Space"
                    onChange={event => set({ spotlightHotkey: event.currentTarget.value.trim() })} />
                </Field>
              </Group>

              <Group title="Search index" description="Refresh apps and files from your user folders.">
                <Field label="Rebuild index" hint={indexStatus() || 'Runs in the background'}>
                  <button class="button" disabled={indexing()} onClick={() => void reindex()}>
                    <RefreshCw size={13} />
                    {indexing() ? 'Indexing…' : 'Rebuild'}
                  </button>
                </Field>
              </Group>
            </Match>

            <Match when={section() === 'providers'}>
              <ProvidersPanel />
            </Match>

            <Match when={section() === 'about'}>
              <Group title="Hover Island" description="A macOS-notch-style Dynamic Island for Windows.">
                <Field label="Shortcut" hint="Open or close the search overlay">
                  <kbd class="set-kbd">{settings.spotlightHotkey}</kbd>
                </Field>
                <Field label="Reset" hint="Restore every preference to its default">
                  <button class="button button--danger" onClick={() => void resetSettings()}>
                    Reset settings
                  </button>
                </Field>
              </Group>
            </Match>
          </Switch>
        </div>
      </main>
    </div>
  )
}
