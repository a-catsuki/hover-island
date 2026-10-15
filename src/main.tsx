import '@fontsource-variable/inter'
import { render } from 'solid-js/web'
import App from './App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/dashboard.css'
import './styles/polish.css'

render(() => <App />, document.getElementById('root')!)
