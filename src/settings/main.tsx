import '@fontsource-variable/inter'
import { render } from 'solid-js/web'
import SettingsApp from './SettingsApp'
import '../styles/tokens.css'
import '../styles/base.css'
import './settings.css'

render(() => <SettingsApp />, document.getElementById('root')!)
