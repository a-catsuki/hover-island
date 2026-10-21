import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Bell, ChevronDown, Trash2, X } from 'lucide-solid'
import { cmd, type AppNotification } from '../../lib/ipc'
import { clearNotifications, dismissNotification, notifications, notificationError, openNotificationSource, requestNotificationAccess } from '../../state/notifications'
import { reportError } from '../../state/feedback'
import { relativeTime } from '../../lib/connectionSources'
import NotificationAppIcon from '../shell/NotificationAppIcon'
import './NotificationsView.css'

interface AppGroup { app: string; icon?: string | null; items: AppNotification[] }

export default function NotificationsView(props: { compact?: boolean }) {
  const [now, setNow] = createSignal(Date.now())
  const [requesting, setRequesting] = createSignal(false)
  const [page, setPage] = createSignal(0)
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    onCleanup(() => clearInterval(timer))
  })

  const items = () => notifications()
  const count = () => items().length
  const ordered = () => [...items()].sort((a, b) => b.timestamp - a.timestamp)
  const pages = () => Math.max(1, Math.ceil(count() / 2))
  const currentPage = () => Math.min(page(), pages() - 1)
  /** Newest first, grouped by app; groups ordered by their newest notification. */
  const groups = createMemo<AppGroup[]>(() => {
    const byApp = new Map<string, AppGroup>()
    for (const item of ordered()) {
      const group = byApp.get(item.app)
      if (group) { group.items.push(item); group.icon ??= item.icon }
      else byApp.set(item.app, { app: item.app, icon: item.icon, items: [item] })
    }
    return [...byApp.values()]
  })
  const toggle = (app: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(app)) next.delete(app); else next.add(app); return next })
  const open = (item: AppNotification) => { if (item.id.startsWith('notification:')) void openNotificationSource(item.app) }
  const settingsWindow = () => void cmd.openSettingsWindow().catch(error => reportError('Could not open settings', error))
  const allow = async () => {
    setRequesting(true)
    try { if (!await requestNotificationAccess()) settingsWindow() }
    catch (error) { reportError('Notification access failed', error) }
    finally { setRequesting(false) }
  }

  if (props.compact) {
    return (
      <>
        <header class="widget__head">
          <span class="widget__title">
            <Bell class="icon icon--sm" strokeWidth={1.75} aria-hidden="true" />
            Notifications
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
              <Show when={notificationError()} fallback={<span>No notifications</span>}>
                <span>{notificationError()}</span>
                <button class="text-button" onClick={settingsWindow}>Notification settings</button>
              </Show>
            </div>
          }
        >
          <div class="notif-mini">
            <For each={ordered().slice(currentPage() * 2, currentPage() * 2 + 2)}>
              {(item) => (
                <div class="notif-mini__row">
                  <NotificationAppIcon app={item.app} icon={item.icon} size={28} />
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
          <Show when={pages() > 1}><nav class="widget-list-pager" aria-label="Notifications"><button aria-label="Previous notifications" disabled={currentPage() === 0} onClick={() => setPage(currentPage() - 1)}>‹</button><span>{currentPage() + 1} / {pages()}</span><button aria-label="Next notifications" disabled={currentPage() >= pages() - 1} onClick={() => setPage(currentPage() + 1)}>›</button></nav></Show>
        </Show>
      </>
    )
  }

  return (
    <div class="notif">
      <div class="notif__head">
        <h2 class="notif__title-lg">Notifications</h2>
        <Show when={count() > 0}>
          <button type="button" class="notif__clear" onClick={clearNotifications} aria-label="Clear all notifications">Clear all</button>
        </Show>
      </div>

      <Show
        when={count() > 0}
        fallback={
          <div class="notif__empty">
            <Bell class="notif__empty-icon" strokeWidth={1.5} aria-hidden="true" />
            <span class="notif__empty-title">No notifications</span>
            <Show when={notificationError()}>
              <span class="notif__empty-hint" role="status">{notificationError()}</span>
              <button type="button" class="notif__clear notif__clear--solid" disabled={requesting()} onClick={() => void allow()}>{requesting() ? 'Waiting for Windows…' : 'Allow notifications'}</button>
            </Show>
          </div>
        }
      >
        <div class="notif__list">
          <For each={groups()}>
            {(group) => {
              const isOpen = () => group.items.length === 1 || expanded().has(group.app)
              const visible = () => isOpen() ? group.items : group.items.slice(0, 1)
              return (
                <section class="notif-group" classList={{ 'notif-group--stack': !isOpen() && group.items.length > 1 }} aria-label={group.app}>
                  <Show when={group.items.length > 1}>
                    <button type="button" class="notif-group__head" aria-expanded={isOpen()} onClick={() => toggle(group.app)}>
                      <span class="notif-group__name">{group.app}</span>
                      <span class="notif-group__count">{group.items.length}</span>
                      <ChevronDown class="notif-group__chev" classList={{ 'notif-group__chev--open': isOpen() }} size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </Show>
                  <div class="notif-group__cards">
                    <For each={visible()}>
                      {(item) => (
                        <article class="notif-card" onClick={() => { if (!isOpen()) toggle(group.app); else open(item) }}>
                          <NotificationAppIcon app={item.app} icon={item.icon} size={36} />
                          <div class="notif-card__content">
                            <div class="notif-card__row">
                              <span class="notif-card__app">{item.app}</span>
                              <span class="notif-card__time">{relativeTime(item.timestamp, now())}</span>
                            </div>
                            <div class="notif-card__title">{item.title}</div>
                            <Show when={item.body}><div class="notif-card__body">{item.body}</div></Show>
                          </div>
                          <button type="button" class="notif-card__dismiss" aria-label={`Dismiss ${item.title || item.app}`} title="Dismiss" onClick={(event) => { event.stopPropagation(); dismissNotification(item.id) }}><X size={13} strokeWidth={2.25} aria-hidden="true" /></button>
                        </article>
                      )}
                    </For>
                  </div>
                </section>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
