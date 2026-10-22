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

/**
 * The unlock orb: a glass disc ringed in the scene's colours. Scanning, the ring sweeps and a
 * light passes over the face; on a match it flashes white and the check draws; on a miss the
 * ring turns red and the orb shakes its head.
 */
export function FaceOrb(props: { state: GlyphState }) {
  return (
    <div class={`face-orb face-orb--${props.state}`} aria-hidden="true">
      <i class="face-orb__glow" />
      <i class="face-orb__ring" />
      <div class="face-orb__core">
        <i class="face-orb__scan" />
        <svg class="face-orb__glyph" width="58" height="58" viewBox="0 0 100 100" fill="none">
          <g class="face-orb__face">
            <path d="M6 30V18A12 12 0 0 1 18 6h12" />
            <path d="M70 6h12a12 12 0 0 1 12 12v12" />
            <path d="M94 70v12a12 12 0 0 1-12 12H70" />
            <path d="M30 94H18A12 12 0 0 1 6 82V70" />
            <path d="M32 34v9" />
            <path d="M68 34v9" />
            <path d="M51 34v21h-5" />
            <path d="M34 67q16 12 32 0" />
          </g>
          <path class="face-orb__check" d="M27 52l16 16 31-33" pathLength="100" />
        </svg>
      </div>
    </div>
  )
}
