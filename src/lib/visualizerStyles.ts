/** Persisted names are retained only to migrate an existing appearance. */
export type VisualizerStyle =
  | 'ambient' | 'wave' | 'bars' | 'radial' | 'particles' | 'off'
  | 'aurora' | 'pulse' | 'bloom' | 'silk' | 'halo' | 'orbit' | 'mirror'

/**
 * The four full-bleed media backdrops plus off. Ids are the persisted names the native
 * settings validator already accepts; the labels are what people see:
 * ambient = Flow (default), wave = Aurora, bars = Bars, radial = Pulse.
 */
export type VisualizerMode = 'ambient' | 'wave' | 'bars' | 'radial' | 'off'

export interface VisualizerStyleOption {
  id: VisualizerMode
  label: string
  hint: string
}

export const VISUALIZER_STYLES: ReadonlyArray<VisualizerStyleOption> = [
  { id: 'ambient', label: 'Flow', hint: 'Soft mirrored ribbons that follow the music' },
  { id: 'wave', label: 'Aurora', hint: 'Slow curtains of colour from the top edge' },
  { id: 'bars', label: 'Bars', hint: 'Soft columns rising from the bottom edge' },
  { id: 'radial', label: 'Pulse', hint: 'Glows and rings that move with the beat' },
  { id: 'off', label: 'Off', hint: 'No visualiser' },
]

const ALIASES: Readonly<Record<string, VisualizerMode>> = {
  ambient: 'ambient', bloom: 'ambient', silk: 'ambient', orb: 'ambient',
  wave: 'wave', aurora: 'wave', particles: 'wave',
  bars: 'bars', mirror: 'bars',
  radial: 'radial', pulse: 'radial', halo: 'radial', orbit: 'radial', rings: 'radial',
  off: 'off',
}

/** Old names select a new renderer; none of the old drawing code is retained. */
export function normalizeVisualizerStyle(style: string | null | undefined): VisualizerMode {
  return style && Object.hasOwn(ALIASES, style) ? ALIASES[style] : 'ambient'
}

export function visualizerStyleLabel(style: string): string {
  return VISUALIZER_STYLES.find((item) => item.id === normalizeVisualizerStyle(style))?.label ?? 'Flow'
}
