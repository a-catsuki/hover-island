import { createSignal } from 'solid-js'
import { cmd, onEmailCodesChanged, onEmailCodesError, type EmailCodeAccount, type EmailCodesSnapshot } from '../lib/ipc'

const [snapshot, setSnapshot] = createSignal<EmailCodesSnapshot>({ accounts: [], lastError: null })
const [error, setError] = createSignal<string | null>(null)
let loading: Promise<void> | undefined

export const emailCodes = snapshot
export const emailCodesError = error

export function refreshEmailCodes(): Promise<void> {
  if (loading) return loading
  const request = cmd.emailCodesAccounts().then(value => { setSnapshot(value); setError(null) }).catch((reason) => {
    setError('Could not load email connections.')
    throw reason
  }).finally(() => { loading = undefined })
  loading = request
  return request
}

export function subscribeEmailCodes(): () => void {
  let disposed = false
  let unlistenError: (() => void) | undefined
  let unlistenChanged: (() => void) | undefined
  void onEmailCodesError(message => { if (!disposed) setError(message || 'Email code checking is temporarily unavailable.') })
    .then(unlisten => { if (disposed) unlisten(); else unlistenError = unlisten })
    .catch(() => setError('Could not connect to email code updates.'))
  void onEmailCodesChanged(() => { if (!disposed) void refreshEmailCodes().catch(() => {}) })
    .then(unlisten => { if (disposed) unlisten(); else unlistenChanged = unlisten })
    .catch(() => {})
  void refreshEmailCodes().catch(() => {})
  return () => { disposed = true; unlistenError?.(); unlistenChanged?.() }
}

export async function connectEmailCodes(provider: 'google' | 'microsoft', clientId: string, clientSecret?: string): Promise<EmailCodeAccount> {
  setError(null)
  const account = await cmd.emailCodesAuthorize(provider, clientId, clientSecret)
  await refreshEmailCodes()
  return account
}

export async function pauseEmailCodes(id: string, paused: boolean): Promise<void> {
  setError(null)
  setSnapshot(await cmd.emailCodesSetPaused(id, paused))
}

export async function removeEmailCodes(id: string): Promise<void> {
  setError(null)
  await cmd.emailCodesRemove(id)
  await refreshEmailCodes()
}
