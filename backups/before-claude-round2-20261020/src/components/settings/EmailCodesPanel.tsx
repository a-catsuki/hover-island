import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Check, ExternalLink, KeyRound, Pause, Play, Plus, ShieldCheck, Trash2 } from 'lucide-solid'
import { connectEmailCodes, emailCodes, emailCodesError, pauseEmailCodes, refreshEmailCodes, removeEmailCodes, subscribeEmailCodes } from '../../state/emailCodes'
import { reportError } from '../../state/feedback'
import './EmailCodesPanel.css'

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

  return <section class="email-codes" aria-labelledby="email-codes-title">
    <header class="email-codes__heading">
      <span class="email-codes__icon"><KeyRound size={18}/></span>
      <div><h3 id="email-codes-title">Email verification codes</h3><p>Watch selected inboxes for new sign-in codes.</p></div>
      <button class="email-codes__refresh" type="button" aria-label="Refresh email connections" onClick={() => void refreshEmailCodes().catch(error => reportError('Could not refresh email connections', error))}>Refresh</button>
    </header>

    <div class="email-codes__privacy"><ShieldCheck size={16}/><span>Optional and off until you connect an account. Hover Island checks only new inbox mail, keeps codes in memory for ten minutes, and stores provider credentials encrypted with Windows DPAPI on this device.</span></div>

    <div class="email-codes__accounts">
      <Show when={emailCodes().accounts.length} fallback={<div class="email-codes__empty">No email accounts connected</div>}>
        <For each={emailCodes().accounts}>{account => <article class="email-codes__account">
          <span class="email-codes__provider">{account.provider === 'google' ? 'Gmail' : 'Outlook'}</span>
          <div class="email-codes__address"><strong>{account.address}</strong><small classList={{'email-codes__account-error':!!account.lastError}}>{account.paused ? 'Paused' : account.lastError || 'Checking for new codes'}</small></div>
          <button type="button" class="email-codes__icon-button" disabled={workingId() === account.id} aria-label={account.paused ? `Resume ${account.address}` : `Pause ${account.address}`} onClick={() => void togglePause(account.id, account.paused)}>{account.paused ? <Play size={15}/> : <Pause size={15}/>}</button>
          <button type="button" class="email-codes__icon-button email-codes__icon-button--remove" disabled={workingId() === account.id} aria-label={`Remove ${account.address}`} onClick={() => void remove(account.id)}><Trash2 size={15}/></button>
        </article>}</For>
      </Show>
    </div>

    <form class="email-codes__form" onSubmit={connect}>
      <div class="email-codes__form-title"><Plus size={15}/> Connect an account</div>
      <label class="email-codes__field"><span>Email provider</span><select value={provider()} onChange={event => setProvider(event.currentTarget.value as 'google' | 'microsoft')} disabled={busy()}><option value="google">Google / Gmail</option><option value="microsoft">Microsoft / Outlook</option></select></label>
      <label class="email-codes__field"><span>{provider() === 'google' ? 'Desktop OAuth client ID' : 'Public client application ID'}</span><input value={clientId()} onInput={event => setClientId(event.currentTarget.value)} autocomplete="off" spellcheck={false} required maxlength={300} placeholder={provider() === 'google' ? '123…apps.googleusercontent.com' : 'Application (client) ID'} disabled={busy()}/></label>
      <Show when={provider() === 'google'}><label class="email-codes__field"><span>Client secret <small>optional</small></span><input type="password" value={clientSecret()} onInput={event => setClientSecret(event.currentTarget.value)} autocomplete="new-password" maxlength={2048} placeholder="Only if your Google client requires it" disabled={busy()}/></label></Show>

      <div class="email-codes__setup">
        <Show when={provider() === 'google'} fallback={<><strong>Microsoft setup</strong><span>Register a public desktop app in Microsoft Entra. Enable public-client flows and add delegated <code>Mail.Read</code>, <code>User.Read</code>, and <code>offline_access</code> permissions.</span><a href="https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration" target="_blank" rel="noreferrer">Desktop app setup <ExternalLink size={12}/></a></>}>
          <strong>Google setup</strong><span>Enable the Gmail API, create an OAuth client with application type Desktop app, and add your account as a test user if the app is in testing. Gmail read access may require Google verification before general use.</span><a href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">Desktop OAuth setup <ExternalLink size={12}/></a>
        </Show>
      </div>
      <Show when={localError() || emailCodesError()}><p class="email-codes__error" role="alert">{localError() || emailCodesError()}</p></Show>
      <button class="email-codes__connect" type="submit" disabled={busy() || !clientId().trim()}>{busy() ? <><span class="email-codes__spinner"/> Waiting for provider sign-in…</> : <><Check size={15}/> Connect with {provider() === 'google' ? 'Google' : 'Microsoft'}</>}</button>
      <p class="email-codes__footnote">Sign-in opens in your browser. Your client ID is saved with the connection; secrets are encrypted locally and never shown again. Pause or remove a connection at any time. Revoke Hover Island’s access from your Google or Microsoft account security page to end provider authorization.</p>
    </form>
  </section>
}
