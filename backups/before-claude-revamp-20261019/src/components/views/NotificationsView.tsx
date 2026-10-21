import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Bell, Trash2 } from 'lucide-solid'
import { cmd, type AppNotification } from '../../lib/ipc'
import { clearNotifications, notifications, notificationError, requestNotificationAccess } from '../../state/notifications'
import { reportError } from '../../state/feedback'
import './NotificationsView.css'

function hashHue(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  return hash % 360
}

function relativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 45) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function Dot(props: { app: string; icon?: string | null; class?: string }) {
  const hue = hashHue(props.app)
  return (
    <Show
      when={props.icon ?? null}
      fallback={
        <span
          class={props.class ?? 'notif__dot'}
          style={{
            background: `linear-gradient(140deg, hsl(${hue} 62% 58%), hsl(${(hue + 40) % 360} 62% 40%))`,
          }}
        />
      }
    >
      {(src) => (
        <img
          class={`${props.class ?? 'notif__dot'} notif__dot--img`}
          src={src()}
          alt=""
          draggable={false}
        />
      )}
    </Show>
  )
}

export default function NotificationsView(props: { compact?: boolean }) {
  const [now, setNow] = createSignal(Date.now())
  const [permissionStatus, setPermissionStatus] = createSignal('')
  const [requesting, setRequesting] = createSignal(false)
  const [page, setPage] = createSignal(0)

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  const items = () => notifications()
  const count = () => items().length
  const ordered = () => [...items()].sort((a, b) => b.timestamp - a.timestamp)
  const pages = () => Math.max(1, Math.ceil(count() / 2))
  const currentPage = () => Math.min(page(), pages() - 1)

  if (props.compact) {
    return (
      <>
        <header class="widget__head">
          <span class="widget__title">
            <Bell class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />
            Alerts
          </span>
          <Show
            when={count() > 0}
            fallback={<span class="widget__eyebrow">{notificationError() ? 'Access needed' : 'All clear'}</span>}
          >
            <button
              type="button"
              class="text-button notif__mini-clear"
              aria-label="Clear all notifications"
              title="Clear all"
              onClick={clearNotifications}
            >
              <Trash2 class="icon icon--sm" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </Show>
        </header>
        <Show
          when={count() > 0}
          fallback={
            <div class="widget__empty">
              <Bell class="icon" strokeWidth={1.5} aria-hidden="true" />
              <Show when={notificationError()} fallback={<span>Nothing needs your attention.</span>}>
                <span>{notificationError()}</span>
                <button class="text-button" onClick={() => void cmd.openSettingsWindow().catch(error => reportError('Could not open settings',error))}>Notification settings</button>
              </Show>
            </div>
          }
        >
          <div class="notif-mini">
            <For each={ordered().slice(currentPage() * 2, currentPage() * 2 + 2)}>
              {(item) => (
                <div class="notif-mini__row">
                  <Dot app={item.app} icon={item.icon} class="notif-mini__dot" />
                  <div class="notif-mini__meta">
                    <div class="notif-mini__top">
                      <span class="notif-mini__app">{item.app}</span>
                      <span class="notif-mini__time">{relativeTime(item.timestamp, now())}</span>
                    </div>
                    <span class="notif-mini__title" title={item.title}>
                      {item.title}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
          <Show when={pages() > 1}><nav class="widget-list-pager" aria-label="Alerts"><button aria-label="Previous alerts" disabled={currentPage() === 0} onClick={() => setPage(currentPage() - 1)}>‹</button><span>{currentPage() + 1} / {pages()}</span><button aria-label="Next alerts" disabled={currentPage() >= pages() - 1} onClick={() => setPage(currentPage() + 1)}>›</button></nav></Show>
        </Show>
      </>
    )
  }

  return (
    <div class="notif">
      <div class="notif__head">
        <div class="notif__head-left">
          <span class="notif__count">{count()}</span>
          <span class="notif__head-label">{count() === 1 ? 'notification' : 'notifications'}</span>
        </div>
        <button type="button" class="notif__clear" onClick={clearNotifications} disabled={count() === 0}>
          <Trash2 class="icon icon--sm" strokeWidth={1.75} aria-hidden="true" />
          <span>Clear all</span>
        </button>
      </div>

      <Show
        when={count() > 0}
        fallback={
          <div class="notif__empty">
            <span class="notif__empty-glyph">
              <Bell class="icon" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span class="notif__empty-title">A little peace and quiet.</span>
            <span class="notif__empty-hint">Connect Windows notifications to keep your alerts here.</span>
            <button
              class="button"
              disabled={requesting()}
              onClick={async () => {
                setRequesting(true)
                try {
                  const allowed = await requestNotificationAccess()
                  setPermissionStatus(
                    allowed
                      ? 'Access granted. New Windows notifications will appear here.'
                      : 'Windows denied notification access. Allow Hover Island in Windows Settings → Privacy & security → Notification access, then retry.',
                  )
                } catch (error) {
                  setPermissionStatus(String(error))
                  reportError('Notification access failed', error)
                } finally {
                  setRequesting(false)
                }
              }}
            >
              {requesting() ? 'Requesting access…' : 'Enable notification access'}
            </button>
            <Show when={permissionStatus()}>
              <p class="muted" role="status">
                {permissionStatus()}
              </p>
            </Show>
          </div>
        }
      >
        <div class="notif__list">
          <For each={ordered()}>
            {(item) => (
              <article class="notif__item">
                <Dot app={item.app} icon={item.icon} />
                <div class="notif__content">
                  <div class="notif__row">
                    <span class="notif__app">{item.app}</span>
                    <span class="notif__time">{relativeTime(item.timestamp, now())}</span>
                  </div>
                  <div class="notif__title">{item.title}</div>
                  <Show when={item.body}>
                    <div class="notif__body">{item.body}</div>
                  </Show>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
