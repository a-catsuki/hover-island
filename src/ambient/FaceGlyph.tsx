import { For } from 'solid-js'

export type GlyphState = 'face' | 'scanning' | 'success' | 'fail'

const DOTS = 28

/**
 * The face-scan glyph, after Face ID's: corner brackets around a simple face. Scanning folds the
 * face away and sweeps in a spinning ring of dots, which closes into a solid ring and a check
 * that pops on success; on failure the face comes back and shakes its head.
 */
export default function FaceGlyph(props: { state: GlyphState; size?: number }) {
  return (
    <svg class={`face-glyph face-glyph--${props.state}`} width={props.size ?? 84} height={props.size ?? 84} viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <g class="face-glyph__face">
        <g class="face-glyph__corners">
          <path d="M6 30V18A12 12 0 0 1 18 6h12" />
          <path d="M70 6h12a12 12 0 0 1 12 12v12" />
          <path d="M94 70v12a12 12 0 0 1-12 12H70" />
          <path d="M30 94H18A12 12 0 0 1 6 82V70" />
        </g>
        <g class="face-glyph__features">
          <path d="M32 34v9" />
          <path d="M68 34v9" />
          <path d="M51 34v21h-5" />
          <path d="M34 67q16 12 32 0" />
        </g>
      </g>
      <g class="face-glyph__dots">
        <For each={Array.from({ length: DOTS }, (_, index) => index)}>{index => {
          const angle = (index / DOTS) * Math.PI * 2 - Math.PI / 2
          return <circle cx={50 + Math.cos(angle) * 40} cy={50 + Math.sin(angle) * 40} r="3.1" style={{ '--i': index, '--o': 0.18 + 0.82 * (index / (DOTS - 1)) }} />
        }}</For>
      </g>
      <circle class="face-glyph__ring" cx="50" cy="50" r="40" pathLength="100" />
      <path class="face-glyph__check" d="M31 51.5l12.5 12.5 26-27.5" pathLength="100" />
    </svg>
  )
}

/** The padlock in the notch. The shackle lifts and swings open on unlock. */
export function Padlock(props: { open: boolean; size?: number }) {
  return (
    <svg class="padlock" classList={{ 'padlock--open': props.open }} width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path class="padlock__shackle" d="M7.5 11V7.5a4.5 4.5 0 0 1 9 0V11" />
      <rect class="padlock__body" x="4.5" y="10.5" width="15" height="11" rx="2.6" />
    </svg>
  )
}
