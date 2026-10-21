import { Show } from 'solid-js'
import { Check, X } from 'lucide-solid'
import type { AiActivityEvent } from '../../lib/ipc'
import { formatDuration, providerMeta } from '../../lib/usageDisplay'
import { aiToastLeaving } from '../../state/peek'
import AiActivityMark from './AiActivityMark'
import './AiActivityToast.css'

const RING = 2 * Math.PI * 21

const CHIP: Record<AiActivityEvent['kind'], string> = {
  started: 'Working',
  progress: 'Working',
  question: 'Needs you',
  completed: 'Done',
  failed: 'Failed',
}

/** Live agent activity inside the notch: start, progress, a question, a result. */
export default function AiActivityToast(props: { event: AiActivityEvent }) {
  const kind = () => props.event.kind
  const percent = () => props.event.percent == null ? null : Math.round(Math.max(0, Math.min(100, props.event.percent)))
  const label = () => providerMeta(props.event.provider).label
  const chip = () => kind() === 'completed' && props.event.durationMs != null ? `Done in ${formatDuration(props.event.durationMs)}` : CHIP[kind()]
  const title = () => props.event.title || label()
  const detail = () => props.event.detail
  const busy = () => kind() === 'started' || kind() === 'progress'
  return <div class="aat" classList={{ [`aat--${kind()}`]: true, 'aat--out': aiToastLeaving() }} data-kind={kind()}
    aria-label={`${label()}: ${chip()}. ${title()}`}>
    <div class="aat__badge">
      <svg class="aat__ring" viewBox="0 0 48 48" aria-hidden="true">
        <circle class="aat__ring-track" cx="24" cy="24" r="21" />
        <Show when={busy() && percent() != null}>
          <circle class="aat__ring-fill" cx="24" cy="24" r="21" stroke-dasharray={`${RING}`} stroke-dashoffset={`${RING * (1 - (percent() ?? 0) / 100)}`} />
        </Show>
        <Show when={busy() && percent() == null}><circle class="aat__ring-spin" cx="24" cy="24" r="21" stroke-dasharray={`${RING * 0.22} ${RING}`} /></Show>
        <Show when={kind() === 'completed'}><circle class="aat__ring-done" cx="24" cy="24" r="21" /></Show>
      </svg>
      <AiActivityMark provider={props.event.provider} size={30} />
      <Show when={kind() === 'question'}><span class="aat__q" aria-hidden="true">?</span></Show>
      <Show when={kind() === 'completed'}><span class="aat__check" aria-hidden="true"><Check size={12} strokeWidth={3} /></span></Show>
      <Show when={kind() === 'failed'}><span class="aat__fail" aria-hidden="true"><X size={12} strokeWidth={3} /></span></Show>
      <Show when={kind() === 'completed'}><span class="aat__burst" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /></span></Show>
    </div>
    <div class="aat__body">
      <div class="aat__meta">
        <span class="aat__app">{label()}</span>
        <span class="aat__chip">
          <Show when={busy() && percent() != null} fallback={chip()}>{percent()}%</Show>
        </span>
      </div>
      <div class="aat__title">{title()}</div>
      <Show when={detail()}><div class="aat__detail">{detail()}</div></Show>
    </div>
    <Show when={busy() && percent() != null}><div class="aat__bar" aria-hidden="true"><span style={{ width: `${percent()}%` }} /></div></Show>
  </div>
}
