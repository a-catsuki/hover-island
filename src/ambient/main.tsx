import '@fontsource-variable/inter'
import { render } from 'solid-js/web'
import AmbientApp from './AmbientApp'
import EnrollApp from './EnrollApp'
import { cmd } from '../lib/ipc'
import '../styles/tokens.css'
import '../styles/base.css'
import '../components/views/MediaView.css'
import './ambient.css'
import './face.css'

// The same window hosts face enrollment, opened from Settings.
void cmd.ambientMode().catch(() => 'ambient' as const).then(mode => {
  render(() => mode === 'enroll' ? <EnrollApp /> : <AmbientApp />, document.getElementById('root')!)
})
