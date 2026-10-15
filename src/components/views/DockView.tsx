import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Globe, LayoutGrid, Plus } from 'lucide-solid'
import { cmd, type AppConnection, type DockItem } from '../../lib/ipc'
import { settings } from '../../state/settings'
import './DockView.css'
import BrandIcon from '../BrandIcon'
import { reportError } from '../../state/feedback'

function launchDock(item: DockItem) {
  void (item.kind === 'url' ? cmd.appsOpenUrl(item.target) : cmd.appsLaunch(item.target)).catch(error=>reportError('Could not open app',error))
}

export default function DockView(props: { compact?: boolean }) {
  const connections = createMemo(() => settings.connections)
  const pinned = createMemo(() => settings.dock)
  const [page, setPage] = createSignal(0)
  const [pageSize, setPageSize] = createSignal(6)
  let miniGrid: HTMLDivElement | undefined
  const combined = createMemo(() => [
    ...connections().map(item => ({ type: 'connection' as const, item })),
    ...pinned().map(item => ({ type: 'pinned' as const, item })),
  ])
  const pages = () => Math.max(1, Math.ceil(combined().length / pageSize()))
  const currentPage = () => Math.min(page(), pages() - 1)
  const shown = () => combined().slice(currentPage() * pageSize(), (currentPage() + 1) * pageSize())
  onMount(() => {
    const observer = new ResizeObserver(entries => setPageSize(Math.max(1, Math.min(10, Math.floor((entries[0].contentRect.width + 12) / 72)))))
    if (miniGrid) observer.observe(miniGrid)
    onCleanup(() => observer.disconnect())
  })

  const openSettings = () => void cmd.openSettingsWindow().catch(error=>reportError('Could not open settings',error))
  const openConnection = async (connection:AppConnection) => {
    try {
      const installed=await cmd.appsList()
      const names=[connection.name,...connection.notificationSources??[]].map(name=>name.toLowerCase())
      const native=installed.find(app=>names.includes(app.name.toLowerCase()))
      if(native)await cmd.appsLaunch(native.target)
      else await cmd.appsOpenWebApp(connection.url)
    }catch(error){reportError(`Could not open ${connection.name}`,error)}
  }

  const Tile = (tile: { name: string; icon?: string | null; letter: string; url?: string; onClick: () => void }) => (
    <button class="dock__tile" onClick={tile.onClick} title={tile.url ?? tile.name}>
      <span class="dock__art">
        <Show when={tile.icon} fallback={<BrandIcon name={tile.name} size={24}/>}>
          {(src) => <img class="dock__img" src={src()!} alt="" draggable={false} />}
        </Show>
      </span>
      <span class="dock__name">{tile.name}</span>
    </button>
  )

  const Connections = (props2: { list: AppConnection[] }) => (
    <For each={props2.list}>
      {(connection) => (
        <Tile
          name={connection.name}
          icon={connection.icon}
          letter={connection.name.slice(0, 1).toUpperCase()}
          url={connection.url}
          onClick={() => void openConnection(connection)}
        />
      )}
    </For>
  )

  const Pinned = (props2: { list: DockItem[] }) => (
    <For each={props2.list}>
      {(item) => (
        <Tile
          name={item.name}
          icon={item.icon}
          letter={item.name.slice(0, 1).toUpperCase()}
          onClick={() => launchDock(item)}
        />
      )}
    </For>
  )

  const empty = () => connections().length === 0 && pinned().length === 0

  if (props.compact) {
    return (
      <>
        <header class="widget__head">
          <span class="widget__title">
            <LayoutGrid class="icon icon--sm" strokeWidth={1.7} aria-hidden="true" />
            Apps
          </span>
          <button
            type="button"
            class="text-button dock__mini-manage"
            aria-label="Manage connections"
            title="Manage connections"
            onClick={openSettings}
          >
            <Plus class="icon icon--sm" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <Show
          when={!empty()}
          fallback={
            <button class="widget__empty dock__connect" onClick={openSettings}>
              <Globe class="icon" strokeWidth={1.5} aria-hidden="true" />
              <span>Connect WhatsApp, Gmail and more in Settings.</span>
            </button>
          }
        >
          <div ref={miniGrid} class="dock__grid dock__grid--mini">
            <For each={shown()}>{entry => <Tile name={entry.item.name} icon={entry.item.icon} letter={entry.item.name.slice(0, 1)} onClick={() => entry.type === 'connection' ? void openConnection(entry.item) : launchDock(entry.item)} />}</For>
          </div>
          <Show when={pages() > 1}><nav class="widget-list-pager" aria-label="Apps"><button aria-label="Previous apps" disabled={currentPage() === 0} onClick={() => setPage(currentPage() - 1)}>‹</button><span>{currentPage() + 1} / {pages()}</span><button aria-label="Next apps" disabled={currentPage() >= pages() - 1} onClick={() => setPage(currentPage() + 1)}>›</button></nav></Show>
        </Show>
      </>
    )
  }

  return (
    <div class="dock">
      <div class="view-heading">
        <div>
          <h2>Your essentials</h2>
          <p>Connected apps and shortcuts, one click away.</p>
        </div>
        <button class="button" onClick={openSettings}>
          <Plus size={14} />
          Manage connections
        </button>
      </div>
      <Show
        when={!empty()}
        fallback={
          <div class="dock__empty">
            <Globe size={30} strokeWidth={1.3} />
            <h3>Make room for your favorites.</h3>
            <p>Connect web apps like WhatsApp, Gmail or Slack, then pin the ones you use most.</p>
            <button class="button" onClick={openSettings}>
              <Plus size={14} />
              Open connections
            </button>
          </div>
        }
      >
        <div class="dock__grid">
          <Connections list={connections()} />
          <Pinned list={pinned()} />
        </div>
      </Show>
    </div>
  )
}
