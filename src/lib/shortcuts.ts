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

/* ------------------------------------------------------------------ editing
 * Helpers for the Shortcuts settings page: turn key events into the strings the
 * native side registers ("Control+Alt+K"), validate them, and show them with
 * friendly Windows names. The saved format is always the canonical form below.
 */

export interface ParsedShortcut { control: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape', return: 'Enter', spacebar: 'Space', ' ': 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown', pageup: 'PageUp', pagedown: 'PageDown', plus: 'Equal', minus: 'Minus',
  '`': 'Backquote', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash',
}
const KNOWN_KEYS = new Set([
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'PrintScreen', 'Pause',
])

/** Canonical key name for a token typed by hand or saved by an older version: "k" -> "K", "keyk" -> "K", "esc" -> "Escape". */
function canonicalKey(token: string): string {
  const raw = token.trim()
  const lower = raw.toLowerCase()
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  const stripped = lower.replace(/^key(?=[a-z]$)|^digit(?=\d$)/, '')
  if (/^[a-z0-9]$/.test(stripped)) return stripped.toUpperCase()
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return lower.toUpperCase()
  if (/^numpad\w+$/.test(lower)) return `Numpad${lower.charAt(6).toUpperCase()}${lower.slice(7)}`
  const known = [...KNOWN_KEYS].find(name => name.toLowerCase() === lower)
  return known ?? raw
}

export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const parsed: ParsedShortcut = { control: false, alt: false, shift: false, meta: false, key: '' }
  for (const token of shortcut.split('+').map(part => part.trim()).filter(Boolean)) {
    const lower = token.toLowerCase()
    if (['control', 'ctrl', 'commandorcontrol', 'cmdorctrl'].includes(lower)) parsed.control = true
    else if (['alt', 'option'].includes(lower)) parsed.alt = true
    else if (lower === 'shift') parsed.shift = true
    else if (['super', 'meta', 'command', 'cmd', 'win', 'windows'].includes(lower)) parsed.meta = true
    else if (!parsed.key) parsed.key = canonicalKey(token)
    else return null
  }
  return parsed.key || parsed.control || parsed.alt || parsed.shift || parsed.meta ? parsed : null
}

/** "ctrl+alt+k" and "Alt+Control+K" both become "Control+Alt+K"; "" when there is nothing to save. */
export function normalizeShortcut(shortcut: string): string {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return ''
  return [parsed.control && 'Control', parsed.alt && 'Alt', parsed.shift && 'Shift', parsed.meta && 'Super', parsed.key].filter(Boolean).join('+')
}

export function sameShortcut(a: string, b: string): boolean {
  const left = normalizeShortcut(a)
  return left !== '' && left === normalizeShortcut(b)
}

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'AltGraph'])

/** The key part of a keyboard event, named the way the native shortcut parser expects, or '' for a bare modifier. */
export function keyFromEvent(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
  const { code, key } = event
  if (MODIFIER_CODES.has(code) || ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'].includes(key)) return ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (code && code !== 'Unidentified') return canonicalKey(code)
  return key && key.length >= 1 && key !== 'Unidentified' ? canonicalKey(key) : ''
}

/**
 * Combination currently held down. `complete` is true once a non-modifier key is
 * part of it. Used for the live preview while recording.
 */
export function shortcutFromEvent(event: ShortcutEvent): { combo: string; complete: boolean } {
  const key = keyFromEvent(event)
  const combo = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+')
  return { combo, complete: key !== '' }
}

const KEY_LABELS: Record<string, string> = {
  Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Del', Insert: 'Ins',
  Escape: 'Esc', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  PrintScreen: 'PrtSc', Pause: 'Pause',
}

/** Key caps for a shortcut, in order: ["Ctrl", "Alt", "Space"]. */
export function shortcutParts(shortcut: string): string[] {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return []
  const parts: string[] = []
  if (parsed.control) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  if (parsed.meta) parts.push('Win')
  if (parsed.key) parts.push(KEY_LABELS[parsed.key] ?? parsed.key.replace(/^Numpad/, 'Num '))
  return parts
}

export function formatShortcut(shortcut: string): string {
  return shortcutParts(shortcut).join('+')
}

/** Combinations Windows or most apps already own. Registering them would fail or break normal typing. */
const WINDOWS_RESERVED: [string, string][] = [
  ['Alt+Tab', 'Windows uses Alt+Tab to switch windows.'],
  ['Alt+Shift+Tab', 'Windows uses this to switch windows.'],
  ['Alt+F4', 'Windows uses Alt+F4 to close windows.'],
  ['Alt+Escape', 'Windows uses this to cycle windows.'],
  ['Control+Escape', 'Windows uses this to open Start.'],
  ['Control+Alt+Delete', 'Windows keeps Ctrl+Alt+Del for itself.'],
  ['Control+Shift+Escape', 'Windows uses this to open Task Manager.'],
  ['Control+Alt+Tab', 'Windows uses this to switch windows.'],
  ['Super+Shift+S', 'Windows uses this for screenshots.'],
  ...['A', 'D', 'E', 'G', 'H', 'I', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'U', 'V', 'W', 'X', 'Z', 'Tab', 'Space', 'Comma', 'Period', 'Pause', 'PrintScreen', 'Home',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map<[string, string]>(key => [`Super+${key}`, 'Windows already uses this Win shortcut.']),
]
const EDITING_RESERVED: [string, string][] = ['C', 'V', 'X', 'Z', 'Y', 'A'].map<[string, string]>(key => [`Control+${key}`, 'Almost every app uses this for editing, so it would stop working everywhere.'])
const RESERVED = new Map<string, string>([...WINDOWS_RESERVED, ...EDITING_RESERVED].map(([combo, why]) => [normalizeShortcut(combo), why]))

/** Why a combination cannot be used, or null when Windows leaves it alone. */
export function reservedReason(shortcut: string): string | null {
  return RESERVED.get(normalizeShortcut(shortcut)) ?? null
}

/** Shortcuts the app handles itself and that cannot be changed. They also block reuse. */
export const FIXED_SHORTCUTS: readonly { id: string; combo: string; label: string; hint: string }[] = [
  { id: 'close', combo: 'Escape', label: 'Close', hint: 'Close search, or fold the island back up' },
  { id: 'beam', combo: 'Control+Shift+B', label: 'Beam', hint: 'Open the file shelf to send files to your phone' },
  { id: 'find', combo: 'Control+F', label: 'Search settings', hint: 'Only while this window is focused' },
]

export interface ShortcutOther { id: string; label: string; combo: string }
export type ShortcutCheck = { ok: true; combo: string } | { ok: false; combo: string; message: string }

/**
 * Check a recorded combination. `others` are the other configurable shortcuts
 * (the one being edited is left out). Mirrors the native rule: Control, Alt or
 * Win plus one key.
 */
export function checkShortcut(shortcut: string, others: readonly ShortcutOther[]): ShortcutCheck {
  const combo = normalizeShortcut(shortcut)
  const parsed = parseShortcut(combo)
  const fail = (message: string): ShortcutCheck => ({ ok: false, combo, message })
  if (!parsed || !parsed.key) return fail('Press a key together with Ctrl, Alt or Win.')
  if (parsed.key === 'Escape' && !parsed.control && !parsed.alt && !parsed.meta) return fail('Esc cancels. Pick another key.')
  if (!parsed.control && !parsed.alt && !parsed.meta) return fail('Add Ctrl, Alt or Win. Shift alone would catch normal typing.')
  const reserved = reservedReason(combo)
  if (reserved) return fail(reserved)
  const taken = others.find(other => sameShortcut(other.combo, combo))
  if (taken) return fail(`Already used for ${taken.label}. Pick a different combination.`)
  const fixed = FIXED_SHORTCUTS.find(item => sameShortcut(item.combo, combo))
  if (fixed) return fail(`${formatShortcut(fixed.combo)} is built in: ${fixed.hint.toLowerCase()}.`)
  return { ok: true, combo }
}
