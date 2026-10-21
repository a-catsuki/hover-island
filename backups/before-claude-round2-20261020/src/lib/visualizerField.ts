import type { VisualizerDynamics } from './visualizerEngine'

const VERTEX = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`

// Original, single-pass field: low frequencies bend its structure, midrange
// transports the folds, treble resolves their edges, and detected onsets add
// a short light impulse. There is no independent animation clock.
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_resolution;
uniform vec3 u_primary;
uniform vec3 u_secondary;
uniform vec4 u_audio;
uniform float u_kick;
uniform float u_phase;
uniform float u_gain;
uniform float u_mode;
uniform float u_gentle;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ridge(float x, float tightness) { return pow(0.5 + 0.5 * cos(x), tightness); }

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = (uv - 0.5) * vec2(2.8, 2.3);
  float bass = u_audio.x * u_gain;
  float mid = u_audio.y * u_gain;
  float treble = u_audio.z * u_gain;
  float energy = u_audio.w * u_gain;
  float kick = u_kick * (1.0 - u_gentle);
  float travel = u_phase * (1.0 - u_gentle);

  // Domain bending keeps every edge part of the composition, including in a
  // short panoramic tile. All coordinates are normalized to the actual frame.
  p.x += sin(p.y * 1.65 + travel * 0.8) * (0.22 + bass * 0.38);
  p.y += sin(p.x * 1.25 - travel * 0.65) * (0.18 + mid * 0.29);
  p += sin(vec2(p.y, p.x) * 2.15 + travel) * (0.055 + bass * 0.07);

  float fold = sin(p.x * 1.3 + p.y * 0.95 + travel * 0.4);
  fold += sin(p.y * 2.1 - p.x * 0.72 - travel * 0.35) * 0.54;
  fold += sin(p.x * 3.8 + sin(p.y * 1.8 + travel)) * (0.11 + bass * 0.035);
  float fine = sin(p.x * 7.5 - p.y * 2.6 + fold * 1.6) * 0.1;
  float colorMix = 0.5 + 0.5 * sin(fold * 1.6 + p.x * 0.5);
  vec3 tint = mix(u_primary, u_secondary, colorMix);
  vec3 dark = mix(vec3(0.018, 0.026, 0.047), tint * 0.065, 0.55);
  float broad = 0.5 + 0.5 * sin(fold * 2.3 + fine);
  float contour = ridge(fold * (14.0 + treble * 5.0) + fine * 3.0, 21.0);
  float gleam = ridge(fold * 4.5 - 1.1, 7.0);
  float intensity = 0.38 + energy * 0.57;
  vec3 color = dark + tint * (0.055 + broad * 0.20) * intensity;

  if (u_mode < 0.5) {
    // Satin-like luminous folds. Broad light and fine ridges share the same
    // continuous field, rather than floating as a little central decoration.
    color += tint * gleam * (0.09 + bass * 0.20);
    color += mix(tint, vec3(0.92, 0.96, 1.0), 0.38) * contour * (0.12 + treble * 0.35 + kick * 0.18);
    color += u_secondary * ridge(fold * 9.0 + p.y * 2.0, 30.0) * (0.045 + mid * 0.1);
  } else {
    // Intersecting caustics and sparse light grains form a continuous liquid
    // field. Transients brighten existing intersections rather than spawning
    // unbounded particles or unrelated fireworks.
    float crossing = sin(p.y * 2.0 + p.x * 0.6 + sin(p.x * 2.1 - travel));
    float causticA = ridge(fold * 14.0 + fine, 30.0);
    float causticB = ridge(crossing * 17.0 - fine * 2.0, 38.0);
    color += tint * broad * (0.04 + bass * 0.15);
    color += mix(tint, vec3(0.92, 0.97, 1.0), 0.35) * (causticA + causticB * 0.68) * (0.11 + mid * 0.28);
    color += vec3(0.8, 0.92, 1.0) * causticA * causticB * (0.24 + treble * 0.7 + kick * 0.6);
    vec2 cell = floor(uv * vec2(54.0, 34.0));
    vec2 dotPosition = fract(uv * vec2(54.0, 34.0)) - 0.5;
    float dust = 1.0 - smoothstep(0.0, 0.11, length(dotPosition));
    float sparse = step(0.96, hash(cell));
    color += tint * dust * sparse * (0.12 + treble * 0.45 + kick * 0.28);
  }

  // Gentle edge shading preserves full-frame detail without a hard black rim.
  float edge = 1.0 - dot(uv - 0.5, uv - 0.5) * 0.48;
  color *= edge;
  gl_FragColor = vec4(color, 1.0);
}
`

function rgb(color: string): [number, number, number] {
  const hex = color.trim().replace(/^#/, '')
  if (/^[\da-f]{3}$/i.test(hex)) return [0, 1, 2].map(index => parseInt(hex[index] + hex[index], 16) / 255) as [number, number, number]
  if (/^[\da-f]{6}$/i.test(hex)) return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number]
  const parts = color.match(/[\d.]+/g)
  return parts && parts.length >= 3 ? [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255] : [0.55, 0.62, 1]
}

export function createVisualizerField(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false })
  if (!gl) return null
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null
  let buffer: WebGLBuffer | null = null
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('Could not allocate visualizer shader')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Visualizer shader unavailable')
    }
    program = gl.createProgram()
    if (!program) throw new Error('Could not allocate visualizer program')
    shaders.forEach(shader => gl.attachShader(program!, shader))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Visualizer program unavailable')
    gl.useProgram(program)
    buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const uniform = (name: string) => gl.getUniformLocation(program!, name)
    const resolution = uniform('u_resolution')
    const primary = uniform('u_primary')
    const secondary = uniform('u_secondary')
    const audio = uniform('u_audio')
    const kick = uniform('u_kick')
    const phase = uniform('u_phase')
    const gain = uniform('u_gain')
    const mode = uniform('u_mode')
    const gentle = uniform('u_gentle')
    return {
      resize(width: number, height: number, accent: string, accent2: string) {
        gl.useProgram(program)
        gl.viewport(0, 0, width, height)
        gl.uniform2f(resolution, width, height)
        gl.uniform3f(primary, ...rgb(accent))
        gl.uniform3f(secondary, ...rgb(accent2))
      },
      draw(lightfield: boolean, state: VisualizerDynamics, intensity: number, reducedMotion: boolean) {
        if (gl.isContextLost()) return false
        gl.useProgram(program)
        gl.uniform4f(audio, state.bass, state.mid, state.treble, state.energy)
        gl.uniform1f(kick, state.kick)
        gl.uniform1f(phase, state.phase)
        gl.uniform1f(gain, 0.45 + (Number.isFinite(intensity) ? Math.max(0, Math.min(1.6, intensity)) : 0.7) * 0.72)
        gl.uniform1f(mode, lightfield ? 1 : 0)
        gl.uniform1f(gentle, reducedMotion ? 1 : 0)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
        return true
      },
      dispose() {
        gl.deleteBuffer(buffer)
        gl.deleteProgram(program)
        shaders.forEach(shader => gl.deleteShader(shader))
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      },
    }
  } catch {
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    shaders.forEach(shader => gl.deleteShader(shader))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return null
  }
}
