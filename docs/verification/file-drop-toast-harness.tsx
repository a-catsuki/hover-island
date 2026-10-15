import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import FileDropToast, { type FileDropTarget } from '../../src/components/shell/FileDropToast'

export interface ToastState {
  count: number
  target: FileDropTarget
  edge: 'top' | 'bottom' | 'left' | 'right'
  mode: 'notch' | 'bar' | 'sidebar'
  message?: string
  phase?: 'pending' | 'complete' | 'error' | 'cancelled'
  progress?: number | null
}

export function mountFileDropToast(root: HTMLElement) {
  const [state, setState] = createSignal<ToastState>({
    count: 2,
    target: 'beam',
    edge: 'top',
    mode: 'notch',
  })
  const dispose = render(() => <FileDropToast {...state()} />, root)
  return { setState, dispose }
}
