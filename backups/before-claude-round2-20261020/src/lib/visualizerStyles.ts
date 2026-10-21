/** Persisted names are retained only to migrate an existing appearance. */
export type VisualizerStyle =
  | 'ambient' | 'wave' | 'bars' | 'radial' | 'particles' | 'off'
  | 'aurora' | 'pulse' | 'bloom' | 'silk' | 'halo' | 'orbit' | 'mirror'

export type VisualizerMode = 'ambient' | 'wave' | 'bars' | 'radial' | 'particles' | 'off'

export interface VisualizerStyleOption {
  id: VisualizerMode
  label: string
  hint: string
}

export const VISUALIZER_STYLES: ReadonlyArray<VisualizerStyleOption> = [
  { id: 'ambient', label: 'Compact bars', hint: 'Live bars beside the title' },
  { id: 'wave', label: 'Contour', hint: 'Bars plus a large waveform' },
  { id: 'bars', label: 'Spectrum', hint: 'Bars plus large frequency columns' },
  { id: 'radial', label: 'Orbit', hint: 'Bars plus a large radial view' },
  { id: 'particles', label: 'Lightfield', hint: 'Bars plus light that follows beats' },
  { id: 'off', label: 'Off', hint: 'No visualiser' },
]

const ALIASES: Readonly<Record<string, VisualizerMode>> = {
  ambient: 'ambient', aurora: 'ambient', pulse: 'ambient', bloom: 'ambient',
  wave: 'wave', silk: 'wave',
  bars: 'bars', mirror: 'bars',
  radial: 'radial', halo: 'radial', orbit: 'radial', rings: 'radial',
  particles: 'particles', orb: 'ambient', off: 'off',
}

/** Old names select a new renderer; none of the old drawing code is retained. */
export function normalizeVisualizerStyle(style: string | null | undefined): VisualizerMode {
  return style && Object.hasOwn(ALIASES, style) ? ALIASES[style] : 'ambient'
}

export function visualizerStyleLabel(style: string): string {
  return VISUALIZER_STYLES.find((item) => item.id === normalizeVisualizerStyle(style))?.label ?? 'Compact bars'
}
