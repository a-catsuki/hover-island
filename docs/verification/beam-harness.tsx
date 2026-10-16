import { render } from 'solid-js/web'
import BeamBucket from '../../src/components/views/BeamBucket'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
export function mount(root:HTMLElement) {return render(()=><BeamBucket/>,root)}
