export type VisualizerStyle =
  | 'ambient'
  | 'aurora'
  | 'pulse'
  | 'bloom'
  | 'silk'
  | 'halo'
  | 'orbit'
  | 'bars'
  | 'mirror'
  | 'radial'
  | 'particles'
  | 'wave'
  | 'off'

export interface VisualizerStyleOption {
  id: VisualizerStyle
  label: string
  hint: string
}

export const VISUALIZER_STYLES: ReadonlyArray<VisualizerStyleOption> = [
  { id: 'ambient', label: 'Ambient', hint: 'Reactive ambient light' },
  { id: 'pulse', label: 'Pulse', hint: 'Ambient pulsing glow' },
  { id: 'aurora', label: 'Aurora', hint: 'Flowing ribbons' },
  { id: 'bloom', label: 'Bloom', hint: 'Soft breathing orb' },
  { id: 'silk', label: 'Silk', hint: 'Drifting strands' },
  { id: 'wave', label: 'Wave', hint: 'Mirrored waveform' },
  { id: 'halo', label: 'Halo', hint: 'Spectrum ring' },
  { id: 'orbit', label: 'Orbit', hint: 'Rotating spokes' },
  { id: 'bars', label: 'Bars', hint: 'Classic equalizer' },
  { id: 'mirror', label: 'Mirror', hint: 'Symmetric spectrum' },
  { id: 'radial', label: 'Radial', hint: 'Circular spectrum' },
  { id: 'particles', label: 'Particles', hint: 'Beat-lit particle field' },
  { id: 'off', label: 'Off', hint: 'Hidden' },
]

const STYLE_IDS = new Set<string>(VISUALIZER_STYLES.map((style) => style.id))

/** Accepts legacy persisted values ('orb', 'rings') and anything unknown. */
export function normalizeVisualizerStyle(style: string | null | undefined): VisualizerStyle {
  if (style === 'orb') return 'bloom'
  if (style === 'rings') return 'halo'
  if (style && STYLE_IDS.has(style)) return style as VisualizerStyle
  return 'pulse'
}

export function visualizerStyleLabel(style: VisualizerStyle): string {
  return VISUALIZER_STYLES.find((item) => item.id === style)?.label ?? 'Pulse'
}
