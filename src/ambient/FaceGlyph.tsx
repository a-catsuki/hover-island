export type GlyphState = 'face' | 'scanning' | 'success' | 'fail'

/**
 * The face-scan glyph: corner brackets around a simple face. While scanning it folds into a
 * spinning ring of dots, which closes into a check mark on success; on failure the face
 * shakes its head.
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
      <circle class="face-glyph__ring" cx="50" cy="50" r="40" pathLength="100" />
      <circle class="face-glyph__ring-solid" cx="50" cy="50" r="40" pathLength="100" />
      <path class="face-glyph__check" d="M30 51l14 14 27-29" pathLength="100" />
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
