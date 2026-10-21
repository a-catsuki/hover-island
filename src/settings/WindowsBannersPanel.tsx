import { Group, Segmented } from './controls'
import { patchSettings, settings } from '../state/settings'
import type { Settings } from '../lib/ipc'
import './NotificationsSettings.css'

const OPTIONS = [['normal', 'Show'], ['quiet', 'Hide'], ['clear', 'Hide and clear']] as const

const HINTS: Record<Settings['windowsBanners'], string> = {
  normal: 'Windows shows its own banners and keeps its notification list, as usual.',
  quiet: 'Windows banners stay hidden while Hover Island runs, and your old setting comes back when you quit. Notifications still land in the island.',
  clear: 'Same as Hide, and each notification the island shows is also removed from the Windows notification list so it does not pile up there.'
}

/** Whether Windows' own toast banners appear next to the island's. */
export default function WindowsBannersPanel() {
  const mode = () => settings.windowsBanners ?? 'normal'
  return (
    <Group title="Windows banners" description="Stop Windows from showing the same alerts the island already shows.">
      <Segmented label="Windows banners" hint={HINTS[mode()]} ariaLabel="Windows banners" value={mode()} options={OPTIONS} onChange={value => patchSettings({ windowsBanners: value })} />
      <p class="appn__status">Hide uses the same switch as Windows Do Not Disturb. The island's own Do Not Disturb is not changed. Apps you mute in Connections are left alone by Hide and clear. If Windows itself never sends the island a notification, turn this back to Show.</p>
    </Group>
  )
}
