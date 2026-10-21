import BeamBucket from './BeamBucket'
import './NearbyView.css'

/**
 * Beam is one surface: the phone bucket (QR) and Nearby (LocalSend) devices share
 * the same radar and transfer list, so the widget and any full-size host render
 * the same thing. `compact` is kept for the widget registry.
 */
export default function NearbyView(props: { compact?: boolean }) {
  return <div class="nearby" classList={{ 'nearby--compact': props.compact }}><BeamBucket/></div>
}
