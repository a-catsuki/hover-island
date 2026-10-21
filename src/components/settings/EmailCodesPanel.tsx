import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Check, ExternalLink, KeyRound, Mail, Pause, Play, RefreshCw, ShieldCheck, Trash2 } from 'lucide-solid'
import { connectEmailCodes, emailCodes, emailCodesError, pauseEmailCodes, refreshEmailCodes, removeEmailCodes, subscribeEmailCodes } from '../../state/emailCodes'
import { reportError } from '../../state/feedback'
import { Group, SettingsDropdown } from '../../settings/controls'
import './panels.css'

export default function EmailCodesPanel() {
  const [provider, setProvider] = createSignal<'google' | 'microsoft'>('google')
  const [clientId, setClientId] = createSignal('')
  const [clientSecret, setClientSecret] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [workingId, setWorkingId] = createSignal<string | null>(null)
  const [localError, setLocalError] = createSignal<string | null>(null)

  onMount(() => { const unsubscribe = subscribeEmailCodes(); onCleanup(unsubscribe) })

  const connect = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true); setLocalError(null)
    try {
      await connectEmailCodes(provider(), clientId().trim(), provider() === 'google' ? clientSecret() : undefined)
      setClientId(''); setClientSecret('')
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not connect this account.')
    } finally { setBusy(false) }
  }
  const togglePause = async (id: string, paused: boolean) => {
    setWorkingId(id); setLocalError(null)
    try { await pauseEmailCodes(id, !paused) }
    catch (error) { setLocalError(error instanceof Error ? error.message : 'Could not update this connection.') }
    finally { setWorkingId(null) }
  }
  const remove = async (id: string) => {
    setWorkingId(id); setLocalError(null)
    try { await removeEmailCodes(id) }
    catch (error) { setLocalError(error instanceof Error ? error.message : 'Could not remove this connection.') }
    finally { setWorkingId(null) }
  }

  return <Group
    title="Email verification codes"
    description="Optional and off until you connect an account. Hover Island reads only new inbox mail, keeps codes in memory for ten minutes, and stores sign-in credentials encrypted with Windows on this PC."
  >
    <Show when={emailCodes().accounts.length} fallback={<p class="slist-empty">No email accounts connected.</p>}>
      <For each={emailCodes().accounts}>{account => <div class="slist-row">
        <span class="slist-row__tile" style={{ background: account.provider === 'google' ? '#ea4335' : '#0a84ff' }} aria-hidden="true"><Mail size={15} strokeWidth={1.9} /></span>
        <span class="slist-row__text">
          <strong>{account.address}</strong>
          <small classList={{ 'is-error': !!account.lastError }}>{account.provider === 'google' ? 'Gmail' : 'Outlook'} · {account.paused ? 'Paused' : account.lastError || 'Watching for new codes'}</small>
        </span>
        <span class="slist-row__actions">
          <button type="button" class="slist-icon-btn" disabled={workingId() === account.id} aria-label={account.paused ? `Resume ${account.address}` : `Pause ${account.address}`} title={account.paused ? 'Resume' : 'Pause'} onClick={() => void togglePause(account.id, account.paused)}>{account.paused ? <Play size={14} /> : <Pause size={14} />}</button>
          <button type="button" class="slist-icon-btn slist-icon-btn--danger" disabled={workingId() === account.id} aria-label={`Remove ${account.address}`} title="Remove" onClick={() => void remove(account.id)}><Trash2 size={14} /></button>
        </span>
      </div>}</For>
    </Show>

    <form class="sform" onSubmit={connect}>
      <h3 class="sform__title"><KeyRound size={14} strokeWidth={1.9} />Connect an account</h3>
      <div class="sform__grid">
        <div class="sform__field sform__field--wide"><span>Email provider</span><SettingsDropdown block ariaLabel="Email provider" value={provider()} onChange={setProvider} disabled={busy()} options={[['google', 'Google / Gmail'], ['microsoft', 'Microsoft / Outlook']]} /></div>
        <label class="sform__field" classList={{ 'sform__field--wide': provider() !== 'google' }}><span>{provider() === 'google' ? 'Desktop OAuth client ID' : 'Public client application ID'}</span><input value={clientId()} onInput={event => setClientId(event.currentTarget.value)} autocomplete="off" spellcheck={false} required maxlength={300} placeholder={provider() === 'google' ? '123…apps.googleusercontent.com' : 'Application (client) ID'} disabled={busy()} /></label>
        <Show when={provider() === 'google'}><label class="sform__field"><span>Client secret<small>optional</small></span><input type="password" value={clientSecret()} onInput={event => setClientSecret(event.currentTarget.value)} autocomplete="new-password" maxlength={2048} placeholder="Only if your client needs one" disabled={busy()} /></label></Show>
      </div>

      <div class="sform__setup">
        <Show when={provider() === 'google'} fallback={<><strong>Microsoft setup</strong><span>Register a public desktop app in Microsoft Entra. Turn on public client flows and add the delegated permissions <code>Mail.Read</code>, <code>User.Read</code> and <code>offline_access</code>.</span><a class="sform__link" href="https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration" target="_blank" rel="noreferrer">Desktop app setup <ExternalLink size={12} /></a></>}>
          <strong>Google setup</strong><span>Enable the Gmail API and create an OAuth client of type Desktop app. If the app is in testing, add your account as a test user. Gmail read access may need Google verification for wider use.</span><a class="sform__link" href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">Desktop OAuth setup <ExternalLink size={12} /></a>
        </Show>
      </div>
      <Show when={localError() || emailCodesError()}><p class="sform__error" role="alert">{localError() || emailCodesError()}</p></Show>
      <div class="sform__actions">
        <button class="button button--primary" type="submit" disabled={busy() || !clientId().trim()}>{busy() ? <><span class="sform__spinner" />Waiting for sign-in…</> : <><Check size={13} />Connect with {provider() === 'google' ? 'Google' : 'Microsoft'}</>}</button>
        <button type="button" class="text-button" aria-label="Refresh email connections" onClick={() => void refreshEmailCodes().catch(error => reportError('Could not refresh email connections', error))}><RefreshCw size={12} /> Refresh</button>
      </div>
      <p class="sform__note"><ShieldCheck size={11} style={{ 'vertical-align': '-1px', 'margin-right': '4px' }} />Sign-in opens in your browser. Secrets are encrypted here and never shown again. You can pause or remove a connection any time, and revoke access from your Google or Microsoft account page.</p>
    </form>
  </Group>
}
