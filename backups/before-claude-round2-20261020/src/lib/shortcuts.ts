type ShortcutEvent = Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

/** Match persisted native shortcuts without keeping a second hard-coded binding. */
export function matchesShortcut(event: ShortcutEvent, shortcut: string): boolean {
  const tokens = shortcut.toLowerCase().split('+').map(token => token.trim()).filter(Boolean)
  let control = false, alt = false, shift = false, meta = false
  let key = ''
  for (const token of tokens) {
    if (['control', 'ctrl', 'commandorcontrol', 'cmdorctrl'].includes(token)) control = true
    else if (['alt', 'option'].includes(token)) alt = true
    else if (token === 'shift') shift = true
    else if (['super', 'meta', 'command', 'cmd', 'win'].includes(token)) meta = true
    else if (!key) key = token
    else return false
  }
  if (!key || event.ctrlKey !== control || event.altKey !== alt || event.shiftKey !== shift || event.metaKey !== meta) return false
  const normalize = (value: string) => value.toLowerCase().replace(/^key(?=[a-z]$)|^digit(?=\d$)/, '')
  const aliases: Record<string, string> = { esc: 'escape', return: 'enter', spacebar: 'space', ' ': 'space', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' }
  key = aliases[key] ?? key
  // Native global shortcuts use physical key codes. A translated event.key must
  // not also activate a different physical key on non-US keyboard layouts.
  if (event.code && event.code !== 'Unidentified') return normalize(event.code) === normalize(key)
  return normalize(aliases[event.key.toLowerCase()] ?? event.key) === normalize(key)
}
