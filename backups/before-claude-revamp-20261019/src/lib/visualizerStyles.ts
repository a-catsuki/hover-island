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
  { id: 'ambient', label: 'Atmosphere', hint: 'Full-frame spectral light' },
  { id: 'wave', label: 'Contour', hint: 'The shape of the actual sound' },
  { id: 'bars', label: 'Spectrum', hint: 'Detailed frequency columns' },
  { id: 'radial', label: 'Orbit', hint: 'Expansive frequency contours' },
  { id: 'particles', label: 'Lightfield', hint: 'Light that responds to transients' },
  { id: 'off', label: 'Off', hint: 'Hide the visualizer' },
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
  return VISUALIZER_STYLES.find((item) => item.id === normalizeVisualizerStyle(style))?.label ?? 'Atmosphere'
}
