// Cyberpunk / Tron Neon Renderer: scene is drawn into a data buffer (shade, inkId, normal.xy) + depth,
// then a high-performance GLSL post-processing pass renders glowing neon contours, circuit grids,
// multi-tap procedural bloom, and dark cyber atmospheric fog.
import * as THREE from 'three';

export const INK = {
  CYAN: 0,
  MAGENTA: 1,
  DARK: 2,
  AMBER: 3,
  GREEN: 4,
  WHITE: 5,
  PURPLE: 6,
  LIME: 7,
  ORANGE: 8,
  PINK: 9,
  // Backward compatibility aliases
  BLUE: 0,
  RED: 1,
  BLACK: 2,
  YELLOW: 7,
};

export const INK_COLORS = [
  new THREE.Vector3(0.00, 0.94, 1.00), // 0: electric cyan (#00f0ff)
  new THREE.Vector3(1.00, 0.00, 0.50), // 1: neon magenta (#ff007f)
  new THREE.Vector3(0.035, 0.05, 0.08), // 2: carbon graphite (#090d15)
  new THREE.Vector3(1.00, 0.67, 0.00), // 3: neon amber (#ffaa00)
  new THREE.Vector3(0.00, 1.00, 0.40), // 4: neon emerald green (#00ff66)
  new THREE.Vector3(0.90, 0.98, 1.00), // 5: bright white plasma (#e6fcff)
  new THREE.Vector3(0.68, 0.28, 1.00), // 6: neon purple (#ad47ff)
  new THREE.Vector3(0.85, 1.00, 0.00), // 7: electric lime (#d9ff00)
  new THREE.Vector3(1.00, 0.33, 0.00), // 8: blaze orange (#ff5500)
  new THREE.Vector3(1.00, 0.15, 0.62), // 9: hot pink (#ff269e)
];

export const PLAYER_COLORS = [
  { ink: 0, hex: '#00f0ff', name: 'Cian' },
  { ink: 1, hex: '#ff007f', name: 'Magenta' },
  { ink: 3, hex: '#ffaa00', name: 'Ámbar' },
  { ink: 4, hex: '#00ff66', name: 'Verde' },
  { ink: 6, hex: '#ad47ff', name: 'Púrpura' },
  { ink: 7, hex: '#d9ff00', name: 'Lima' },
  { ink: 8, hex: '#ff5500', name: 'Naranja' },
  { ink: 9, hex: '#ff269e', name: 'Rosa' },
  { ink: 5, hex: '#e6fcff', name: 'Plasma' },
];

export const LIGHT_WORLD = new THREE.Vector3(0.38, 0.82, 0.42).normalize();
export const shared = { uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 } };

const inkVert = /* glsl */`
varying vec3 vNormalV;
varying vec4 vColorData;
uniform float uTime;
void main() {
  vec3 transformed = position;
  vec3 objectNormal = normal;
  #ifdef USE_INSTANCING
    transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
    objectNormal = mat3(instanceMatrix) * objectNormal;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vColorData = vec4(instanceColor, 1.0);
  #else
    vColorData = vec4(0.0, 0.0, 0.0, -1.0);
  #endif
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vNormalV = normalize(normalMatrix * objectNormal);
  gl_Position = projectionMatrix * mvPosition;
}`;

const inkFrag = /* glsl */`
precision highp float;
uniform float uInk;
uniform float uFill;
uniform float uShadeScale;
uniform float uShadeBias;
uniform vec3 uLightDir;
varying vec3 vNormalV;
varying vec4 vColorData;
void main() {
  vec3 n = normalize(vNormalV);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, uLightDir) * 0.5 + 0.5;
  float ink = uInk; float fill = uFill;
  if (vColorData.a > 0.0) { ink = vColorData.r; fill = vColorData.g; }
  float shade = clamp(ndl * uShadeScale + uShadeBias, 0.0, 1.0);
  if (fill > 0.5) shade = -1.0;
  gl_FragColor = vec4(shade, ink, n.x, n.y);
}`;

export function makeInkMaterial(opts = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uInk: { value: opts.ink ?? INK.CYAN }, uFill: { value: opts.fill ? 1 : 0 },
      uShadeScale: { value: opts.shadeScale ?? 1.0 }, uShadeBias: { value: opts.shadeBias ?? 0.0 },
      uLightDir: shared.uLightDir, uTime: shared.uTime,
    },
    vertexShader: inkVert, fragmentShader: inkFrag, side: opts.side ?? THREE.FrontSide,
  });
  m.inkId = opts.ink ?? INK.CYAN;
  return m;
}
export function setInk(mat, ink) { mat.uniforms.uInk.value = ink; mat.inkId = ink; }
export function setFill(mat, fill) { mat.uniforms.uFill.value = fill ? 1 : 0; }

const postVert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const postFrag = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uAspect;
uniform float uTime;
uniform float uNear;
uniform float uFar;
uniform float uHurt;
uniform float uFlash;
uniform float uSlow;
uniform float uLowHp;
uniform vec3 uInks[10];
uniform mat4 uInvProj;
uniform mat4 uInvView;

float linDepth(float z) { float zn = z * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear)); }
vec3 inkColor(float id) {
  int i = int(id + 0.5);
  if (i <= 0) return uInks[0];
  if (i == 1) return uInks[1];
  if (i == 2) return uInks[2];
  if (i == 3) return uInks[3];
  if (i == 4) return uInks[4];
  if (i == 5) return uInks[5];
  if (i == 6) return uInks[6];
  if (i == 7) return uInks[7];
  if (i == 8) return uInks[8];
  return uInks[9];
}

float gridPulse(vec2 p, float spacing, float width) {
  vec2 f = abs(fract(p / spacing) - 0.5) * spacing;
  float d = min(f.x, f.y);
  return 1.0 - smoothstep(0.0, width, d);
}

void main() {
  vec2 px = 1.0 / uRes;
  float sc = uRes.y / 900.0;
  vec2 suv = vUv;
  vec4 s = texture2D(tScene, suv);
  float z = texture2D(tDepth, suv).x;
  float d = linDepth(z);

  // Edge detection via inverse depth differences and normal divergence
  float o = 1.25 * sc;
  vec2 ox = vec2(o, 0.0) * px, oy = vec2(0.0, o) * px;
  float zl = texture2D(tDepth, suv - ox).x, zr = texture2D(tDepth, suv + ox).x;
  float zu = texture2D(tDepth, suv + oy).x, zd = texture2D(tDepth, suv - oy).x;
  vec4 sl = texture2D(tScene, suv - ox), sr = texture2D(tScene, suv + ox);
  vec4 su = texture2D(tScene, suv + oy), sd = texture2D(tScene, suv - oy);

  float iw = 1.0 / d;
  float lap = abs(1.0 / linDepth(zl) + 1.0 / linDepth(zr) - 2.0 * iw)
            + abs(1.0 / linDepth(zu) + 1.0 / linDepth(zd) - 2.0 * iw);
  float edgeLo = mix(0.035, 0.08, smoothstep(8.0, 60.0, d));
  float edgeHi = mix(0.18, 0.32, smoothstep(8.0, 60.0, d));
  float edge = smoothstep(edgeLo, edgeHi, lap / (iw + 1e-7));

  float nEdge = length(sl.ba - sr.ba) + length(su.ba - sd.ba);
  edge = max(edge, smoothstep(0.32, 0.76, nEdge));

  // Front-most edge ink color identification
  float zmin = z; float inkId = s.g;
  if (zl < zmin) { zmin = zl; inkId = sl.g; }
  if (zr < zmin) { zmin = zr; inkId = sr.g; }
  if (zu < zmin) { zmin = zu; inkId = su.g; }
  if (zd < zmin) { zmin = zd; inkId = sd.g; }
  bool sky = z >= 0.99999;

  // Background deep cyber void with subtle starry grid horizon
  vec3 cyberVoid = vec3(0.02, 0.03, 0.055);
  vec3 col = cyberVoid;

  if (!sky) {
    // Reconstruct world position from depth buffer
    vec4 clip = vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
    vec4 vpos = uInvProj * clip; vpos /= vpos.w;
    vec3 wpos = (uInvView * vec4(vpos.xyz, 1.0)).xyz;
    vec2 nxy = s.ba;
    vec3 nView = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
    vec3 wn = normalize(mat3(uInvView) * nView);
    vec3 an = abs(wn);
    vec2 surfCoord = an.y > max(an.x, an.z) ? wpos.xz : (an.x > an.z ? wpos.zy : wpos.xy);

    // Subtle Tron digital grid on surfaces
    float gSpacing = (d < 2.0) ? 0.3 : 2.0;
    float gThick = (d < 2.0) ? 0.015 : 0.045;
    float cyberGrid = gridPulse(surfCoord, gSpacing, gThick);

    // Matte carbon/graphite base or emissive fill
    if (s.r < 0.0) {
      // Direct emissive fill element
      col = inkColor(s.g) * 1.35;
    } else {
      vec3 surfaceMat = (s.g == 2.0) ? vec3(0.03, 0.045, 0.08) : (inkColor(s.g) * 0.18 + vec3(0.02, 0.03, 0.05));
      col = surfaceMat;
      vec3 gridColor = (s.g == 2.0) ? uInks[0] : inkColor(s.g);
      col += gridColor * cyberGrid * 0.22;
      // Specular highlight / Fresnel rim
      float fresnel = pow(1.0 - max(0.0, dot(normalize(-vpos.xyz), nView)), 3.0);
      col += gridColor * fresnel * 0.18;
    }

    // High-intensity neon contouring
    vec3 edgeCol = (inkId == 2.0) ? uInks[0] * 0.85 : inkColor(inkId) * 1.45;
    col = mix(col, edgeCol, clamp(edge * 1.6, 0.0, 1.0));
  }

  // Multi-tap Procedural Bloom / Glow Pass (sampling high-luminance neighbors)
  vec3 bloom = vec3(0.0);
  float bScale = 2.8 * sc;
  vec2 bOffsets[8];
  bOffsets[0] = vec2(-1.5, -1.5) * px * bScale;
  bOffsets[1] = vec2( 1.5, -1.5) * px * bScale;
  bOffsets[2] = vec2(-1.5,  1.5) * px * bScale;
  bOffsets[3] = vec2( 1.5,  1.5) * px * bScale;
  bOffsets[4] = vec2(-3.2,  0.0) * px * bScale;
  bOffsets[5] = vec2( 3.2,  0.0) * px * bScale;
  bOffsets[6] = vec2( 0.0, -3.2) * px * bScale;
  bOffsets[7] = vec2( 0.0,  3.2) * px * bScale;

  for (int k = 0; k < 8; k++) {
    vec4 smp = texture2D(tScene, suv + bOffsets[k]);
    float smpZ = texture2D(tDepth, suv + bOffsets[k]).x;
    if (smpZ < 0.9999) {
      if (smp.g != 2.0 || smp.r < 0.0) {
        bloom += inkColor(smp.g) * 0.14;
      } else {
        bloom += uInks[0] * 0.035;
      }
    }
  }
  // Add glowing emissive halo
  col += bloom * 0.75;

  // Atmospheric exponential distance fog to deep black
  float fogFactor = 1.0 - exp(-d * 0.012);
  col = mix(col, cyberVoid, clamp(fogFactor, 0.0, 0.95));

  // Neon damage vignette / hurt pulse
  vec2 vc = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(0.28, 0.88, length(vc));
  float hurt = clamp(uHurt + uLowHp * (0.35 + 0.3 * sin(uTime * 7.0)), 0.0, 1.0);
  col = mix(col, uInks[1] * 1.6, hurt * vig * 0.85);

  // Muzzle flash / explosion whiteout
  col = mix(col, uInks[5] * 1.5, uFlash * 0.8);

  // Slowdown matrix cyan wash
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum) * uInks[0] * 1.4, uSlow * 0.6);

  gl_FragColor = vec4(col, 1.0);
}`;

export class InkRenderer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x040711, 0.012);
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.08, 420);
    const depthTexture = new THREE.DepthTexture(2, 2); depthTexture.format = THREE.DepthFormat; depthTexture.type = THREE.FloatType;
    this.rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
    this.post = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.rt.texture }, tDepth: { value: depthTexture }, uRes: { value: new THREE.Vector2(2, 2) }, uAspect: { value: 1 },
        uTime: { value: 0 }, uNear: { value: this.camera.near }, uFar: { value: this.camera.far }, uHurt: { value: 0 }, uFlash: { value: 0 }, uSlow: { value: 0 },
        uLowHp: { value: 0 }, uInks: { value: INK_COLORS },
        uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() },
      },
      vertexShader: postVert, fragmentShader: postFrag, depthTest: false, depthWrite: false,
    });
    this.postScene = new THREE.Scene(); this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post));
    this._clear = new THREE.Color(0x040711);
    this._ld = new THREE.Vector3();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const w = Math.max(2, window.innerWidth), h = Math.max(2, window.innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio); this.renderer.setSize(w, h, false);
    const rw = Math.floor(w * this.pixelRatio), rh = Math.floor(h * this.pixelRatio);
    this.rt.setSize(rw, rh);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const u = this.post.uniforms; u.uRes.value.set(rw, rh); u.uAspect.value = w / h;
  }
  render(time, fx = {}) {
    shared.uTime.value = time;
    this.camera.updateMatrixWorld(); this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    shared.uLightDir.value.copy(LIGHT_WORLD).transformDirection(this.camera.matrixWorldInverse);
    const r = this.renderer;
    r.setRenderTarget(this.rt); r.setClearColor(this._clear, 1); r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    const u = this.post.uniforms; u.uTime.value = time; u.uNear.value = this.camera.near; u.uFar.value = this.camera.far;
    u.uInvProj.value.copy(this.camera.projectionMatrixInverse); u.uInvView.value.copy(this.camera.matrixWorld);
    u.uHurt.value = fx.hurt || 0; u.uFlash.value = fx.flash || 0; u.uSlow.value = fx.slow || 0; u.uLowHp.value = fx.lowHp || 0;
    r.render(this.postScene, this.postCam);
  }
}

