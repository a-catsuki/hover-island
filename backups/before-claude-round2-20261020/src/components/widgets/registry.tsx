import type { JSX } from 'solid-js'
import {
  Bell,
  CalendarDays,
  CloudSun,
  Gauge,
  LayoutGrid,
  Music,
  NotebookPen,
  Radio,
  Sparkles,
  Timer,
  Activity,
  SlidersHorizontal,
} from 'lucide-solid'
import type { WidgetConfig, WidgetKind } from '../../lib/ipc'
import { patchSettings, settings } from '../../state/settings'
import MediaView from '../views/MediaView'
import UsageView from '../views/UsageView'
import NotificationsView from '../views/NotificationsView'
import DockView from '../views/DockView'
import NearbyView from '../views/NearbyView'
import WeatherView from './WeatherView'
import CalendarView from './CalendarView'
import NotesView from './NotesView'
import AiView from './AiView'
import FocusView from './FocusView'
import SystemView from './SystemView'
import AirDropView from './AirDropView'
import ClockView from './ClockView'
import ResetWatchView from './ResetWatchView'
import BluetoothView from './BluetoothView'
import QuickSettingsView from '../views/QuickSettingsView'
import WebsiteAlertsView from './ErpView'

export interface WidgetDef {
  kind: WidgetKind
  label: string
  hint: string
  /** larger widgets span two columns of the notch grid */
  wide: boolean
  icon: () => JSX.Element
  render: (widget?: WidgetConfig) => JSX.Element
}

export const WIDGETS: Record<WidgetKind, WidgetDef> = {
  'web-alerts': {kind:'web-alerts',label:'Website alerts',hint:'Alerts from websites you choose',wide:true,icon:()=><Bell size={15}/>,render:()=><WebsiteAlertsView/>},
  controls: { kind:'controls', label:'PC controls', hint:'Bluetooth, power and memory', wide:true, icon:()=><SlidersHorizontal size={15}/>, render:()=><QuickSettingsView/> },
  bluetooth: { kind:'bluetooth',label:'Connections',hint:'Bluetooth devices and power',wide:false,icon:()=><Radio size={15}/>,render:()=><BluetoothView/> },
  clock: { kind: 'clock', label: 'World clock', hint: 'Local time, London and San Francisco', wide: false, icon: () => <Timer size={15}/>, render: (widget) => <ClockView style={widget?.clockStyle ?? 'analog'}/> },
  'reset-watch': { kind: 'reset-watch', label: 'Reset watch', hint: 'Global and banked Codex announcements', wide: false, icon: () => <Gauge size={15}/>, render: () => <ResetWatchView/> },
  focus:{kind:'focus',label:'Focus timer',hint:'Make space for uninterrupted work',wide:false,icon:()=> <Timer size={15}/>,render:()=> <FocusView/>},
  system:{kind:'system',label:'System',hint:'CPU, memory and battery',wide:false,icon:()=> <Activity size={15}/>,render:()=> <SystemView/>},
  airdrop:{kind:'airdrop',label:'AirDrop',hint:'iPhone radio capability and native transport',wide:false,icon:()=> <Radio size={15}/>,render:()=> <AirDropView/>},
  media: {
    kind: 'media',
    label: 'Media',
    hint: 'Now playing and playback controls',
    wide: true,
    icon: () => <Music class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: (widget) => <MediaView compact showLyrics={widget?.showLyrics ?? false} size={widget?.size ?? 'wide'} onToggleLyrics={() => {
      if (!widget) return
      patchSettings({ widgets: settings.widgets.map((item) => item.id === widget.id ? { ...item, showLyrics: !(item.showLyrics ?? false) } : item) })
    }} />,
  },
  weather: {
    kind: 'weather',
    label: 'Weather',
    hint: 'Local conditions at a glance',
    wide: false,
    icon: () => <CloudSun class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <WeatherView />,
  },
  calendar: {
    kind: 'calendar',
    label: 'Calendar',
    hint: 'Your next few events',
    wide: false,
    icon: () => <CalendarDays class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <CalendarView />,
  },
  notes: {
    kind: 'notes',
    label: 'Notes',
    hint: 'A quick scratchpad',
    wide: false,
    icon: () => <NotebookPen class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <NotesView />,
  },
  usage: {
    kind: 'usage',
    label: 'Usage',
    hint: 'AI provider limits and activity',
    wide: false,
    icon: () => <Gauge class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <UsageView compact />,
  },
  notifications: {
    kind: 'notifications',
    label: 'Notifications',
    hint: 'Recent Windows alerts',
    wide: false,
    icon: () => <Bell class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <NotificationsView compact />,
  },
  dock: {
    kind: 'dock',
    label: 'Apps',
    hint: 'Connected apps and shortcuts',
    wide: true,
    icon: () => <LayoutGrid class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <DockView compact />,
  },
  nearby: {
    kind: 'nearby',
    label: 'File bucket',
    hint: 'Scan a QR to share with your phone',
    wide: true,
    icon: () => <Radio class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <NearbyView compact />,
  },
  ai: {
    kind: 'ai',
    label: 'AI activity',
    hint: 'Customisable provider monitor',
    wide: false,
    icon: () => <Sparkles class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />,
    render: () => <AiView />,
  },
}

/** Canonical presentation order for pickers. */
export const WIDGET_KINDS: WidgetKind[] = [
  'web-alerts',
  'media',
  'weather',
  'calendar',
  'notes',
  'usage',
  'notifications',
  'dock',
  'ai',
  'focus',
  'system',
  'controls',
  'reset-watch',
  'clock',
  'bluetooth',
  'nearby',
]

export function widgetDef(kind: WidgetKind): WidgetDef {
  return WIDGETS[kind]
}
