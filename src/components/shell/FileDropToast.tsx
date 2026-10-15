import { FolderUp, Trash2 } from 'lucide-solid'

export type FileDropTarget = 'recycle' | 'beam' | null

interface Props {
  count: number
  target: FileDropTarget
  edge: 'top' | 'bottom' | 'left' | 'right'
  mode: 'notch' | 'bar' | 'sidebar'
  message?: string
}

export default function FileDropToast(props: Props) {
  const countLabel = () => `${props.count} ${props.count === 1 ? 'item' : 'items'}`

  return (
    <div class="file-drop-toast" classList={{
      'file-drop-toast--top': props.edge === 'top',
      'file-drop-toast--bottom': props.edge === 'bottom',
      'file-drop-toast--left': props.edge === 'left',
      'file-drop-toast--right': props.edge === 'right',
      'file-drop-toast--sidebar': props.mode === 'sidebar',
    }} role="status" aria-live="polite" aria-label={`${countLabel()}. Drop left to recycle or right to add to Beam.`}>
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
    </div>
  )
}
