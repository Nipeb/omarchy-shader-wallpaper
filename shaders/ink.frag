#version 440

// Ink -- dye dropped into dark water, rendered from the live simulation in
// ink-sim.frag. The dye persists and builds up across frames; this pass only
// decides how it looks:
//
// - Four dyes, theme-derived: the accent and two hues turned either side of
//   it for the drops, and a deep accent the tree bleeds. Overlapping dyes mix
//   by weight, and thickness sets opacity through Beer-Lambert falloff, so
//   thin veils stay translucent and cores go dense.
// - The dye is lit as a surface: its thickness gradient is the normal, so
//   filaments get a lit side and a shadow side. Thick folds darken, and the
//   edge of every patch gets a darker drying-edge line, the way real ink
//   pools at its boundary.
// - Caustics: light through the rippling surface dances on the floor behind
//   the dye. The dye absorbs it, and the dye's own gradient refracts it.
// - Each drop hits the surface first: a ring of capillary ripples spreads
//   from the impact and refracts everything under it for a moment.
// - Motes of silt hang in the water and glint when a caustic crosses them.
// - The tree is a solid in the water. The current parts round it and it
//   bleeds its own dye from its outline.

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    float time;
    float aspect;
    vec4 bgColor;
    vec4 fgColor;
    vec4 accentColor;
    vec4 mutedColor;
    vec4 urgentColor;
    float iconWarpScale;
    float edgeGlowWidth;
    float edgeGlowBrightness;
    float inkFlow;
    vec2 inkTexel;
};

layout(binding = 1) uniform sampler2D maskSource;
layout(binding = 2) uniform sampler2D distSource;
layout(binding = 3) uniform sampler2D inkState;

const float ICON_SCALE = 0.6;

// ---------------------------------------------------------------- noise ---

float hash21(vec2 p) {
    // Periodic input: keeps the hash well-mixed for the huge coordinates a
    // long-running clock produces (days of uptime), and is seamless because
    // every lattice using it repeats exactly every 4096 cells.
    p = mod(p, 4096.0);
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}

float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.08; a *= 0.5; }
    return v;
}

// ---------------------------------------------------------------- colour ---

vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 shifted(vec3 hsv, float deg, float satMul, float valMul) {
    return hsv2rgb(vec3(fract(hsv.x + deg / 360.0),
                        clamp(hsv.y * satMul, 0.0, 1.0),
                        clamp(hsv.z * valMul, 0.0, 1.0)));
}

// ----------------------------------------------------------------- drops ---
// Shared with ink-sim.frag -- keep the two copies identical.

vec4 dropSlot(float k) {
    float period = 5.5 + k * 2.35;
    float tt = time + k * 3.7 + 1.3;
    float id = floor(tt / period);
    float age = tt - id * period;
    float h1 = hash21(vec2(id, k * 13.1 + 1.7));
    float h2 = hash21(vec2(id + 5.3, k * 7.7 + 0.3));
    float h3 = hash21(vec2(id + 9.1, k * 3.3 + 8.8));
    // Either side of the tree, never onto it -- the mark would swallow it.
    float side = h1 < 0.5 ? -1.0 : 1.0;
    float x = side * mix(0.40, aspect * 0.5 - 0.15, fract(h1 * 2.0));
    vec2 pos = vec2(x, -0.34 + h2 * 0.30);
    return vec4(pos, age, h3);
}

// Surface height of the capillary ring a drop throws out on impact.
float ripple(vec2 p, vec4 dr) {
    float age = dr.z;
    if (age > 3.0) return 0.0;
    float dist = length(p - dr.xy);
    float front = 0.02 + age * 0.22;
    float x = dist - front;
    // A short wave train behind the front, fading as it spreads.
    float env = exp(-x * x / 0.0016) * exp(-age * 1.3) / (1.0 + dist * 6.0);
    return sin(x * 110.0) * env;
}

float surface(vec2 p, vec4 d0, vec4 d1, vec4 d2) {
    float t = time;
    // Gentle standing chop so caustics move even between drops.
    float chop = (fbm3(p * 3.2 + vec2(t * 0.11, t * 0.07))
                + fbm3(p * 5.1 - vec2(t * 0.09, -t * 0.13))) * 0.5;
    return chop * 0.35 + ripple(p, d0) + ripple(p, d1) + ripple(p, d2);
}

// ---------------------------------------------------------------- light ---

// Classic iterated caustic: light focused by a moving surface into bright
// webbing on the floor.
float caustic(vec2 p) {
    float t = time * 0.35;
    p = p * 3.0 - 250.0;
    vec2 i = p;
    float c = 1.0;
    const float inten = 0.0065;
    for (int n = 0; n < 4; n++) {
        float tn = t * (1.0 - (3.5 / float(n + 1)));
        i = p + vec2(cos(tn - i.x) + sin(tn + i.y), sin(tn - i.y) + cos(tn + i.x));
        c += 1.0 / length(vec2(p.x / (sin(i.x + tn) / inten), p.y / (cos(i.y + tn) / inten)));
    }
    c /= 4.0;
    c = 1.17 - pow(c, 1.4);
    return pow(abs(c), 7.0);
}

float treeAt(vec2 q) {
    vec2 uv = q / ICON_SCALE + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture(maskSource, uv).a;
}

vec2 toUV(vec2 q) { return vec2(q.x / aspect, q.y) + 0.5; }

// ------------------------------------------------------------------ main ---

void main() {
    vec2 uv = qt_TexCoord0;
    vec2 p = uv - 0.5;
    p.x *= aspect;
    float t = time;

    vec4 d0 = dropSlot(0.0);
    vec4 d1 = dropSlot(1.0);
    vec4 d2 = dropSlot(2.0);

    // ---- the water surface: refraction for everything below it ----
    const float se = 0.004;
    float hC = surface(p, d0, d1, d2);
    float hX = surface(p + vec2(se, 0.0), d0, d1, d2);
    float hY = surface(p + vec2(0.0, se), d0, d1, d2);
    vec2 surfGrad = vec2(hX - hC, hY - hC) / se;
    vec2 refr = surfGrad * 0.0022;
    vec2 pr = p + refr;

    // ---- dye ----
    vec2 st = toUV(pr);
    vec4 S = texture(inkState, st);
    vec2 tx = inkTexel * 1.5;
    vec4 Sx0 = texture(inkState, st - vec2(tx.x, 0.0));
    vec4 Sx1 = texture(inkState, st + vec2(tx.x, 0.0));
    vec4 Sy0 = texture(inkState, st - vec2(0.0, tx.y));
    vec4 Sy1 = texture(inkState, st + vec2(0.0, tx.y));
    float T = S.r + S.g + S.b + S.a;
    vec2 gT = vec2(dot(Sx1 - Sx0, vec4(1.0)), dot(Sy1 - Sy0, vec4(1.0)));

    // Dye colours: accent plus two neighbours on the wheel, and a deep one
    // for the tree's own bleed.
    vec3 accHsv = rgb2hsv(accentColor.rgb);
    vec3 cR = shifted(accHsv, 0.0, 1.05, 1.0);
    vec3 cG = shifted(accHsv, 48.0, 1.10, 0.95);
    vec3 cB = shifted(accHsv, -52.0, 1.10, 0.90);
    vec3 cA = mix(shifted(accHsv, -12.0, 1.2, 0.55), fgColor.rgb * 0.30, 0.25);
    vec3 dyeHue = (cR * S.r + cG * S.g + cB * S.b + cA * S.a) / max(T, 1e-4);

    // ---- the floor, lit by caustics ----
    vec3 water = mix(bgColor.rgb * 0.80, mutedColor.rgb, 0.10);
    // The dye's gradient bends light too, so caustics warp at filament edges.
    vec2 cp = (pr + gT * 0.010) * 2.4;
    float cst = caustic(cp + vec2(t * 0.02, 0.0));
    float cst2 = caustic(cp * 1.7 + vec2(3.1, 1.7));
    float causticLight = clamp(cst * 0.7 + cst2 * 0.3, 0.0, 1.5);
    // Deeper water (lower on screen) gets less of it.
    float depthFade = mix(1.0, 0.45, smoothstep(-0.5, 0.5, p.y));
    vec3 lightTint = mix(fgColor.rgb, accentColor.rgb, 0.45);
    vec3 floorCol = water + lightTint * causticLight * 0.13 * depthFade;

    // ---- compose dye over the floor ----
    float opacity = 1.0 - exp(-T * 2.3);
    // Lit like a surface: normal from the thickness gradient.
    vec3 n = normalize(vec3(-gT * 2.2, 1.0));
    vec3 L = normalize(vec3(-0.45, -0.60, 0.66));
    float diffuse = 0.62 + 0.55 * max(dot(n, L), 0.0);
    // Scattered light inside the dye: thin veils glow, thick cores go dark.
    float scatter = exp(-T * 0.9);
    vec3 dyeCol = dyeHue * diffuse * (0.45 + 0.70 * scatter);
    // Where dye folds over itself it pools darker and more saturated.
    float fold = smoothstep(0.9, 2.6, T);
    dyeCol = mix(dyeCol, dyeHue * 0.28, fold * 0.6);
    // Drying edge: a darker line where the dye gradient is steep.
    float edgeLine = smoothstep(0.08, 0.55, length(gT)) * smoothstep(0.05, 0.35, T);
    dyeCol *= 1.0 - edgeLine * 0.35;
    // Caustic light filtered by the dye, dimmed by its thickness.
    dyeCol += dyeHue * causticLight * 0.10 * scatter * depthFade;

    vec3 col = mix(floorCol, dyeCol, opacity);

    // ---- silt motes ----
    // A sparse field drifting slowly downward; each glints when a caustic
    // passes over it and hides inside thick dye.
    vec2 mq = (pr + vec2(0.0, -t * 0.006)) * 55.0;
    vec2 mid = floor(mq);
    float mh = hash21(mid);
    if (mh > 0.955) {
        vec2 jit = vec2(hash21(mid + 3.1), hash21(mid + 7.7)) - 0.5;
        vec2 wob = vec2(sin(t * 0.4 + mh * 40.0), cos(t * 0.33 + mh * 23.0)) * 0.12;
        float md = length(fract(mq) - 0.5 - jit * 0.6 - wob);
        float mote = smoothstep(0.07, 0.0, md);
        col += lightTint * mote * (0.05 + causticLight * 0.35) * (1.0 - opacity * 0.8);
    }

    // ---- the tree ----
    // Seen through the surface, so ripples wobble it too.
    vec2 iconUV = pr / ICON_SCALE + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float edge = 0.0;
    if (inIcon) {
        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        edge = clamp(length(vec2(aR - aL, aD - aU)), 0.0, 1.0);
    }
    // A dark, wet solid, with caustics playing across it.
    vec3 markColor = mix(accentColor.rgb, bgColor.rgb, 0.90) * 0.55 + lightTint * causticLight * 0.04;
    col = mix(col, markColor, mask.a * 0.92);
    col += mix(accentColor.rgb, fgColor.rgb, 0.45) * edge * 0.26 * edgeGlowBrightness;

    // ---- surface glints ----
    // Specular off the ripples: bright only on fresh rings.
    vec3 sn = normalize(vec3(-surfGrad * 0.35, 1.0));
    float spec = pow(max(dot(sn, normalize(vec3(0.3, -0.5, 0.8))), 0.0), 60.0);
    float rings = abs(ripple(p, d0)) + abs(ripple(p, d1)) + abs(ripple(p, d2));
    col += lightTint * spec * clamp(rings * 3.0, 0.0, 1.0) * 0.35;

    // Soft vignette -- the light falls off toward the corners of the tank.
    vec2 vq = vec2(p.x / aspect, p.y) * 2.0;
    col *= 1.0 - 0.28 * smoothstep(0.55, 1.35, length(vq));

    col = col / (1.0 + max(col - vec3(0.85), vec3(0.0)));

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
