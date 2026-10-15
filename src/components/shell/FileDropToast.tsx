import { Check, CircleAlert, FolderUp, Trash2 } from 'lucide-solid'
import { Show } from 'solid-js'

export type FileDropTarget = 'recycle' | 'beam' | null

interface Props {
  count: number
  target: FileDropTarget
  edge: 'top' | 'bottom' | 'left' | 'right'
  mode: 'notch' | 'bar' | 'sidebar'
  message?: string
  phase?: 'pending' | 'complete' | 'error' | 'cancelled'
  progress?: number | null
}

export default function FileDropToast(props: Props) {
  const countLabel = () => `${props.count} ${props.count === 1 ? 'item' : 'items'}`
  const progressValue = () => {
    if (props.phase === 'complete') return 1
    const value = props.progress
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined
  }

  return (
    <div class="file-drop-toast" classList={{
      'file-drop-toast--top': props.edge === 'top',
      'file-drop-toast--bottom': props.edge === 'bottom',
      'file-drop-toast--left': props.edge === 'left',
      'file-drop-toast--right': props.edge === 'right',
      'file-drop-toast--sidebar': props.mode === 'sidebar',
      'file-drop-toast--action': !!props.phase,
    }} role="status" aria-live="polite" aria-label={props.phase ? props.message : `${countLabel()}. Drop left to recycle or right to add to Beam.`}>
      <Show when={props.phase} fallback={<>
      <div class="file-drop-toast__target" data-drop-target="recycle" classList={{ 'file-drop-toast__target--active': props.target === 'recycle' }}>
        <span class="file-drop-toast__icon"><Trash2 size={17} strokeWidth={1.8}/></span>
        <span class="file-drop-toast__label">Recycle Bin</span>
      </div>
      <div class="file-drop-toast__center">
        <span class="file-drop-toast__count">{countLabel()}</span>
        <span class="file-drop-toast__hint">{props.message ?? (props.target === 'recycle' ? 'Release to recycle' : props.target === 'beam' ? 'Release to share' : 'Choose a destination')}</span>
      </div>
      <div class="file-drop-toast__target" data-drop-target="beam" classList={{ 'file-drop-toast__target--active': props.target === 'beam' }}>
        <span class="file-drop-toast__icon file-drop-toast__icon--beam"><FolderUp size={17} strokeWidth={1.8}/></span>
        <span class="file-drop-toast__label">Beam bucket</span>
      </div>
      </>}>
        <span class="file-drop-action__icon" classList={{'is-working':props.phase==='pending','is-error':props.phase==='error'}}>
          {props.phase==='complete' ? <Check size={25}/> : props.phase==='error' ? <CircleAlert size={25}/> : props.target==='recycle' ? <Trash2 size={25}/> : <FolderUp size={25}/>}
        </span>
        <div class="file-drop-action__content">
          <strong>{props.message}</strong><span>{countLabel()}{props.phase==='pending' ? ' · Working…' : props.phase==='complete' ? ' · Done' : ''}</span>
          <Show when={progressValue() !== undefined} fallback={
            <progress aria-label={props.target==='recycle' ? 'Recycle progress' : 'Beam staging progress'} max={1}/>
          }>
            <progress aria-label={props.target==='recycle' ? 'Recycle progress' : 'Beam staging progress'} max={1} value={progressValue()}/>
          </Show>
        </div>
      </Show>
    </div>
  )
}
