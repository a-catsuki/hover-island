import '@fontsource-variable/inter'
import { render } from 'solid-js/web'
import AmbientApp from './AmbientApp'
import '../styles/tokens.css'
import '../styles/base.css'
import '../components/views/MediaView.css'
import './ambient.css'

render(() => <AmbientApp />, document.getElementById('root')!)
