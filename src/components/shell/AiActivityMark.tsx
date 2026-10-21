import { createSignal, Show } from 'solid-js'
import { providerMeta } from '../../lib/usageDisplay'
import './AiActivityToast.css'

/** Brand artwork shipped in /brands. Anything else gets a tinted monogram tile. */
const ARTWORK: Record<string, string> = { codex: 'openai', 'claude-code': 'claude', cursor: 'cursor' }

/** Provider mark for AI toasts and rows: the brand icon when there is one, a monogram otherwise. */
export default function AiActivityMark(props: { provider: string; size?: number; class?: string }) {
  const [failed, setFailed] = createSignal(false)
  const size = () => props.size ?? 28
  const meta = () => providerMeta(props.provider)
  const art = () => ARTWORK[props.provider]
  return <span class={`aat-mark ${props.class ?? ''}`} style={{ width: `${size()}px`, height: `${size()}px`, '--mark': meta().color, 'font-size': `${Math.round(size() * 0.46)}px` }} aria-hidden="true">
    <Show when={art() && !failed()} fallback={<b>{meta().letter}</b>}>
      <img src={`/brands/${art()}.svg`} alt="" width={Math.round(size() * 0.7)} height={Math.round(size() * 0.7)} draggable={false} onError={() => setFailed(true)} />
    </Show>
  </span>
}
