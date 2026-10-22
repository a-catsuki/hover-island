import '@fontsource-variable/inter'
import { render } from 'solid-js/web'
import AmbientApp from './AmbientApp'
import EnrollApp from './EnrollApp'
import { cmd } from '../lib/ipc'
import { loadSettings } from '../state/settings'
import '../styles/tokens.css'
import '../styles/base.css'
import '../components/views/MediaView.css'
import './ambient.css'
import './face.css'

// The same window hosts face enrollment, opened from Settings.
void Promise.all([cmd.ambientMode().catch(() => 'ambient' as const), loadSettings()]).then(([mode]) => {
  render(() => mode === 'enroll' ? <EnrollApp /> : <AmbientApp initialActive={mode !== 'prewarm'} />, document.getElementById('root')!)
})
