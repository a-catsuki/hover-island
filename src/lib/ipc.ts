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

export interface LyricsLine {
  /** Playback time in seconds. */
  at: number
  text: string
}

export interface LyricsResult {
  status: 'ok' | 'not_found' | 'no_timed_lyrics' | 'invalid_track' | 'rate_limited' | 'unavailable'
  provider: string
  lines: LyricsLine[]
  /** False for plain lyrics: every `at` is 0 and the lines must not be followed in time. Absent means timed. */
  timed?: boolean
  retryAfterSeconds?: number
}

export interface EmailCodeAccount {
  id: string
  provider: 'google' | 'microsoft'
  address: string
  paused: boolean
  connectedAt: number
  lastError?: string | null
}

export interface EmailCodesSnapshot {
  accounts: EmailCodeAccount[]
  lastError?: string | null
}

export interface EmailCodeEvent {
  id: string
  code: string
  sender: string
  subject: string
  account: string
  receivedAt: number
  expiresAt: number
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
  category?: 'erp' | 'website' | 'transfer' | 'ai' | 'ai-activity' | 'preference' | 'auth' | 'feedback'
  phase?: 'staging' | 'receiving' | 'sending' | 'ready' | 'sent' | 'complete' | 'error'
  progress?: number | null
  transferId?: string
  priority?: 'normal' | 'high' | 'urgent'
  url?: string
  /** AI peek variant: 'complete' celebrates, 'needs-input' pulses for attention. */
  aiKind?: 'complete' | 'needs-input'
  /** Live agent activity shown by the AI toast (category 'ai-activity'). */
  aiActivity?: AiActivityEvent
  code?: string
  sender?: string
  account?: string
  subject?: string
  expiresAt?: number
  /** Short action toast (category 'feedback'): glyph id and error styling. */
  feedbackIcon?: string
  feedbackError?: boolean
  /** Buttons a peek can offer (Snooze, Done...). The peek renderer sends the chosen id to the owning feature. */
  actions?: Array<{ id: string; label: string; primary?: boolean }>
  /** The feature that owns `actions`. */
  actionOwner?: 'reminders' | 'awake'
  /** Reminder id for reminder peeks. */
  reminderId?: string
}

export interface InstalledApp {
  id: string
  name: string
  target: string
  /** Path for win32/url apps, the AppUserModelId for uwp apps. */
  kind: 'win32' | 'uwp' | 'url' | 'desktop'
  /** Not filled by appsList; load lazily with cmd.appsIcon(id). */
  icon?: string | null
  /** Last run recorded by Windows (ms since epoch) and its run count. */
  lastUsed?: number | null
  useCount?: number
}

export interface AppsUsage {
  apps: { id: string; lastUsed: number | null; useCount: number }[]
  recentFiles: { name: string; path: string; lastUsed: number }[]
}

export type UsageProviderKind = 'codex' | 'claude-code' | 'cursor' | 'gemini' | 'opencode' | 'github-copilot' | 'aider' | 'manual'

/** One recent agent session found in a provider's local logs. */
export interface RecentSession {
  id: string
  title: string
  project?: string | null
  startedAt?: number | null
  lastActiveAt: number
  tokens?: number | null
  active: boolean
}

/** Session level facts for a provider, derived from its local logs. */
export interface ActivityInfo {
  installed: boolean
  sessions24h: number
  sessions7d: number
  lastActiveAt?: number | null
  /** Mean prompt to first reply time over the last 24 hours. */
  avgResponseMs?: number | null
  responses24h: number
  activeNow: boolean
  activeSessions: number
  recent: RecentSession[]
}

export type AiActivityKind = 'started' | 'progress' | 'question' | 'completed' | 'failed'

/** Payload of the `ai://activity` event. */
export interface AiActivityEvent {
  kind: AiActivityKind
  provider: string
  title: string
  detail: string
  percent?: number | null
  durationMs?: number | null
  ts: number
  sessionId?: string | null
  source?: 'log' | 'hook'
}

export interface HookPreview {
  provider: string
  label: string
  path: string
  exists: boolean
  installed: boolean
  changed: boolean
  applied: boolean
  diff: string
  backupPath?: string | null
  events: string[]
  note?: string | null
}

export interface HookStatus {
  provider: string
  label: string
  path: string
  available: boolean
  installed: boolean
  stale: boolean
}

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
  /** Running now or used within the last week. False means installed but idle. */
  active?: boolean
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
  activity?: ActivityInfo | null
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
  spotlightHotkey: string
  launchAtLogin: boolean
  autoUpdate: boolean
  collapsed: Size
  expanded: Size
  opacity: number
  accent: string
  theme: string
  sizePreset: 'small' | 'medium' | 'large'
  background: 'aurora' | 'reactive' | 'artwork' | 'ember' | 'plain' | 'contours' | 'dots' | 'grid' | 'waves'
  panels: Record<string, string>
  panelOrder: string[]
  /** Custom page names by panel id (trimmed, 16 chars max). Empty means defaults. */
  panelNames: Record<string, string>
  widgets: WidgetConfig[]
  connections: AppConnection[]
  dnd: boolean
  /** hide the notch when a maximized/fullscreen window is in front, until hovered */
  hideBehindWindows: boolean
  /** show playback buttons in the collapsed notch for the media item */
  compactMediaControls: boolean
  /** clock face used by the collapsed notch clock item */
  compactClockStyle: 'digital' | 'analog'
  /** Windows' own toast banners: normal, hidden while the app runs, or hidden and cleared from Action Center once surfaced. */
  windowsBanners: 'normal' | 'quiet' | 'clear'
  /** Small AI stat in the collapsed notch. */
  compactAiStat: 'off' | 'usage-left' | 'response-time' | 'active-count'
  /** Show live AI agent toasts. */
  aiToastsEnabled: boolean
  /** Provider ids that may raise toasts; empty means all. */
  aiToastProviders: string[]
  clockTypography: 'rounded' | 'serif' | 'mono'
  clockHourCycle: '12' | '24'
  clockSeconds: boolean
  weatherLat?: number | null
  weatherLon?: number | null
  weatherCity?: string | null
  weatherAutoLocation: boolean
  weatherUnits: 'metric' | 'imperial'
  modules: {
    media: boolean
    visualizer: boolean
    notifications: boolean
    usage: boolean
    dock: boolean
  }
  visualizer: {
    style: 'ambient' | 'aurora' | 'pulse' | 'bloom' | 'silk' | 'halo' | 'orbit' | 'bars' | 'mirror' | 'radial' | 'particles' | 'wave' | 'off'
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

export interface UpdateStatus { current: string; latest: string | null; available: boolean; notes: string; checkedAt: number; error: string | null }

export const DEFAULT_SETTINGS: Settings = {
  placement: {mode:'notch',edge:'top',monitor:null},
  version: 1,
  compactItems: ['media', 'clock'],
  onboardingVersion: 0,
  hotkey: 'Alt+Space',
  spotlightHotkey: 'Control+Space',
  launchAtLogin: false,
  autoUpdate: true,
  collapsed: { w: 288, h: 32 },
  expanded: { w: 800, h: 510 },
  opacity: 0.96,
  accent: '#0a84ff',
  theme: 'midnight',
  sizePreset: 'medium',
  background: 'plain',
  panels: { today: 'Today', desk: 'Desk', activity: 'Activity' },
  panelOrder: ['today', 'desk', 'activity'],
  panelNames: {},
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
  compactMediaControls: false,
  compactClockStyle: 'digital',
  windowsBanners: 'normal',
  compactAiStat: 'off',
  aiToastsEnabled: true,
  aiToastProviders: [],
  clockTypography: 'rounded',
  clockHourCycle: '12',
  clockSeconds: false,
  weatherAutoLocation: false,
  weatherUnits: 'metric',
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
  /** Rescans installed apps (at most once a minute) and returns the fresh list. */
  appsRefresh: () => invoke<InstalledApp[]>('apps_refresh'),
  /** Windows usage: UserAssist run counts and last run per app id, plus recently opened documents. */
  appsUsage: () => invoke<AppsUsage>('apps_usage'),
  /** Logo for an app id from appsList as a PNG data URL, or null. Cached; lookups time out after 5 s. */
  appsIcon: (id: string, size = 56) => invoke<string | null>('apps_icon', { id, size }),
  audioLoopbackStart: () => invoke<void>('audio_loopback_start'),
  audioLoopbackStop: () => invoke<void>('audio_loopback_stop'),
  /** `low` = ~15 Hz bands only (collapsed pill, ambient scenes); `false` = full ~30 Hz stream. */
  audioSetDetail: (low: boolean) => invoke<void>('audio_set_detail', { low }),
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
  updateCheck: () => invoke<UpdateStatus>('update_check'),
  updateInstall: () => invoke<void>('update_install'),
  lyricsLookup: (trackName: string, artistName: string, albumName: string | null, duration: number) =>
    invoke<LyricsResult>('lyrics_lookup', { trackName, artistName, albumName, duration }),

  // opt-in email verification code connectors
  emailCodesAccounts: () => invoke<EmailCodesSnapshot>('email_codes_accounts'),
  emailCodesAuthorize: (provider: 'google' | 'microsoft', clientId: string, clientSecret?: string) =>
    invoke<EmailCodeAccount>('email_codes_authorize', { provider, clientId, clientSecret: clientSecret || null }),
  emailCodesRemove: (id: string) => invoke<void>('email_codes_remove', { id }),
  emailCodesSetPaused: (id: string, paused: boolean) => invoke<EmailCodesSnapshot>('email_codes_set_paused', { id, paused }),

  // notifications
  notificationsGet: () => invoke<AppNotification[]>('notifications_get'),
  notificationsClear: () => invoke<void>('notifications_clear'),
  notificationsDismiss: (id: string) => invoke<void>('notifications_dismiss', { id }),
  notificationsAccess: () => invoke<boolean>('notifications_request_access'),
  notificationsAccessStatus: () => invoke<{packaged:boolean;status:'allowed'|'denied'|'not-requested'|'unpackaged'}>('notifications_access_status'),
  notificationsTestConnection: (id:string) => invoke<void>('notifications_test_connection',{id}),

  // usage
  usageGet: () => invoke<UsageSnapshot[]>('usage_get'),
  usageRefresh: () => invoke<UsageSnapshot[]>('usage_refresh'),
  usageDetect: () => invoke<DetectedProvider[]>('usage_detect'),
  agentEventsInfo: () => invoke<{ enabled: boolean; running: boolean; port: number | null }>('agent_events_info'),
  agentEventsRecent: () => invoke<AiActivityEvent[]>('agent_events_recent'),
  agentHooksStatus: () => invoke<HookStatus[]>('agent_hooks_status'),
  /** dryRun true only previews the change; false writes it (after a preview). */
  agentHooksInstall: (provider: string, dryRun: boolean) => invoke<HookPreview>('agent_hooks_install', { provider, dryRun }),
  agentHooksUninstall: (provider: string, dryRun: boolean) => invoke<HookPreview>('agent_hooks_uninstall', { provider, dryRun }),

  // spotlight (Ctrl+Space)
  spotlightSearch: (query: string) => invoke<SearchResult[]>('spotlight_search', { query }),
  spotlightReindex: () => invoke<number>('spotlight_reindex'),

  // windows / settings
  openSettingsWindow: () => invoke<void>('open_settings_window'),
  openSettings: (page?: string) => invoke<void>('open_settings_window', { page: page ?? null }),
  toggleSettingsWindow: () => invoke<void>('toggle_settings_window'),

  // widgets
  weatherGet: () => invoke<WeatherSnapshot>('weather_get'),
  networkPing: (host?: string, samples?: number) => invoke<NetworkPingResult>('network_ping', { host, samples }),
  networkSpeedtest: () => invoke<NetworkSpeedtestResult>('network_speedtest'),
  networkSpeedtestCancel: () => invoke<void>('network_speedtest_cancel'),
  networkInfo: () => invoke<NetworkInfo>('network_info'),
  weatherDetectLocation: () => invoke<DeviceLocation>('weather_detect_location'),
  weatherOpenLocationSettings: () => invoke<void>('weather_open_location_settings'),
  weatherSearch: (query: string) => invoke<WeatherLocation[]>('weather_search', { query }),
  calendarGet: () => invoke<CalendarEvent[]>('calendar_get'),
  calendarSave: (event: CalendarEvent) => invoke<CalendarEvent[]>('calendar_save', { event }),
  calendarDelete: (id: string) => invoke<CalendarEvent[]>('calendar_delete', { id }),
  calendarImportIcs: (contents: string) => invoke<CalendarEvent[]>('calendar_import_ics', { contents }),
  setInteractionBounds: (width:number, height:number) => invoke<void>('set_interaction_bounds', { width, height }),
  notesGet: () => invoke<NotesState>('notes_get'),
  notesSet: (text: string) => invoke<void>('notes_set', { text }),

  // keep me awake
  awakeStart: (endEpochMs: number, intensity: AwakeIntensity, volume: number, sound: string) =>
    invoke<AwakeStatus>('awake_start', { endEpochMs, intensity, volume, sound }),
  awakeStop: () => invoke<AwakeStatus>('awake_stop'),
  awakeConfirm: (snoozeMinutes?: number) => invoke<AwakeStatus>('awake_confirm', { snoozeMinutes: snoozeMinutes ?? null }),
  awakeAudioAck: (seq: number) => invoke<void>('awake_audio_ack', { seq }),
  awakeStatus: () => invoke<AwakeStatus>('awake_status'),

  // reminders
  remindersList: () => invoke<Reminder[]>('reminders_list', { tzOffsetMin: new Date().getTimezoneOffset() }),
  remindersSave: (reminder: Reminder) => invoke<Reminder[]>('reminders_save', { reminder, tzOffsetMin: new Date().getTimezoneOffset() }),
  remindersDone: (id: string) => invoke<Reminder[]>('reminders_done', { id, tzOffsetMin: new Date().getTimezoneOffset() }),
  remindersSnooze: (id: string, minutes: number) => invoke<Reminder[]>('reminders_snooze', { id, minutes }),
  remindersDelete: (id: string) => invoke<Reminder[]>('reminders_delete', { id }),
  remindersClearDone: () => invoke<Reminder[]>('reminders_clear_done'),
  connectionsList: () => invoke<AppConnection[]>('connections_list'),
  systemStats: () => invoke<SystemStats>('system_stats'),
  quickControlsGet: () => invoke<QuickControlsSnapshot>('quick_controls_get'),
  openNightLightSettings: () => invoke<void>('open_night_light_settings'),
  openBluetoothSettings: () => invoke<void>('open_bluetooth_settings'),
  openPowerSettings: () => invoke<void>('open_power_settings'),
  openWindowsSettings: (page: 'sound' | 'display' | 'notifications' | 'notification-access' | 'bluetooth' | 'wifi' | 'airplane' | 'colors' | 'battery' | 'focus') => invoke<void>('open_windows_settings', { page }),
  setBluetoothRadio: (enabled: boolean) => invoke<boolean>('set_bluetooth_radio', { enabled }),
  bluetoothRadioGet: () => invoke<BluetoothControl>('bluetooth_radio_get'),
  setWifiRadio: (enabled: boolean) => invoke<boolean>('set_wifi_radio', { enabled }),
  setAirplaneMode: (enabled: boolean) => invoke<boolean>('set_airplane_mode', { enabled }),
  setDarkMode: (enabled: boolean) => invoke<void>('set_dark_mode', { enabled }),
  bluetoothDevicesList: () => invoke<BluetoothManagedDevice[]>('bluetooth_devices_list'),
  bluetoothDevicesSnapshot: () => invoke<BluetoothSnapshot>('bluetooth_devices_snapshot'),
  bluetoothConnect: (deviceId: string) => invoke<BluetoothManagedDevice>('bluetooth_connect', { deviceId }),
  bluetoothDisconnect: (deviceId: string) => invoke<BluetoothManagedDevice>('bluetooth_disconnect', { deviceId }),
  bluetoothUnpair: (deviceId: string) => invoke<void>('bluetooth_unpair', { deviceId }),
  bluetoothOpenSettings: () => invoke<void>('bluetooth_open_settings'),
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
  transferBucketPaths: () => invoke<string[]>('transfer_bucket_paths'),
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
  aiActivity: 'ai://activity',
  authCode: 'auth://code',
  authError: 'auth://error',
  authConnectionsChanged: 'auth://connections-changed',
} as const

export const onMediaChanged = (cb: (m: NowPlaying | null) => void): Promise<UnlistenFn> =>
  listen<NowPlaying | null>(EVT.mediaChanged, (e) => cb(e.payload))

export const onExpandedChanged = (cb: (expanded: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>('island://expanded', (e) => cb(e.payload))

export const onIslandReveal = (cb: (near: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>('island://reveal', (e) => cb(e.payload))
export const onIslandHover = (cb: (hovering: boolean) => void): Promise<UnlistenFn> =>
  listen<boolean>('island://hover', (e) => cb(e.payload))
export interface AudioSpectrumFrame {
  bands: number[]
  waveform: number[]
  /** Uncompressed physical levels; all remaining drives are perceptual 0..1. */
  rms: number
  peak: number
  energy: number
  bass: number
  mid: number
  treble: number
  flux: number
  onset: number
  sequence: number
  beatSequence: number
  beatAtMs: number
  capturedAtMs: number
  sampleRate: number
}
export const onAudioSpectrum = (cb: (value: AudioSpectrumFrame) => void): Promise<UnlistenFn> => listen<AudioSpectrumFrame>('audio://spectrum', event => cb(event.payload))
export const onAudioSpectrumError = (cb: (message: string) => void): Promise<UnlistenFn> => listen<string>('audio://spectrum-error', event => cb(event.payload))
export const onAudioCaptureReady = (cb: () => void): Promise<UnlistenFn> => listen<void>('audio://capture-ready', () => cb())

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

export const onAiActivity = (cb: (event: AiActivityEvent) => void): Promise<UnlistenFn> =>
  listen<AiActivityEvent>(EVT.aiActivity, (e) => cb(e.payload))

export const onEmailCode = (cb: (event: EmailCodeEvent) => void): Promise<UnlistenFn> =>
  listen<EmailCodeEvent>(EVT.authCode, event => cb(event.payload))
export const onEmailCodesError = (cb: (message: string) => void): Promise<UnlistenFn> =>
  listen<string>(EVT.authError, event => cb(event.payload))
export const onEmailCodesChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen<void>(EVT.authConnectionsChanged, () => cb())

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
  | 'network'
  | 'awake'
  | 'reminders'

export interface WidgetConfig {
  id: string
  kind: WidgetKind
  enabled: boolean
  order: number
  panel?: string
  clockStyle?: 'analog' | 'digital'
  /** Shape on the 2x2 notch grid: compact 1x1, wide 2x1, tall 1x2, full 2x2. */
  size?: 'compact' | 'wide' | 'tall' | 'full'
  showLyrics?: boolean
  /** The grid cell the user dropped this widget into; absent means flow order. */
  slot?: { row: number; column: number }
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

/** TCP connect timing to a host, from the Network widget. Times are milliseconds. */
export interface NetworkPingResult {
  host: string
  address: string | null
  port: number
  sent: number
  received: number
  lossPct: number
  minMs: number | null
  avgMs: number | null
  maxMs: number | null
  jitterMs: number | null
  samplesMs: (number | null)[]
}
export interface NetworkSpeedtestResult {
  downloadMbps: number
  uploadMbps: number
  latencyMs: number
  jitterMs: number
  bytesDown: number
  bytesUp: number
  finishedAt: number
  server: string
  cancelled: boolean
}
/** Payload of the `network://speedtest` event. */
export interface NetworkSpeedProgress {
  phase: 'latency' | 'download' | 'upload' | 'done' | 'cancelled' | 'error'
  mbps: number
  progress: number
  latencyMs: number | null
  jitterMs: number | null
  downloadMbps: number | null
  uploadMbps: number | null
  message: string | null
}
export interface NetworkInfo {
  kind: 'wifi' | 'wired' | 'offline' | 'unknown'
  ssid: string | null
  signalPct: number | null
  linkMbps: number | null
  radio: string | null
  localIp: string | null
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
  feelsLikeC?: number | null
  humidityPct?: number | null
  windSpeedKmh?: number | null
  windDirectionDeg?: number | null
  precipitationMm?: number | null
  isDay?: boolean | null
  pressureHpa?: number | null
  cloudCoverPct?: number | null
  timezone?: string | null
  hourly?: WeatherHour[]
  daily?: WeatherDay[]
  pm25?: number | null
  pm10?: number | null
}

export interface WeatherHour {
  time: string
  temperatureC: number
  code: number
  precipitationProbability?: number | null
}

export interface WeatherDay {
  date: string
  code: number
  highC: number
  lowC: number
  sunrise?: string | null
  sunset?: string | null
  precipitationProbability?: number | null
  uvIndexMax?: number | null
  windSpeedMaxKmh?: number | null
}

export interface ResetAnnouncement { id: string; kind: 'global' | 'banked'; title: string; publishedAt: number; sourceUrl: string; reportedBy: string; status: 'landed' | 'announced' | 'expected' | 'awaiting_confirmation'; landingAt?: number | null; upcoming?: boolean }
export interface DeviceSnapshot { bluetooth: string[]; charging: boolean | null; error?: string | null }
export interface BluetoothManagedDevice {
  id: string
  name: string
  kind: string
  paired: boolean
  connected: boolean | null
  batteryPct: number | null
  canConnect: boolean
  canDisconnect: boolean
  canUnpair: boolean
  actionReason?: string | null
}
export interface BluetoothSourceReport { source: string; ok: boolean; count: number; error?: string | null }
export interface BluetoothSnapshot { devices: BluetoothManagedDevice[]; sources: BluetoothSourceReport[]; error?: string | null }
export interface ResetWatchSnapshot { events: ResetAnnouncement[]; lastCheckedAt: number; sourceUpdatedAt?: number | null; source: string; stale: boolean; error?: string | null }

/** Result of "use device location": Windows Location, or an approximate network lookup. */
export interface DeviceLocation {
  location: WeatherLocation
  method: 'windows' | 'network'
  /** Why a fallback was used, when it was. */
  notice?: string | null
  canOpenSettings: boolean
}

/** Rejection value of `weather_detect_location`. */
export interface LocationFailure {
  code: 'windows_disabled' | 'offline' | 'timeout' | 'unavailable'
  message: string
  canOpenSettings: boolean
}

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

export type AwakeIntensity = 'gentle' | 'medium' | 'relentless'

/** Native state of the Keep me awake session (src-tauri/src/awake.rs). */
export interface AwakeStatus {
  active: boolean
  endEpochMs: number
  startedAtMs: number
  intensity: AwakeIntensity
  volume: number
  sound: string
  nextAlarmAtMs: number | null
  pending: boolean
  pendingSinceMs: number | null
  level: number
  alarmCount: number
  seq: number
  lastConfirmedAtMs: number | null
  snoozedUntilMs: number | null
  keepingAwake: boolean
  nowMs: number
}

/** Payload of `awake://alarm`. */
export interface AwakeAlarm {
  seq: number
  level: number
  final: boolean
  volume: number
  sound: string
  status: AwakeStatus
}

export interface ReminderRecur {
  kind: 'daily' | 'weekdays' | 'weekly'
  hour: number
  minute: number
  weekday?: number | null
}

/** A timed reminder (src-tauri/src/reminders.rs). */
export interface Reminder {
  id: string
  title: string
  /** next time it is due, epoch ms */
  due: number
  recur?: ReminderRecur | null
  important: boolean
  done: boolean
  doneAt?: number | null
  /** the due alert went out and nobody answered yet */
  firedAt?: number | null
  /** the due time that passed while the app was closed */
  missedAt?: number | null
  /** id of the linked Notes item */
  link?: string | null
  createdAt: number
  snoozes: number
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
  /** Optional so older native builds and previews still type-check. */
  wifi?: ToggleControl
  airplane?: ToggleControl
  /** `enabled` means dark theme. */
  theme?: ToggleControl
  batterySaver?: ToggleControl
}
export interface ToggleControl {
  supported: boolean
  enabled: boolean | null
  bestEffort: boolean
  /** Windows shows the state but offers no way to change it. */
  readOnly: boolean
  error?: string | null
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
