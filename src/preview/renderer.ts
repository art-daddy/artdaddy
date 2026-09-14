// WebGL2 compositor: draws a Scene's z-ordered layers into a canvas. Straight
// (non-premultiplied) sRGB alpha-over — matching ffmpeg's default `overlay`
// (non-linear space) so the preview and the ffmpeg export agree. No happy-dom
// WebGL, so this is validated in a real browser (excluded from unit coverage).
import type { Scene } from "./scene";
import { NEUTRAL_FX } from "./scene";
import { KEY_GLSL } from "./chromaKey";
import { assertNever } from "../timeline/transition";
import type { BlendKind } from "../timeline/renderPlan";

const VERT = `#version 300 es
in vec2 a_pos;            // unit quad 0..1
uniform vec2 u_canvas;    // canvas size in px
uniform vec4 u_dst;       // x,y,w,h in canvas px (top-left origin)
uniform vec4 u_src;       // x,y,w,h in 0..1 texture space (top-left origin)
uniform float u_rotate;   // radians, clockwise (screen space); 0 = none
out vec2 v_uv;
out vec2 v_quad;
void main() {
  vec2 px = u_dst.xy + a_pos * u_dst.zw;
  vec2 c = u_dst.xy + 0.5 * u_dst.zw;   // rotate about the quad centre (= box centre)
  float s = sin(u_rotate), co = cos(u_rotate);
  vec2 d = px - c;
  px = c + vec2(co * d.x - s * d.y, s * d.x + co * d.y);
  vec2 ndc = vec2(px.x / u_canvas.x * 2.0 - 1.0, 1.0 - px.y / u_canvas.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = u_src.xy + a_pos * u_src.zw;
  v_quad = a_pos;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_quad;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec4 u_eq;         // brightness, contrast, saturation, gamma (identity 0,1,1,1)
uniform float u_exposure;  // stops; 0 = none
uniform vec3 u_wb;         // white-balance rgb gain; (1,1,1) = none
uniform vec4 u_levels;     // inBlack, inWhite, outBlack, outWhite; (0,1,0,1) = none
uniform vec2 u_hs;         // highlights, shadows; (0,0) = none
uniform int u_transMode; // 0 none/opacity, 1 wipe-l, 2 wipe-r, 3 whip (soft wipe-l)
uniform float u_transP;  // transition progress 0..1
uniform int u_solid;     // 1 = flat colour quad (dip-to-colour midpoint), ignore texture
uniform vec3 u_solidRGB;
uniform vec4 u_fx1;      // blur px, sharpen, grain 0..1, vignette 0..1
uniform vec4 u_fx2;      // glow strength, glow opacity (<0 = auto), clarity, dehaze
uniform vec4 u_fx3;      // motion smear px, denoise px, chroma similarity (<0 = off), chroma blend
uniform vec3 u_key;      // chroma key colour
uniform float u_time;    // seconds; animates grain
uniform sampler2D u_curve; // 256x1 tone ramp: rgb = per-channel, a = master
uniform int u_hasCurve;
out vec4 frag;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

${KEY_GLSL}

// Two 8-tap rings + centre: a cheap circular blur. The preview targets VISUAL
// equivalence with ffmpeg's gblur, not identical kernels, so a single-pass
// multi-tap avoids introducing offscreen framebuffers for the whole compositor.
vec3 ringBlur(vec2 uv, float radiusPx, vec2 aspect) {
  if (radiusPx <= 0.05) return texture(u_tex, uv).rgb;
  vec2 t = radiusPx / vec2(textureSize(u_tex, 0)) * aspect;
  vec3 s = texture(u_tex, uv).rgb * 2.0;
  float wsum = 2.0;
  for (int r = 1; r <= 2; r++) {
    float fr = float(r) * 0.5;
    float w = 1.0 / (1.0 + fr * 2.0);
    for (int i = 0; i < 8; i++) {
      float ang = 6.2831853 * float(i) / 8.0;
      s += texture(u_tex, uv + vec2(cos(ang), sin(ang)) * t * fr).rgb * w;
      wsum += w;
    }
  }
  return s / wsum;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  if (u_solid == 1) { frag = vec4(u_solidRGB, u_opacity); return; }
  float blurPx = u_fx1.x;
  float motionPx = u_fx3.x;
  float denoisePx = u_fx3.y;
  vec4 c = (blurPx + denoisePx) > 0.05
    ? vec4(ringBlur(v_uv, blurPx + denoisePx, vec2(1.0)), texture(u_tex, v_uv).a)
    : texture(u_tex, v_uv);
  // motion: ffmpeg tmix averages N PREVIOUS frames; a stateless draw can't, so this
  // approximates the look as a horizontal smear (preview != export, by design).
  if (motionPx > 0.05) c.rgb = ringBlur(v_uv, motionPx, vec2(1.0, 0.15));
  vec3 rgb = max(c.rgb, 0.0);
  rgb *= exp2(u_exposure);                             // exposure (stops)
  rgb *= u_wb;                                         // white balance (temp/tint)
  rgb = pow(rgb, vec3(1.0 / u_eq.w));                  // gamma
  rgb = (rgb - 0.5) * u_eq.y + 0.5;                    // contrast
  rgb = rgb + u_eq.x;                                  // brightness
  rgb = clamp((rgb - u_levels.x) / max(1e-4, u_levels.y - u_levels.x), 0.0, 1.0);
  rgb = rgb * (u_levels.w - u_levels.z) + u_levels.z;  // levels (black/white points)
  float lm = dot(rgb, LUMA);
  rgb += u_hs.y * 0.3 * (1.0 - smoothstep(0.0, 0.5, lm)); // shadows lift
  rgb += u_hs.x * 0.3 * smoothstep(0.5, 1.0, lm);         // highlights
  float luma = dot(rgb, LUMA);
  rgb = clamp(mix(vec3(luma), rgb, u_eq.z), 0.0, 1.0); // saturation
  if (u_hasCurve == 1) {                               // master then per-channel, as ffmpeg curves
    rgb = vec3(texture(u_curve, vec2(rgb.r, 0.5)).a,
               texture(u_curve, vec2(rgb.g, 0.5)).a,
               texture(u_curve, vec2(rgb.b, 0.5)).a);
    rgb = vec3(texture(u_curve, vec2(rgb.r, 0.5)).r,
               texture(u_curve, vec2(rgb.g, 0.5)).g,
               texture(u_curve, vec2(rgb.b, 0.5)).b);
  }

  // --- effects (ffmpeg applies these after the grade) ---
  float sharpen = u_fx1.y;
  if (sharpen > 0.001) {
    vec3 soft = ringBlur(v_uv, 2.0, vec2(1.0));
    rgb = clamp(rgb + (rgb - soft) * sharpen, 0.0, 1.0);
  }
  float clarity = u_fx2.z;
  if (abs(clarity) > 0.001) {
    vec3 wide = ringBlur(v_uv, 8.0, vec2(1.0));
    rgb = clamp(rgb + (rgb - wide) * clarity * 1.5, 0.0, 1.0);
  }
  float dehaze = u_fx2.w;
  if (abs(dehaze) > 0.001) {
    rgb = clamp((rgb - 0.5) * (1.0 + dehaze * 0.3) + 0.5, 0.0, 1.0);
    float dl = dot(rgb, LUMA);
    rgb = clamp(mix(vec3(dl), rgb, 1.0 + dehaze * 0.2), 0.0, 1.0);
  }
  float glow = u_fx2.x;
  if (glow > 0.001) {
    vec3 bloom = ringBlur(v_uv, 14.0 * min(1.0, glow + 0.2), vec2(1.0));
    float op = u_fx2.y >= 0.0 ? u_fx2.y : min(0.6, 0.2 + glow * 0.35);
    rgb = clamp(rgb + bloom * glow * op, 0.0, 1.0);   // screen-ish additive bloom
  }
  float grain = u_fx1.z;
  if (grain > 0.001) {
    float g = hash21(v_uv * vec2(textureSize(u_tex, 0)) + fract(u_time) * 137.0) - 0.5;
    rgb = clamp(rgb + g * grain * 0.5, 0.0, 1.0);
  }
  float vig = u_fx1.w;
  if (vig > 0.001) {
    float d = length(v_quad - 0.5) * 1.41421356;
    rgb *= 1.0 - vig * smoothstep(0.35, 1.0, d);
  }

  float a = c.a * u_opacity;
  float sim = u_fx3.z;
  if (sim >= 0.0) {                                   // chroma key
    // Same metric and same ramp as ffmpeg's chromakey (see preview/chromaKey.ts). RGB distance
    // and a smoothstep here meant similarity described a different key in each backend.
    float bl = u_fx3.w;
    float d = artdaddy_key_dist(rgb, u_key);
    a *= bl > 0.0001 ? clamp((d - sim) / bl, 0.0, 1.0) : (d > sim ? 1.0 : 0.0);
  }
  if (u_transMode == 1) { if (v_quad.x > u_transP) discard; }             // wipe-l: reveal left p
  else if (u_transMode == 2) { if (v_quad.x < 1.0 - u_transP) discard; }  // wipe-r: reveal right p
  else if (u_transMode == 3) { a *= smoothstep(v_quad.x - 0.12, v_quad.x, u_transP); } // whip: soft left wipe
  frag = vec4(rgb, a);
}`;

export class PreviewRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly textures = new Map<string, WebGLTexture>();
  private readonly loc: Record<string, WebGLUniformLocation | null>;
  private readonly aPos: number;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = (canvas as HTMLCanvasElement).getContext("webgl2", {
      alpha: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("WebGL2 is not available in this environment");
    this.gl = gl;
    this.program = this.link(VERT, FRAG);
    this.aPos = gl.getAttribLocation(this.program, "a_pos");
    this.quad = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.loc = {
      canvas: gl.getUniformLocation(this.program, "u_canvas"),
      dst: gl.getUniformLocation(this.program, "u_dst"),
      src: gl.getUniformLocation(this.program, "u_src"),
      rotate: gl.getUniformLocation(this.program, "u_rotate"),
      opacity: gl.getUniformLocation(this.program, "u_opacity"),
      eq: gl.getUniformLocation(this.program, "u_eq"),
      exposure: gl.getUniformLocation(this.program, "u_exposure"),
      wb: gl.getUniformLocation(this.program, "u_wb"),
      levels: gl.getUniformLocation(this.program, "u_levels"),
      hs: gl.getUniformLocation(this.program, "u_hs"),
      tex: gl.getUniformLocation(this.program, "u_tex"),
      transMode: gl.getUniformLocation(this.program, "u_transMode"),
      transP: gl.getUniformLocation(this.program, "u_transP"),
      solid: gl.getUniformLocation(this.program, "u_solid"),
      solidRGB: gl.getUniformLocation(this.program, "u_solidRGB"),
      fx1: gl.getUniformLocation(this.program, "u_fx1"),
      fx2: gl.getUniformLocation(this.program, "u_fx2"),
      fx3: gl.getUniformLocation(this.program, "u_fx3"),
      key: gl.getUniformLocation(this.program, "u_key"),
      time: gl.getUniformLocation(this.program, "u_time"),
      curve: gl.getUniformLocation(this.program, "u_curve"),
      hasCurve: gl.getUniformLocation(this.program, "u_hasCurve"),
    };
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type) as WebGLShader;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
      }
      return sh;
    };
    const p = gl.createProgram() as WebGLProgram;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
    }
    return p;
  }

  hasTexture(source: string): boolean {
    return this.textures.has(source);
  }

  /** Drop cached textures by key. Needed when a rasterization INPUT changes
   *  globally — the caption faces finish loading after the first frames were
   *  already rasterized in the fallback font. */
  dropTextures(match: (source: string) => boolean): void {
    const gl = this.gl;
    for (const [key, tex] of [...this.textures]) {
      if (!match(key)) continue;
      gl.deleteTexture(tex);
      this.textures.delete(key);
    }
  }

  /** One reusable 256x1 ramp for tone curves (re-uploaded per graded layer). */
  private curve: WebGLTexture | null = null;
  private curveTex(): WebGLTexture {
    const gl = this.gl;
    if (!this.curve) {
      this.curve = gl.createTexture() as WebGLTexture;
      gl.bindTexture(gl.TEXTURE_2D, this.curve);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    return this.curve;
  }

  /** Upload (or replace) a source's texture. Straight alpha, top-left origin. */
  setTexture(source: string, image: TexImageSource): void {
    const gl = this.gl;
    let tex = this.textures.get(source);
    if (!tex) {
      tex = gl.createTexture() as WebGLTexture;
      this.textures.set(source, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Composite the scene: black canvas + each layer alpha-over by z. */
  render(scene: Scene): void {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement | OffscreenCanvas;
    if (canvas.width !== scene.width || canvas.height !== scene.height) {
      canvas.width = scene.width;
      canvas.height = scene.height;
    }
    gl.viewport(0, 0, scene.width, scene.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.loc.canvas, scene.width, scene.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.loc.tex, 0);
    for (const layer of scene.layers) {
      const solid = layer.solid;
      const tex = solid ? null : this.textures.get(layer.source);
      if (!solid && !tex) continue; // textured layer whose asset isn't loaded yet
      if (layer.rotate !== 0) {
        // Clip the rotated quad to its axis-aligned box (ffmpeg ow=iw:oh=ih).
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(
          Math.round(layer.clipBox.x),
          Math.round(scene.height - layer.clipBox.y - layer.clipBox.h),
          Math.round(layer.clipBox.w),
          Math.round(layer.clipBox.h),
        );
      } else {
        gl.disable(gl.SCISSOR_TEST);
      }
      if (tex) gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform4f(this.loc.dst, layer.dst.x, layer.dst.y, layer.dst.w, layer.dst.h);
      gl.uniform4f(this.loc.src, layer.src.x, layer.src.y, layer.src.w, layer.src.h);
      gl.uniform1f(this.loc.rotate, layer.rotate);
      const tr = layer.transition;
      let transMode = 0;
      if (tr) {
        if (tr.kind === "wipe-l") transMode = 1;
        else if (tr.kind === "wipe-r") transMode = 2;
        else if (tr.kind === "whip") transMode = 3;
      }
      gl.uniform1f(this.loc.opacity, layer.opacity); // scene applied crossfade/dip ramps
      gl.uniform1i(this.loc.transMode, transMode);
      gl.uniform1f(this.loc.transP, tr ? tr.p : 1);
      gl.uniform1i(this.loc.solid, solid ? 1 : 0);
      if (solid) gl.uniform3f(this.loc.solidRGB, solid[0], solid[1], solid[2]);
      gl.uniform4f(this.loc.eq, layer.eq[0], layer.eq[1], layer.eq[2], layer.eq[3]);
      gl.uniform1f(this.loc.exposure, layer.exposure);
      gl.uniform3f(this.loc.wb, layer.wb[0], layer.wb[1], layer.wb[2]);
      gl.uniform4f(
        this.loc.levels,
        layer.levels[0],
        layer.levels[1],
        layer.levels[2],
        layer.levels[3],
      );
      gl.uniform2f(this.loc.hs, layer.hs[0], layer.hs[1]);
      const fx = layer.fx ?? NEUTRAL_FX;
      gl.uniform4f(this.loc.fx1, fx.a[0], fx.a[1], fx.a[2], fx.a[3]);
      gl.uniform4f(this.loc.fx2, fx.b[0], fx.b[1], fx.b[2], fx.b[3]);
      gl.uniform4f(this.loc.fx3, fx.c[0], fx.c[1], fx.c[2], fx.c[3]);
      gl.uniform3f(this.loc.key, fx.key[0], fx.key[1], fx.key[2]);
      gl.uniform1f(this.loc.time, scene.time ?? 0);
      if (layer.curve) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.curveTex());
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, layer.curve);
        gl.uniform1i(this.loc.curve, 1);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.uniform1i(this.loc.hasCurve, layer.curve ? 1 : 0);
      this.setBlend(layer.blend);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Per-layer blend mode (best-effort: add/multiply/screen via fixed-function). Closed BlendKind
   *  dispatch — assertNever catches a new contract blend value at compile time. Fixed-function blend
   *  can't express overlay, so normal+overlay share the straight-alpha default (unchanged behaviour). */
  private setBlend(mode: BlendKind): void {
    const gl = this.gl;
    switch (mode) {
      case "add":
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
        break;
      case "multiply":
        gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case "screen":
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case "normal":
      case "overlay":
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      default:
        assertNever(mode);
    }
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.textures.clear();
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.program);
  }

  /** Read back the framebuffer (RGBA, bottom-up rows — GL origin is bottom-left). */
  readPixels(): { data: Uint8Array; width: number; height: number } {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, width, height };
  }

  /** Encode the CURRENT framebuffer to a JPEG (project thumbnail). readPixels is
   *  bottom-up, so rows are flipped to top-down; the image is then downscaled so
   *  its longest edge is <= `maxEdge` and encoded. Browser-only (OffscreenCanvas
   *  2D). Call right after render() — the context is not preserveDrawingBuffer. */
  async captureJpeg(maxEdge = 480, quality = 0.72): Promise<ArrayBuffer> {
    const { data, width, height } = this.readPixels();
    if (!width || !height) throw new Error("empty framebuffer");
    const flipped = new Uint8ClampedArray(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const from = (height - 1 - y) * rowBytes;
      flipped.set(data.subarray(from, from + rowBytes), y * rowBytes);
    }
    const full = new OffscreenCanvas(width, height);
    const fctx = full.getContext("2d");
    if (!fctx) throw new Error("2d context unavailable");
    fctx.putImageData(new ImageData(flipped, width, height), 0, 0);
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    let out = full;
    if (scale < 1) {
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      out = new OffscreenCanvas(w, h);
      const octx = out.getContext("2d");
      if (!octx) throw new Error("2d context unavailable");
      octx.drawImage(full, 0, 0, w, h);
    }
    const blob = await out.convertToBlob({ type: "image/jpeg", quality });
    return blob.arrayBuffer();
  }
}
