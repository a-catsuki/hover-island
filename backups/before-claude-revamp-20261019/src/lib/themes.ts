import type { VisualizerStyle } from './visualizerStyles'

export interface TemplatePreset {
  id: string
  label: string
  accent: string
  accent2: string
  surface0: string
  surface1: string
  surface2: string
  /** top stop of the notch material gradient (pure CSS, no native effect) */
  notch0: string
  /** bottom stop of the notch material gradient */
  notch1: string
  visualizer: VisualizerStyle
  /** CSS gradient used for the preview swatch */
  swatch: string
}

/** Curated appearance combinations. Each card writes existing, persisted settings. */
export interface ScenePreset {
  id: string
  label: string
  description: string
  theme: string
  background: 'aurora' | 'reactive' | 'artwork' | 'ember' | 'plain' | 'contours' | 'dots' | 'grid' | 'waves'
}

export const SCENE_PRESETS: ScenePreset[] = [
  { id: 'graphite', label: 'Graphite', description: 'Quiet charcoal with a cool blue edge', theme: 'midnight', background: 'plain' },
  { id: 'contour', label: 'Contour', description: 'Soft blue light with fine topographic lines', theme: 'frost', background: 'contours' },
  { id: 'aurora', label: 'Aurora', description: 'Mint and cyan light, gently layered', theme: 'aurora', background: 'aurora' },
  { id: 'ember', label: 'Ember', description: 'Warm rose light over a deep evening scene', theme: 'sunset', background: 'ember' },
  { id: 'paper', label: 'Paper', description: 'Low-color monochrome with a silver accent', theme: 'mono', background: 'plain' },
]

export const TEMPLATES: TemplatePreset[] = [
  {
    id: 'frost',
    label: 'Frost',
    accent: '#6e8bff',
    accent2: '#b18cff',
    surface0: 'rgba(12, 12, 14, 0.72)',
    surface1: 'rgba(22, 22, 26, 0.78)',
    surface2: 'rgba(34, 34, 40, 0.72)',
    notch0: '#0a0b10',
    notch1: '#171a23',
    visualizer: 'pulse',
    swatch: 'linear-gradient(135deg, #6e8bff, #b18cff)',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    accent: '#818cf8',
    accent2: '#312e81',
    surface0: 'rgba(6, 7, 12, 0.82)',
    surface1: 'rgba(14, 16, 24, 0.84)',
    surface2: 'rgba(24, 27, 38, 0.8)',
    notch0: '#05060b',
    notch1: '#0f1119',
    visualizer: 'bloom',
    swatch: 'linear-gradient(135deg, #818cf8, #0b1020)',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    accent: '#34d399',
    accent2: '#22d3ee',
    surface0: 'rgba(8, 16, 15, 0.72)',
    surface1: 'rgba(14, 24, 23, 0.78)',
    surface2: 'rgba(22, 36, 34, 0.72)',
    notch0: '#06110f',
    notch1: '#0f1c19',
    visualizer: 'aurora',
    swatch: 'linear-gradient(135deg, #34d399, #22d3ee)',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    accent: '#fb7185',
    accent2: '#fbbf24',
    surface0: 'rgba(22, 12, 14, 0.74)',
    surface1: 'rgba(32, 18, 20, 0.78)',
    surface2: 'rgba(46, 26, 26, 0.72)',
    notch0: '#130b0d',
    notch1: '#211316',
    visualizer: 'bars',
    swatch: 'linear-gradient(135deg, #fb7185, #fbbf24)',
  },
  {
    id: 'neon',
    label: 'Neon',
    accent: '#f0abfc',
    accent2: '#22d3ee',
    surface0: 'rgba(10, 8, 18, 0.78)',
    surface1: 'rgba(18, 14, 30, 0.8)',
    surface2: 'rgba(28, 22, 44, 0.74)',
    notch0: '#090714',
    notch1: '#151129',
    visualizer: 'wave',
    swatch: 'linear-gradient(135deg, #f0abfc, #22d3ee)',
  },
  {
    id: 'mono',
    label: 'Mono',
    accent: '#d4d4d8',
    accent2: '#a1a1aa',
    surface0: 'rgba(12, 12, 13, 0.8)',
    surface1: 'rgba(22, 22, 24, 0.82)',
    surface2: 'rgba(34, 34, 37, 0.76)',
    notch0: '#0a0a0b',
    notch1: '#18181a',
    visualizer: 'halo',
    swatch: 'linear-gradient(135deg, #d4d4d8, #71717a)',
  },
  {
    id: 'matcha',
    label: 'Matcha',
    accent: '#a3e635',
    accent2: '#4ade80',
    surface0: 'rgba(12, 16, 10, 0.74)',
    surface1: 'rgba(20, 26, 16, 0.78)',
    surface2: 'rgba(30, 40, 24, 0.72)',
    notch0: '#0a1007',
    notch1: '#151f10',
    visualizer: 'silk',
    swatch: 'linear-gradient(135deg, #a3e635, #4ade80)',
  },
]

export function getTemplate(id: string): TemplatePreset {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]
}

function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  const r = parseInt(full.slice(0, 2), 16) || 0
  const g = parseInt(full.slice(2, 4), 16) || 0
  const b = parseInt(full.slice(4, 6), 16) || 0
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function applyTemplate(id: string): void {
  if (typeof document === 'undefined') return
  const t = getTemplate(id)
  const root = document.documentElement.style
  root.setProperty('--accent', t.accent)
  root.setProperty('--accent-2', t.accent2)
  root.setProperty('--accent-soft', withAlpha(t.accent, 0.18))
  root.setProperty('--surface-0', t.surface0)
  root.setProperty('--surface-1', t.surface1)
  root.setProperty('--surface-2', t.surface2)
  root.setProperty('--notch-bg-0', t.notch0)
  root.setProperty('--notch-bg-1', t.notch1)
}
