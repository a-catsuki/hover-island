import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Bell, BellOff, Check, CheckCircle2, ExternalLink, KeyRound, Mail, Pause, Play, RefreshCw, ShieldCheck, Trash2 } from 'lucide-solid'
import { cancelEmailSignIn, connectEmailCodes, emailCodes, emailCodesError, pauseEmailCodes, refreshEmailCodes, removeEmailCodes, setEmailMailAlerts, subscribeEmailCodes } from '../../state/emailCodes'
import { reportError } from '../../state/feedback'
import { cmd, type EmailProviders } from '../../lib/ipc'
import BrandIcon from '../BrandIcon'
import { Group, SettingsDropdown } from '../../settings/controls'
import './panels.css'

type Provider = 'google' | 'microsoft'
const PROVIDER_NAME: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft' }

export default function EmailCodesPanel() {
  const [oneClick, setOneClick] = createSignal<EmailProviders>({ google: false, microsoft: false })
  const [provider, setProvider] = createSignal<Provider>('google')
  const [clientId, setClientId] = createSignal('')
  const [clientSecret, setClientSecret] = createSignal('')
  const [signingIn, setSigningIn] = createSignal<Provider | null>(null)
  const [workingId, setWorkingId] = createSignal<string | null>(null)
  const [localError, setLocalError] = createSignal<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = createSignal(false)
  const [justConnected, setJustConnected] = createSignal<string | null>(null)
  let connectedTimer: number | undefined
  onCleanup(() => window.clearTimeout(connectedTimer))
  const anyOneClick = () => oneClick().google || oneClick().microsoft

  onMount(() => {
    const unsubscribe = subscribeEmailCodes(); onCleanup(unsubscribe)
    void cmd.emailCodesProviders().then(setOneClick).catch(() => {})
  })
  onCleanup(() => { if (signingIn()) void cancelEmailSignIn().catch(() => {}) })

  const signIn = async (which: Provider, ownClientId?: string, ownSecret?: string) => {
    if (signingIn()) return
    setSigningIn(which); setLocalError(null)
    try {
      const account = await connectEmailCodes(which, ownClientId, ownSecret)
      setClientId(''); setClientSecret(''); setAdvancedOpen(false)
      setJustConnected(account.address)
      window.clearTimeout(connectedTimer)
      connectedTimer = window.setTimeout(() => setJustConnected(null), 5000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '')
      if (message !== 'Sign-in cancelled.') setLocalError(message || 'Could not connect this account.')
    } finally { setSigningIn(null) }
  }
  const connectOwn = (event: SubmitEvent) => {
    event.preventDefault()
    void signIn(provider(), clientId().trim(), provider() === 'google' ? clientSecret() : undefined)
  }
  const act = async (id: string, run: () => Promise<void>, fallback: string) => {
    setWorkingId(id); setLocalError(null)
    try { await run() }
    catch (error) { setLocalError(error instanceof Error ? error.message : fallback) }
    finally { setWorkingId(null) }
  }

  const SignInButton = (props: { which: Provider }) => <button
    type="button"
    class="email-signin"
    classList={{ 'email-signin--google': props.which === 'google' }}
    disabled={!!signingIn()}
    onClick={() => void signIn(props.which)}
  >
    <BrandIcon name={props.which === 'google' ? 'gmail' : 'outlook'} size={18} />
    <span>Continue with {PROVIDER_NAME[props.which]}</span>
  </button>

  return <Group
    title="Email"
    description="Sign in once. Verification codes and new mail show up in the island."
  >
    <Show when={emailCodes().accounts.length}>
      <For each={emailCodes().accounts}>{account => <div class="slist-row">
        <span class="slist-row__tile" style={{ background: account.provider === 'google' ? '#ea4335' : '#0a84ff' }} aria-hidden="true"><Mail size={15} strokeWidth={1.9} /></span>
        <span class="slist-row__text">
          <strong>{account.address}</strong>
          <small classList={{ 'is-error': !!account.lastError }}>{account.provider === 'google' ? 'Gmail' : 'Outlook'} · {account.paused ? 'Paused' : account.lastError || (account.mailAlerts ? 'Codes and new mail' : 'Codes only')}</small>
        </span>
        <span class="slist-row__actions">
          <button type="button" class="slist-icon-btn" disabled={workingId() === account.id || account.paused} aria-label={account.mailAlerts ? `Stop new mail alerts for ${account.address}` : `Alert on new mail for ${account.address}`} title={account.mailAlerts ? 'New mail alerts on' : 'New mail alerts off'} onClick={() => void act(account.id, () => setEmailMailAlerts(account.id, !account.mailAlerts), 'Could not update this connection.')}>{account.mailAlerts ? <Bell size={14} /> : <BellOff size={14} />}</button>
          <button type="button" class="slist-icon-btn" disabled={workingId() === account.id} aria-label={account.paused ? `Resume ${account.address}` : `Pause ${account.address}`} title={account.paused ? 'Resume' : 'Pause'} onClick={() => void act(account.id, () => pauseEmailCodes(account.id, !account.paused), 'Could not update this connection.')}>{account.paused ? <Play size={14} /> : <Pause size={14} />}</button>
          <button type="button" class="slist-icon-btn slist-icon-btn--danger" disabled={workingId() === account.id} aria-label={`Remove ${account.address}`} title="Remove" onClick={() => void act(account.id, () => removeEmailCodes(account.id), 'Could not remove this connection.')}><Trash2 size={14} /></button>
        </span>
      </div>}</For>
    </Show>

    <div class="sform">
      <Show when={justConnected()}>
        <p class="email-connected" role="status"><CheckCircle2 size={14} />Connected {justConnected()}</p>
      </Show>
      <Show when={signingIn()} fallback={
        <Show when={anyOneClick()} fallback={<p class="sform__note">Sign in with Google isn't enabled in this build. Add the app's OAuth client to <code>src-tauri/.env.oauth</code> and rebuild.</p>}>
          <div class="email-signin-hero" classList={{ 'email-signin-hero--compact': emailCodes().accounts.length > 0 }}>
            <Show when={!emailCodes().accounts.length}>
              <div class="email-signin-hero__icons" aria-hidden="true"><BrandIcon name="gmail" size={26} /><Show when={oneClick().microsoft}><BrandIcon name="outlook" size={26} /></Show></div>
              <strong>Connect your inbox</strong>
              <small>Pick your account in the browser and you're done.</small>
            </Show>
            <div class="email-signin-row">
              <Show when={oneClick().google}><SignInButton which="google" /></Show>
              <Show when={oneClick().microsoft}><SignInButton which="microsoft" /></Show>
            </div>
          </div>
        </Show>
      }>
        <div class="email-waiting" role="status">
          <span class="sform__spinner" />
          <span class="email-waiting__text"><strong>Finish in your browser</strong><small>Choose your {PROVIDER_NAME[signingIn()!]} account and allow access.</small></span>
          <button type="button" class="text-button" onClick={() => void cancelEmailSignIn()}>Cancel</button>
        </div>
      </Show>
      <Show when={localError() || emailCodesError()}><p class="sform__error" role="alert">{localError() || emailCodesError()}</p></Show>

      <details class="sform__details" open={advancedOpen()} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
        <summary>Use your own OAuth app</summary>
        <form onSubmit={connectOwn}>
          <h3 class="sform__title"><KeyRound size={14} strokeWidth={1.9} />Your own OAuth client</h3>
          <div class="sform__grid">
            <div class="sform__field sform__field--wide"><span>Email provider</span><SettingsDropdown block ariaLabel="Email provider" value={provider()} onChange={setProvider} disabled={!!signingIn()} options={[['google', 'Google / Gmail'], ['microsoft', 'Microsoft / Outlook']]} /></div>
            <label class="sform__field" classList={{ 'sform__field--wide': provider() !== 'google' }}><span>{provider() === 'google' ? 'Desktop OAuth client ID' : 'Public client application ID'}</span><input value={clientId()} onInput={event => setClientId(event.currentTarget.value)} autocomplete="off" spellcheck={false} required maxlength={300} placeholder={provider() === 'google' ? '123…apps.googleusercontent.com' : 'Application (client) ID'} disabled={!!signingIn()} /></label>
            <Show when={provider() === 'google'}><label class="sform__field"><span>Client secret<small>optional</small></span><input type="password" value={clientSecret()} onInput={event => setClientSecret(event.currentTarget.value)} autocomplete="new-password" maxlength={2048} placeholder="Only if your client needs one" disabled={!!signingIn()} /></label></Show>
          </div>
          <div class="sform__setup">
            <Show when={provider() === 'google'} fallback={<><strong>Microsoft setup</strong><span>Register a public desktop app in Microsoft Entra. Turn on public client flows and add the delegated permissions <code>Mail.Read</code>, <code>User.Read</code> and <code>offline_access</code>.</span><a class="sform__link" href="https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration" target="_blank" rel="noreferrer">Desktop app setup <ExternalLink size={12} /></a></>}>
              <strong>Google setup</strong><span>Enable the Gmail API and create an OAuth client of type Desktop app. If the app is in testing, add your account as a test user.</span><a class="sform__link" href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">Desktop OAuth setup <ExternalLink size={12} /></a>
            </Show>
          </div>
          <div class="sform__actions">
            <button class="button button--primary" type="submit" disabled={!!signingIn() || !clientId().trim()}>{signingIn() ? <><span class="sform__spinner" />Waiting for sign-in…</> : <><Check size={13} />Connect with {PROVIDER_NAME[provider()]}</>}</button>
            <button type="button" class="text-button" aria-label="Refresh email connections" onClick={() => void refreshEmailCodes().catch(error => reportError('Could not refresh email connections', error))}><RefreshCw size={12} /> Refresh</button>
          </div>
        </form>
      </details>
      <p class="sform__note"><ShieldCheck size={11} style={{ 'vertical-align': '-1px', 'margin-right': '4px' }} />Read-only. Stored encrypted on this PC. Remove it any time.</p>
    </div>
  </Group>
}
