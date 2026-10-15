/**
 * FROZEN IPC CONTRACT — the single source of truth for both the Rust backend and the
 * SolidJS frontend. Do not rename command strings or event names without updating both.
 */
import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core'
import { emit as tauriEmit, listen as tauriListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'
import { previewInvoke, previewListen } from './preview'

export const browserPreview = !isTauri()
const invoke = <T,>(command: string, args?: Record<string, unknown>): Promise<T> =>
  browserPreview ? previewInvoke<T>(command, args, DEFAULT_SETTINGS) : tauriInvoke<T>(command, args)
export const listen = <T,>(event: string, callback: EventCallback<T>): Promise<UnlistenFn> =>
  browserPreview ? previewListen(event, callback) : tauriListen(event, callback)
/** App-wide event emission. Browser preview is a no-op because pages are isolated. */
export const emit = <T,>(event: string, payload?: T): Promise<void> =>
  browserPreview ? Promise.resolve() : tauriEmit(event, payload)

/* ------------------------------------------------------------------ types */

export interface Size {
  w: number
  h: number
}
export interface Placement { mode: 'notch' | 'bar' | 'sidebar'; edge: 'top' | 'bottom' | 'left' | 'right'; monitor: string | null }

export type MediaStatus = 'playing' | 'paused' | 'stopped'

export interface NowPlaying {
  title: string
  artist: string
  album?: string | null
  /** data: URL of the artwork, if any */
  thumbnail?: string | null
  status: MediaStatus
  position?: number | null
  duration?: number | null
  sourceApp?: string | null
  canPlay?: boolean
  canPause?: boolean
  canSkipNext?: boolean
  canSkipPrevious?: boolean
  canSeek?: boolean
  seekMin?: number | null
  seekMax?: number | null
}

export type MediaAction = 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek'

export interface AppNotification {
  id: string
  app: string
  title: string
  body: string
  /** epoch millis */
  timestamp: number
  icon?: string | null
  category?: 'erp' | 'website' | 'transfer' | 'ai' | 'preference'
  phase?: 'staging' | 'receiving' | 'sending' | 'ready' | 'sent' | 'complete' | 'error'
  progress?: number | null
  transferId?: string
  priority?: 'normal' | 'high' | 'urgent'
  url?: string
  /** AI peek variant: 'complete' celebrates, 'needs-input' pulses for attention. */
  aiKind?: 'complete' | 'needs-input'
}

export interface InstalledApp {
  id: string
  name: string
  target: string
  kind: 'uwp' | 'desktop' | 'url'
  icon?: string | null
}

export type UsageProviderKind = 'codex' | 'claude-code' | 'cursor' | 'manual'

/** A locally installed AI tool discovered by the native read-only scanner. */
export interface DetectedProvider {
  id: string
  label: string
  kind: 'cli' | 'app' | 'config'
  /** Home-relative paths or PATH matches, e.g. "~/.codex" or "codex on PATH". */
  evidence: string[]
  /** True only when a real local quota or activity source exists. */
  supported: boolean
  /** "live-quota" and/or "local-activity"; empty when nothing local exists. */
  capabilities: string[]
}

/** AI activity raised into the notch. */
export interface AiEvent {
  id: string
  kind: 'complete' | 'needs-input'
  /** Display name of the tool, e.g. "Codex". */
  provider?: string
  title: string
  body?: string
  /** epoch millis */
  timestamp: number
}

export interface UsageSnapshot {
  provider: UsageProviderKind
  label: string
  status: 'ok' | 'unknown' | 'error'
  /** tokens/requests used in the current window */
  used?: number | null
  limit?: number | null
  unit?: string | null
  /** 0..1 */
  percent?: number | null
  /** rolling window label, e.g. "5h", "today", "month" */
  window?: string | null
  detail?: string | null
  updatedAt: number
  source?: string | null
  resetAt?: number | null
}

export interface DockItem {
  id: string
  name: string
  kind: 'app' | 'url'
  target: string
  icon?: string | null
  badge?: number | null
}

export interface ManualUsage {
  label: string
  used: number | null
  limit: number | null
  unit: string
  resetAt?: number | null
}

export interface Settings {
  placement: Placement
  version: number
  compactItems: CompactItem[]
  onboardingVersion: number
  hotkey: string
  launchAtLogin: boolean
  collapsed: Size
  expanded: Size
  opacity: number
  accent: string
  theme: string
  sizePreset: 'small' | 'medium' | 'large'
  background: 'aurora' | 'reactive' | 'artwork' | 'ember' | 'plain' | 'contours' | 'dots' | 'grid' | 'waves'
  panels: Record<string, string>
  panelOrder: string[]
  widgets: WidgetConfig[]
  connections: AppConnection[]
  dnd: boolean
  /** hide the notch when a maximized/fullscreen window is in front, until hovered */
  hideBehindWindows: boolean
  /** show playback buttons in the collapsed notch for the media item */
  compactMediaControls: boolean
  /** clock face used by the collapsed notch clock item */
  compactClockStyle: 'digital' | 'analog'
  clockTypography: 'rounded' | 'serif' | 'mono'
  clockHourCycle: '12' | '24'
  clockSeconds: boolean
  weatherLat?: number | null
  weatherLon?: number | null
  weatherCity?: string | null
  modules: {
    media: boolean
    visualizer: boolean
    notifications: boolean
    usage: boolean
    dock: boolean
  }
  visualizer: {
    style: 'ambient' | 'aurora' | 'pulse' | 'bloom' | 'silk' | 'halo' | 'orbit' | 'bars' | 'wave' | 'off'
    intensity: number
    reactivity: number
  }
  dock: DockItem[]
  usage: {
    codex: boolean
    claudeCode: boolean
    cursor: boolean
    manual: boolean
    manualConfig: ManualUsage
  }
  notifications: {
    enabled: boolean
    systemListener: boolean
    sound: 'soft' | 'glass' | 'off'
  }
  interaction: { hoverOpen: boolean; openDelayMs: number; closeDelayMs: number }
}

export interface RecycleDroppedPathsResult {
  recycled: number
  failed: number
  cancelled: boolean
}

export type CompactItem = 'media' | 'clock' | 'weather' | 'battery' | 'ai'

/* ------------------------------------------------------------------ defaults */

export const DEFAULT_SETTINGS: Settings = {
  placement: {mode:'notch',edge:'top',monitor:null},
  version: 1,
  compactItems: ['media', 'clock'],
  onboardingVersion: 0,
  hotkey: 'Alt+Space',
  launchAtLogin: false,
  collapsed: { w: 320, h: 38 },
  expanded: { w: 800, h: 560 },
  opacity: 0.96,
  accent: '#818cf8',
  theme: 'midnight',
  sizePreset: 'medium',
  background: 'plain',
  panels: { today: 'Today', desk: 'Desk', activity: 'Activity' },
  panelOrder: ['today', 'desk', 'activity'],
  widgets: [
    { id: 'w-media', kind: 'media', enabled: true, order: 0 },
    { id: 'w-weather', kind: 'weather', enabled: true, order: 1 },
    { id: 'w-calendar', kind: 'calendar', enabled: true, order: 2 },
    { id: 'w-notes', kind: 'notes', enabled: true, order: 3 },
    { id: 'w-ai', kind: 'ai', enabled: true, order: 4 },
    { id: 'w-dock', kind: 'dock', enabled: true, order: 5 },
    { id: 'w-focus', kind: 'focus', enabled: true, order: 6 },
    { id: 'w-system', kind: 'system', enabled: true, order: 7 },
    { id: 'w-notifications', kind: 'notifications', enabled: true, order: 8 },
    { id: 'w-reset-watch', kind: 'reset-watch', enabled: true, order: 9 },
  ],
  connections: [],
  dnd: false,
  hideBehindWindows: true,
  compactMediaControls: true,
  compactClockStyle: 'digital',
  clockTypography: 'rounded',
  clockHourCycle: '12',
  clockSeconds: false,
  modules: { media: true, visualizer: true, notifications: true, usage: true, dock: true },
  visualizer: { style: 'ambient', intensity: 0.7, reactivity: 0.8 },
  dock: [],
  usage: {
    codex: true,
    claudeCode: true,
    cursor: true,
    manual: false,
    manualConfig: { label: 'Custom', used: null, limit: null, unit: 'tokens', resetAt: null },
  },
  notifications: { enabled: true, systemListener: true, sound: 'soft' },
  interaction: { hoverOpen: true, openDelayMs: 140, closeDelayMs: 450 },
}

/* ------------------------------------------------------------------ commands */

export const cmd = {
  placementBeginDrag: () => invoke<void>('placement_begin_drag'),
  placementMove: () => invoke<void>('placement_move'),
  placementSnap: () => invoke<Placement>('placement_snap'),
  placementEndDrag: () => invoke<void>('placement_end_drag'),
  playAlertSound: (kind?: 'soft' | 'glass' | 'off') => invoke<void>('play_alert_sound', { kind }),
  sendTestAlert: () => invoke<void>('send_test_alert'),
  // window
  setExpanded: (expanded: boolean) => invoke<void>('set_expanded', { expanded }),
  applyGeometry: () => invoke<void>('apply_geometry'),
  anchorIsland: () => invoke<void>('anchor_island'),
  setClickThrough: (enabled: boolean) => invoke<void>('set_click_through', { enabled }),
  applyEffects: () => invoke<void>('apply_effects'),
  resizeIsland: () => invoke<void>('resize_island'),
  quit: () => invoke<void>('quit_app'),
  openDevtools: () => invoke<void>('open_devtools'),

  // apps
  appsList: () => invoke<InstalledApp[]>('apps_list'),
  audioLoopbackStart: () => invoke<void>('audio_loopback_start'),
  audioLoopbackStop: () => invoke<void>('audio_loopback_stop'),
  resetWatch: (force=false) => invoke<ResetWatchSnapshot>('reset_watch_get',{force}),
  devicesGet: () => invoke<DeviceSnapshot>('devices_get'),
  appsLaunch: (target: string) => invoke<void>('apps_launch', { target }),
  appsOpenUrl: (url: string) => invoke<void>('apps_open_url', { url }),
  appsOpenWebApp: (url:string) => invoke<void>('apps_open_web_app',{url}),
  acknowledgeQuitRequest: () => invoke<void>('acknowledge_quit_request'),

  // settings
  settingsGet: () => invoke<Settings>('settings_get'),
  settingsSet: (patch: Partial<Settings>) => invoke<Settings>('settings_set', { patch }),
  settingsReset: () => invoke<Settings>('settings_reset'),

  // media
  mediaGet: () => invoke<NowPlaying | null>('media_get'),
  mediaControl: (action: MediaAction, value?: number) =>
    invoke<void>('media_control', { action, value: value ?? null }),

  // notifications
  notificationsGet: () => invoke<AppNotification[]>('notifications_get'),
  notificationsClear: () => invoke<void>('notifications_clear'),
  notificationsAccess: () => invoke<boolean>('notifications_request_access'),

  // usage
  usageGet: () => invoke<UsageSnapshot[]>('usage_get'),
  usageRefresh: () => invoke<UsageSnapshot[]>('usage_refresh'),
  usageDetect: () => invoke<DetectedProvider[]>('usage_detect'),

  // spotlight (Ctrl+Space)
  spotlightSearch: (query: string) => invoke<SearchResult[]>('spotlight_search', { query }),
  spotlightReindex: () => invoke<number>('spotlight_reindex'),

  // windows / settings
  openSettingsWindow: () => invoke<void>('open_settings_window'),
  toggleSettingsWindow: () => invoke<void>('toggle_settings_window'),

  // widgets
  weatherGet: () => invoke<WeatherSnapshot>('weather_get'),
  weatherSearch: (query: string) => invoke<WeatherLocation[]>('weather_search', { query }),
  calendarGet: () => invoke<CalendarEvent[]>('calendar_get'),
  calendarSave: (event: CalendarEvent) => invoke<CalendarEvent[]>('calendar_save', { event }),
  calendarDelete: (id: string) => invoke<CalendarEvent[]>('calendar_delete', { id }),
  calendarImportIcs: (contents: string) => invoke<CalendarEvent[]>('calendar_import_ics', { contents }),
  setInteractionBounds: (width:number, height:number) => invoke<void>('set_interaction_bounds', { width, height }),
  notesGet: () => invoke<NotesState>('notes_get'),
  notesSet: (text: string) => invoke<void>('notes_set', { text }),
  connectionsList: () => invoke<AppConnection[]>('connections_list'),
  systemStats: () => invoke<SystemStats>('system_stats'),
  quickControlsGet: () => invoke<QuickControlsSnapshot>('quick_controls_get'),
  openNightLightSettings: () => invoke<void>('open_night_light_settings'),
  openBluetoothSettings: () => invoke<void>('open_bluetooth_settings'),
  openPowerSettings: () => invoke<void>('open_power_settings'),
  openWindowsSettings: (page: 'sound' | 'display' | 'notifications') => invoke<void>('open_windows_settings', { page }),
  setBluetoothRadio: (enabled: boolean) => invoke<boolean>('set_bluetooth_radio', { enabled }),
  setBestPowerEfficiency: (enabled: boolean) => invoke<void>('set_power_saver_plan', { enabled }),
  setMasterVolume: (level: number) => invoke<void>('set_master_volume', { level }),
  setMute: (muted: boolean) => invoke<void>('set_mute', { muted }),
  setBrightness: (level: number) => invoke<void>('set_brightness', { level }),
  setNightLight: (enabled: boolean) => invoke<void>('set_night_light', { enabled }),
  setDoNotDisturb: (enabled: boolean) => invoke<void>('set_do_not_disturb', { enabled }),
  memoryScan: () => invoke<MemoryCandidate[]>('memory_scan'),
  memoryReclaim: (ids: string[]) => invoke<MemoryReclaimResult[]>('memory_reclaim', { ids }),
  airDropCapability: () => invoke<AirDropCapability>('airdrop_capability'),

  // temporary local-network phone bucket
  transferStatus: () => invoke<TransferStatus>('transfer_status'),
  transferStart: () => invoke<TransferStatus>('transfer_start'),
  transferStageDroppedPaths: (paths: string[]) => invoke<TransferStatus>('transfer_stage_dropped_paths', { paths }),
  transferStop: () => invoke<void>('transfer_stop'),
  transferPairingStatus: () => invoke<PhonePairingStatus>('transfer_pairing_status'),
  transferPairingDecide: (pairId: string, allow: boolean) => invoke<void>('transfer_pairing_decide', { pairId, allow }),
  transferPairingRemove: (deviceId: string) => invoke<boolean>('transfer_pairing_remove', { deviceId }),
  transferOpenFolder: () => invoke<void>('transfer_open_folder'),
  recycleDroppedPaths: (paths: string[]) => invoke<RecycleDroppedPathsResult>('recycle_dropped_paths', { paths }),

  // nearby / airdrop-style transfer
  nearbyStatus: () => invoke<NearbyStatus>('nearby_status'),
  nearbyStart: () => invoke<NearbyStatus>('nearby_start'),
  nearbyStop: () => invoke<void>('nearby_stop'),
  nearbySend: (target: string, paths: string[]) => invoke<void>('nearby_send', { target, paths }),
  nearbyApprove: (sessionId: string, approved: boolean) => invoke<void>('nearby_approve', { sessionId, approved }),
}

/* ------------------------------------------------------------------ events */

export const EVT = {
  mediaChanged: 'media://changed',
  notificationsChanged: 'notifications://changed',
  usageChanged: 'usage://changed',
  spotlightOpen: 'spotlight://open',
  aiEvent: 'ai://event',
} as const

export const onMediaChanged = (cb: (m: NowPlaying | null) => void): Promise<UnlistenFn> =>
  listen<NowPlaying | null>(EVT.mediaChanged, (e) => cb(e.payload))

export const onExpandedChanged = (cb: (expanded: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>('island://expanded', (e) => cb(e.payload))

export const onIslandHover = (cb: (hovering: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>('island://hover', (e) => cb(e.payload))
export const onAudioSpectrum = (cb: (value: { bands: number[] }) => void): Promise<UnlistenFn> => listen<{ bands: number[] }>('audio://spectrum', event => cb(event.payload))
export const onAudioSpectrumError = (cb: (message: string) => void): Promise<UnlistenFn> => listen<string>('audio://spectrum-error', event => cb(event.payload))

export const onQuitRequested = (cb: () => void): Promise<UnlistenFn> =>
  listen<boolean>('app://quit-request', () => cb())

export const onSettingsChanged = (cb: (settings: Settings) => void): Promise<UnlistenFn> =>
  listen<Settings>('settings://changed', (e) => cb(e.payload))

export const onNotificationsChanged = (cb: (n: AppNotification[]) => void): Promise<UnlistenFn> =>
  listen<AppNotification[]>(EVT.notificationsChanged, (e) => cb(e.payload))

export const onUsageChanged = (cb: (u: UsageSnapshot[]) => void): Promise<UnlistenFn> =>
  listen<UsageSnapshot[]>(EVT.usageChanged, (e) => cb(e.payload))

export const onAiEvent = (cb: (event: AiEvent) => void): Promise<UnlistenFn> =>
  listen<AiEvent>(EVT.aiEvent, (e) => cb(e.payload))

/* ------------------------------------------------------------------ spotlight */

export interface SearchResult {
  id: string
  title: string
  subtitle?: string | null
  /** "app" | "file" | "url" | "calc" | "web" | "command" */
  kind: string
  icon?: string | null
  /** "launch" | "open" | "copy" | "run" */
  action: string
  target: string
  score: number
}

export const onSpotlightOpen = (cb: (wasExpanded?: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>(EVT.spotlightOpen, (e) => cb(e.payload))

/* ------------------------------------------------------------------ nearby */

export interface NearbyPeer {
  id: string
  name: string
  address: string
  port: number
}

export interface NearbyTransfer {
  id: string
  peer: string
  /** "send" | "receive" */
  direction: string
  fileName: string
  bytes: number
  total: number
  /** "active" | "done" | "failed" */
  status: string
}

export interface NearbyStatus {
  running: boolean
  deviceName: string
  port: number
  peers: NearbyPeer[]
  transfers: NearbyTransfer[]
  detail?: string | null
}

/* ------------------------------------------------------------------ widgets */

export type WidgetKind =
  | 'web-alerts'
  | 'media'
  | 'weather'
  | 'calendar'
  | 'notes'
  | 'usage'
  | 'notifications'
  | 'dock'
  | 'nearby'
  | 'ai'
  | 'focus'
  | 'system'
  | 'airdrop'
  | 'reset-watch'
  | 'clock'
  | 'bluetooth'
  | 'controls'

export interface WidgetConfig {
  id: string
  kind: WidgetKind
  enabled: boolean
  order: number
  panel?: string
  clockStyle?: 'analog' | 'digital'
}

/** A "connected" web app (WhatsApp Web, Gmail, Instagram, …). */
export interface AppConnection {
  id: string
  name: string
  url: string
  /** data: URL or remote URL */
  icon?: string | null
  /** surface its notifications in the notch */
  notifications: boolean
  notificationSources?: string[]
}

export interface WeatherSnapshot {
  ok: boolean
  city: string
  tempC: number
  hiC: number
  loC: number
  /** WMO weather code */
  code: number
  label: string
  updatedAt: number
  aqi?: number | null
  aqiLabel?: string | null
  locationSource?: string | null
  stale?: boolean | null
}

export interface ResetAnnouncement { id: string; kind: 'global' | 'banked'; title: string; publishedAt: number; sourceUrl: string; reportedBy: string; status: 'landed' | 'announced' | 'expected' | 'awaiting_confirmation'; landingAt?: number | null; upcoming?: boolean }
export interface DeviceSnapshot { bluetooth: string[]; charging: boolean | null; error?: string | null }
export interface ResetWatchSnapshot { events: ResetAnnouncement[]; lastCheckedAt: number; sourceUpdatedAt?: number | null; source: string; stale: boolean; error?: string | null }

export interface WeatherLocation {
  name:string
  admin1?:string | null
  country?:string | null
  latitude:number
  longitude:number
}

export interface CalendarEvent {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  location?: string | null
}

export interface NotesState {
  text: string
}

export interface SystemStats {
  cpuPercent:number | null
  memoryUsedBytes:number
  memoryTotalBytes:number
  batteryPercent:number | null
  charging:boolean
}
export interface VolumeControl {
  supported: boolean
  /** Master volume 0-100, or null when Windows does not report it. */
  level: number | null
  muted: boolean | null
  error?: string | null
}
export interface BrightnessControl {
  supported: boolean
  /** Brightness 0-100, or null when the display cannot control it (e.g. desktop). */
  level: number | null
  error?: string | null
}
export interface BluetoothControl {
  supported: boolean
  enabled: boolean | null
  error?: string | null
}
export interface PowerModeControl {
  activeName: string | null
  supported: boolean
  bestEfficiencyActive: boolean
  canRestorePrevious: boolean
  error?: string | null
}
export interface BestEffortToggleControl {
  supported: boolean
  enabled: boolean | null
  /** Night light / Do Not Disturb ride undocumented Windows state, not a public API. */
  bestEffort: boolean
  error?: string | null
}
export interface QuickControlsSnapshot {
  volume: VolumeControl
  brightness: BrightnessControl
  bluetooth: BluetoothControl
  powerMode: PowerModeControl
  nightLight: BestEffortToggleControl
  doNotDisturb: BestEffortToggleControl
}
export interface MemoryCandidate { id: string; name: string; workingSetBytes: number }
export interface MemoryReclaimResult { id: string; name: string; releasedWorkingSetBytes: number; error?: string | null }
export interface MemoryReclaimProgress { total: number; completed: number; releasedWorkingSetBytes: number; skipped: number }
export const onMemoryReclaimProgress = (cb: (progress: MemoryReclaimProgress) => void): Promise<UnlistenFn> =>
  listen<MemoryReclaimProgress>('memory://progress', event => cb(event.payload))
export interface AirDropCapability {
  protocol:string
  backend:string
  adapter:string
  hardwareSupportedByOmdropOwl:boolean
  windowsMonitorMode:boolean | null
  npcapWlanHelperPresent:boolean
  ready:boolean
  reason:string
}

export interface TransferFile { id:string; name:string; size:number; createdAt:number }
export interface TransferStatus {
  active:boolean
  phoneUrl:string | null
  desktopUrl:string | null
  bookmarkUrl:string | null
  stableBookmark:boolean
  qrDataUrl:string | null
  expiresAt:number | null
  files:TransferFile[]
  saveFolder:string
  maxFileBytes:number
  maxBucketBytes:number
  error?:string | null
}
export interface PairedPhone { id:string; name:string; lastSeen:number | null; online:boolean }
export interface PendingPhonePair { id:string; name:string; code:string; expiresAt:number }
export interface PhonePairingStatus { devices:PairedPhone[]; pending:PendingPhonePair[] }
