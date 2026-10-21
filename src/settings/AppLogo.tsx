import { createSignal, onCleanup, onMount } from 'solid-js'
import NotificationAppIcon from '../components/shell/NotificationAppIcon'
import { findInstalled, loadAppIcon, loadInstalledApps } from '../lib/appIcons'

/**
 * App logo for settings lists. Fetches the real logo only once the tile scrolls
 * into view; until then (and for apps without one) NotificationAppIcon draws a
 * brand glyph or a coloured letter tile, so a row is never blank.
 */
export default function AppLogo(props: { app: string; id?: string; icon?: string | null; size?: number; /** Other names the app goes by, tried before a fuzzy match on the main name. */ aliases?: readonly string[] }) {
  const [icon, setIcon] = createSignal<string | null>(null)
  let host: HTMLSpanElement | undefined
  let started = false

  const resolve = async () => {
    if (started) return
    started = true
    try {
      let target = props.id ? { id: props.id, icon: props.icon } : undefined
      if (!target) {
        await loadInstalledApps().catch(() => [])
        const found = findInstalled([props.app, ...(props.aliases ?? [])])
        if (found) target = { id: found.id, icon: found.icon }
      }
      if (target) setIcon(await loadAppIcon(target, Math.max(32, (props.size ?? 32) * 2)))
    } catch { /* The letter tile stays. */ }
  }

  onMount(() => {
    if (props.icon) { setIcon(props.icon); return }
    if (typeof IntersectionObserver === 'undefined' || !host) { void resolve(); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void resolve() }
    }, { rootMargin: '120px' })
    observer.observe(host)
    onCleanup(() => observer.disconnect())
  })

  return <span ref={host} class="app-logo" style={{ display: 'inline-flex', flex: 'none' }}>
    <NotificationAppIcon app={props.app} icon={icon() ?? props.icon} size={props.size ?? 30} />
  </span>
}
