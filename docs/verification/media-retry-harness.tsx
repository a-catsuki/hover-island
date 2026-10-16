import {render} from 'solid-js/web'
import MediaView from '../../src/components/views/MediaView'
import {subscribeMedia} from '../../src/state/media'
import {expandIsland} from '../../src/state/ui'

export async function mountMediaRetry(root: HTMLElement) {
  const style=document.createElement('style');style.textContent='.media {height:100%;min-height:0;}';root.append(style)
  const stop=await subscribeMedia()
  expandIsland(false)
  const dispose=render(()=><div style={{height:'420px',width:'600px',display:'flex','flex-direction':'column'}}><MediaView compact showLyrics size="full"/></div>,root)
  return ()=>{dispose();stop()}
}
