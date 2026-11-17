/*
 * Flux Lines, the shader behind Settings > Look > Graphics: Fancy > Scene: Flux.
 * From React Bits (https://reactbits.dev/backgrounds/flux-lines). The shaders and the frame maths are theirs,
 * unchanged; the React component around them is replaced by panel/fancy.js's own loop.
 *
 * MIT + Commons Clause License Condition v1.0
 *
 * Copyright (c) 2026 David Haz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software as part of an application, website, or product,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Commons Clause Restriction
 *
 * You may use this Software, including for any commercial purpose, so long as you do not sell, sublicense, or
 * redistribute the components themselves-whether alone, in a bundle, or as a ported version.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function (root) {
    const MAX_COLORS = 8;
    const INTRO_SECONDS = 1.8;

    const VERTEX = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

    const FIELD = `
float hash(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float smin(float a, float b, float k) {
  float r = exp2(-a / k) + exp2(-b / k);
  return -k * log2(r);
}

float sinlerp(float a, float b, float w) {
  return mix(a, b, (sin(w * 3.14159265 - 3.14159265 / 2.0) + 1.0) / 2.0);
}

float vn(vec2 p, float s, float seed) {
  vec2 cellp = floor(p / s);
  vec2 relp = mod(p, s);
  float g1 = hash(vec3(cellp, seed));
  float g2 = hash(vec3(cellp.x + 1.0, cellp.y, seed));
  float g3 = hash(vec3(cellp.x + 1.0, cellp.y + 1.0, seed));
  float g4 = hash(vec3(cellp.x, cellp.y + 1.0, seed));
  float bx = sinlerp(g1, g2, relp.x / s);
  float tx = sinlerp(g4, g3, relp.x / s);
  return sinlerp(bx, tx, relp.y / s);
}

float dbn(vec2 p, float s, float seed) {
  float o = s / 2.0;
  float n0 = vn(p, s, seed);
  float n1 = vn(p + vec2(o, o), s, seed + 0.1);
  float n2 = vn(p + vec2(-o, o), s, seed + 0.2);
  float n3 = vn(p + vec2(o, -o), s, seed + 0.3);
  float n4 = vn(p + vec2(-o, -o), s, seed + 0.4);
  return (2.0 * n0 + 1.5 * n1 + 1.25 * n2 + 1.125 * n3 + n4) / 7.0;
}
`;

    const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uFlow;
uniform float uSpeed;
uniform float uScale;
uniform float uTurbulence;
uniform float uFluidity;
uniform float uRimWidth;
uniform float uSharpness;
uniform float uShimmer;
uniform float uGlow;
uniform float uLine;
uniform float uMaxHalf;
uniform vec3 uColors[${MAX_COLORS}];
uniform int uColorCount;
uniform vec4 uMagnet;
uniform vec4 uSwirl;
uniform float uReveal;
uniform float uLight;
uniform float uOpaque;
uniform vec3 uBackground;
uniform float uOpacity;
out vec4 outColor;
${FIELD}

vec3 palette(float h) {
  float x = clamp(h, 0.0, 1.0) * float(uColorCount - 1);
  int i = int(floor(x));
  int j = min(i + 1, uColorCount - 1);
  return mix(uColors[i], uColors[j], smoothstep(0.0, 1.0, x - float(i)));
}

void main() {
  float ref = 700.0 / max(uScale, 0.05);
  vec2 frag = gl_FragCoord.xy;
  vec2 toMagnet = (frag - uMagnet.xy) / uResolution.y;
  float pull = uMagnet.z * exp(-dot(toMagnet, toMagnet) / (uMagnet.w * uMagnet.w));
  if (pull > 0.001) {
    float angle = pull * 0.55;
    float c = cos(angle);
    float s = sin(angle);
    frag = uMagnet.xy + mat2(c, s, -s, c) * (frag - uMagnet.xy);
  }
  if (uSwirl.w > 0.0) {
    vec2 d = frag - uSwirl.xy;
    float reach = uSwirl.z;
    float angle = uSwirl.w * exp(-dot(d, d) / (reach * reach));
    float c = cos(angle);
    float s = sin(angle);
    frag = uSwirl.xy + mat2(c, s, -s, c) * d;
  }
  vec2 p = frag / uResolution.y * ref;

  float spd = 200.0 * uSpeed;
  float t = uTime;
  vec2 dir = uFlow;
  vec2 perp = vec2(-dir.y, dir.x);
  float distort1 = vn(p + perp * (t * spd), 60.0, 10.0) * 50.0 * uTurbulence;
  float distort2 = vn(p - perp * (t * spd), 120.0, 15.0) * 100.0 * uTurbulence;
  float peaks = dbn(p + distort1 + dir * (t * spd * 0.5), 40.0, 1.0);
  float peaks2 = dbn(p + distort2 - dir * (t * spd * 0.5), 40.0, 0.0);
  float field = smin(peaks, peaks2, max(uFluidity, 0.001));

  float slope = length(vec2(dFdx(field), dFdy(field)));
  float gap = abs(field - 0.4);
  float pixels = gap / max(slope, 1e-6);
  float halfBand = max(uRimWidth, 0.001) * 0.5;
  float across = max(gap / halfBand, pixels / uMaxHalf);
  float band = 5.0 * uRimWidth * (1.0 - across);
  float reveal = smoothstep(0.2, 0.85, pull);
  float shimmer = vn(p + dir * (t * spd * 0.5), 60.0, 12.0) * uShimmer * (1.0 - reveal * 0.75);
  float lit = clamp(band - shimmer, 0.0, 1.0);
  float glow = pow(lit, uSharpness) * uGlow * (1.0 + reveal * 0.25);
  float core = uLine > 0.0 ? smoothstep(uLine + 0.75, uLine - 0.75, pixels) * max(smoothstep(0.08, 0.6, glow), reveal) : 0.0;
  float shine = clamp(glow, 0.0, 1.0);
  float energy = max(shine * shine, core * 0.85) * uReveal;

  float h = clamp(0.5 + (peaks - peaks2) * 0.8, 0.0, 1.0);
  vec3 tint = palette(h);

  if (uLight > 0.5) {
    float chroma = max(tint.r, max(tint.g, tint.b)) - min(tint.r, min(tint.g, tint.b));
    vec3 ink = mix(vec3(0.07, 0.07, 0.08), tint * 0.55, clamp(chroma * 1.6, 0.0, 1.0));
    float cover = energy * uOpacity;
    outColor = uOpaque > 0.5 ? vec4(mix(uBackground, ink, cover), 1.0) : vec4(ink * cover, cover);
    return;
  }

  vec3 light = tint * energy * uOpacity;
  outColor = uOpaque > 0.5 ? vec4(uBackground + light, 1.0) : vec4(light, max(light.r, max(light.g, light.b)));
}`;

    const compile = (gl, type, source) => {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
        gl.deleteShader(shader);
        return null;
    };

    // Their default settings, as the panel uses them.
    const SWIRL_COOLDOWN = 3;
    const S = { speed: 0.5, scale: 1.6, turbulence: 1, fluidity: 0.1, rimWidth: 0.2, sharpness: 2.5, shimmer: 1.5, glow: 2,
        lineWidth: 1, flow: [0, -1], opacity: 1, mouseStrength: 1, mouseRadius: 0.35, mouseDampening: 0.15 };

    // create(gl) -> { frame(dt, pointer, colors, light), swirlAt(x, y) } or null when WebGL2 can't run it.
    // pointer: { x, y } in drawing-buffer pixels with y up, or null when the mouse is away. colors: [[r,g,b] 0-1, ...].
    function create(gl) {
        const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
        const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
        const program = gl.createProgram();
        if (!vertex || !fragment || !program) return null;
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.bindAttribLocation(program, 0, 'aPosition');
        gl.linkProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
        const u = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            if (info) u[info.name.replace('[0]', '')] = gl.getUniformLocation(program, info.name);
        }
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        const palette = new Float32Array(MAX_COLORS * 3);
        const magnet = { x: 0, y: 0, active: 0 };
        const swirl = { x: 0, y: 0, age: 10 };
        let time = 0, reveal = 0, wasIn = false;

        return {
            // The panel's take on their click swirl: a gentler twist that eases in, and one per SWIRL_COOLDOWN seconds.
            swirlAt(x, y) { if (swirl.age < SWIRL_COOLDOWN) return; swirl.x = x; swirl.y = y; swirl.age = 0; },
            frame(dt, pointer, colors, light, ratio) {
                time += dt;
                swirl.age += dt || 1 / 30;
                reveal = dt ? Math.min(1, reveal + dt / INTRO_SECONDS) : 1;
                if (pointer) {
                    if (!wasIn && magnet.active < 0.05) { magnet.x = pointer.x; magnet.y = pointer.y; }
                    const follow = 1 - Math.exp(-(dt || 1) / S.mouseDampening);
                    magnet.x += (pointer.x - magnet.x) * follow;
                    magnet.y += (pointer.y - magnet.y) * follow;
                }
                wasIn = !!pointer;
                const target = pointer ? 1 : 0;
                magnet.active += (target - magnet.active) * (1 - Math.exp(-(dt || 1) / 0.3));
                if (Math.abs(target - magnet.active) < 0.001) magnet.active = target;

                const cs = colors.slice(0, MAX_COLORS);
                cs.forEach((c, i) => palette.set(c, i * 3));
                const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, intro = Math.min(1, reveal);
                gl.viewport(0, 0, W, H);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.useProgram(program);
                gl.bindVertexArray(vao);
                gl.uniform2f(u.uResolution, W, H);
                gl.uniform1f(u.uTime, time);
                gl.uniform2f(u.uFlow, S.flow[0], S.flow[1]);
                gl.uniform1f(u.uSpeed, S.speed);
                gl.uniform1f(u.uScale, S.scale);
                gl.uniform1f(u.uTurbulence, S.turbulence);
                gl.uniform1f(u.uFluidity, S.fluidity);
                gl.uniform1f(u.uRimWidth, S.rimWidth);
                gl.uniform1f(u.uSharpness, S.sharpness);
                gl.uniform1f(u.uShimmer, S.shimmer);
                gl.uniform1f(u.uGlow, S.glow);
                gl.uniform1f(u.uLine, S.lineWidth * ratio * 0.5);
                gl.uniform1f(u.uMaxHalf, 28 * ratio);
                gl.uniform3fv(u.uColors, palette);
                gl.uniform1i(u.uColorCount, cs.length);
                gl.uniform4f(u.uMagnet, magnet.x, magnet.y, magnet.active * S.mouseStrength, S.mouseRadius);
                const age = swirl.age;
                const rise = Math.min(1, age / 0.6), ease = rise * rise * (3 - 2 * rise);
                const twist = 0.65 * ease * Math.exp(-Math.max(0, age - 0.6) * 0.8);
                gl.uniform4f(u.uSwirl, swirl.x, swirl.y, H * 0.26 * (1 + age * 0.3), age < 7 ? twist : 0);
                gl.uniform1f(u.uReveal, intro * intro * (3 - 2 * intro));
                gl.uniform1f(u.uLight, light ? 1 : 0);
                gl.uniform1f(u.uOpaque, 0);
                gl.uniform3fv(u.uBackground, [0, 0, 0]);
                gl.uniform1f(u.uOpacity, S.opacity);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            },
        };
    }

    root.ZSBFluxLines = { create };
})(typeof window !== 'undefined' ? window : this);
