#version 440

// Weather -- the landscape outside, under the sky outside, right now. Fed by
// the same location and Open-Meteo source as the Omarchy weather widget: the
// sun rides a real arc from sunrise to sunset and the moon (in its actual
// phase) from sunset to sunrise, and the current conditions set the clouds,
// wind, rain, snow, fog and storms.
//
// The scene is built in depth so it never reads flat:
//   sky      -- theme-tinted gradient with a sun-side glow; a perspective
//               cumulus deck whose clouds shrink toward the horizon, lit on
//               the sun side and dark underneath; high cirrus that catches
//               sunset; crepuscular rays through gaps in the cloud
//   night    -- stars, a milky way, shooting stars, and on some clear nights
//               an aurora
//   land     -- three mountain ranges fading into the air with distance,
//               shaded by slope toward the sun, snow-capped when cold, with
//               valley fog lying between them
//   lake     -- mirrors the sky, the mountains and the tree, rippled by the
//               wind, with a glitter path under the sun or moon and rain rings
//   shore    -- grass that bends in the wind, and big spruces framing the
//               sides, which hold snow
//   life     -- birds crossing on fair days, fireflies on warm nights, and
//               lightning that actually strikes
//
// Nothing varies only with the weather code: cloud cover drifts locally,
// clouds evolve, and the aurora and bird flights come and go on their own
// clocks, so two hours of the same forecast still look different.

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
    float edgeGlowWidth;
    float edgeGlowBrightness;
    float sunPhase;    // 0..1 across daylight, 1..2 across the night
    float moonPhase;   // 0 new, 0.5 full
    float wxCloud;     // 0..1 cover
    float wxRain;      // 0..1 intensity
    float wxSnow;      // 0..1 intensity
    float wxFog;       // 0..1
    float wxStorm;     // 0..1
    float wxWind;      // 0..1 (about 0..60 km/h)
    float wxTemp;      // degrees C
};

layout(binding = 1) uniform sampler2D maskSource;
layout(binding = 2) uniform sampler2D distSource;

const float PI = 3.14159265;
const float WL = 0.27;          // water line / horizon (screen y, down)
const float ICON_SCALE = 0.6;

// ---------------------------------------------------------------- noise ---

float hash1(float n) {
    return fract(sin(n * 78.233) * 43758.5453123);
}

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
}

float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.52; }
    return v;
}

// Ridged 1-D noise for mountain crests: sharp peaks, rounded valleys.
float ridged(float x, float seed) {
    float v = 0.0, a = 0.55, f = 1.0;
    for (int i = 0; i < 5; i++) {
        float n = vnoise(vec2(x * f, seed + float(i) * 7.1));
        v += a * (1.0 - abs(n * 2.0 - 1.0));
        f *= 2.1; a *= 0.48;
    }
    return v;
}

float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
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

// How much a colour reads as sunset: saturated and near orange (~30 deg).
float warmScore(vec3 c) {
    vec3 h = rgb2hsv(c);
    float d = abs(h.x - 30.0 / 360.0);
    d = min(d, 1.0 - d);
    return h.y * (1.0 - d * 2.0) + 1e-3;
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// ------------------------------------------------------ shared scene state ---
// Set once in main(), read by the scene functions (also for the reflection).

float gDaylight, gTwilight, gGloom, gCover, gStorm, gDrift, gHalfW, gCold;
float gSideSign, gFlash, gFlashX, gBodyUp, gNight;
vec2 gBody;
vec3 gSkyTop, gSkyLow, gDusk, gBodyCol, gSunLight, gAccHsv;
bool gIsDay;

// ---------------------------------------------------------------- clouds ---

// Cumulus deck on a plane above the land, seen in perspective: clouds are
// large overhead and shrink and flatten toward the horizon.
float cloudDensity(vec2 p, bool fine) {
    float h = WL - p.y;
    if (h <= 0.004) return 0.0;
    float z = 1.0 / (h + 0.09);
    vec2 cp = vec2(p.x * z * 0.55, z * 1.1) + vec2(gDrift, 0.0);
    float evo = time * 0.005;
    vec2 w = vec2(fbm3(cp * 0.6 + vec2(evo, 1.3)), fbm3(cp * 0.6 + vec2(4.1, -evo)));
    float n = fine ? fbm5(cp + w * 0.85) : fbm3(cp + w * 0.85);
    // Cover is not uniform: it drifts regionally, so the sky breaks up in
    // one place while it closes in another.
    float local = (fbm3(cp * 0.13 + vec2(time * 0.0012, 7.0)) - 0.5) * 0.45;
    float cover = clamp(gCover + local, 0.0, 1.0);
    float thr = mix(0.82, 0.26, cover);
    return smoothstep(thr, thr + 0.20, n) * smoothstep(0.0, 0.07, h);
}

// Wispy high cloud: no perspective, stretched by the jet stream.
float cirrus(vec2 p) {
    vec2 q = vec2(p.x * 0.7 + gDrift * 0.35, p.y * 6.0);
    float n = fbm5(q + vec2(fbm3(q * vec2(0.4, 1.6) + time * 0.003) * 1.4, 0.0));
    // Some days have lots, some none -- a slow clock of its own.
    float amount = smoothstep(0.35, 0.75, vnoise(vec2(time / 1500.0, 3.3))) * (1.0 - gGloom);
    return smoothstep(0.52, 0.86, n) * amount * smoothstep(WL - 0.05, -0.2, p.y);
}

// ---------------------------------------------------------------- land ---

float farRidge(float x)  { return WL - 0.012 - 0.20 * pow(ridged(x * 0.85 + 3.0, 1.0), 1.7); }
float midRidge(float x)  { return WL - 0.006 - 0.12 * pow(ridged(x * 1.35 + 11.0, 9.0), 1.5); }

// Forested near hills: smooth humps topped with a comb of small spruces.
float nearRidge(float x, float py) {
    float base = WL - 0.004 - 0.045 * fbm3(vec2(x * 1.8 + 5.0, 2.0));
    float cell = floor(x * 110.0);
    float cx = (cell + 0.5) / 110.0;
    float th = 0.004 + 0.012 * hash1(cell * 1.7 + 3.0);
    float present = step(0.25, hash1(cell * 3.1));
    float top = base - th * present;
    // Triangle: widens with depth below its tip.
    float w = max(py - top, 0.0) * 0.42;
    float inTree = step(abs(x - cx), w) * present;
    return inTree > 0.5 ? top : base;
}

// Relief on a mountain face: ridged noise stretched downhill, so it reads
// as gullies and spurs running down from the crest.
float gully(vec2 q) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) {
        v += a * (1.0 - abs(vnoise(q) * 2.0 - 1.0));
        q = q * 2.1 + vec2(3.7, 1.3); a *= 0.5;
    }
    return v;
}

// Aerial perspective + slope lighting for one mountain range.
vec3 shadeRange(vec2 p, float ridgeY, float slope, float depth, vec3 rock) {
    vec3 air = mix(gSkyLow, gSkyTop, 0.25);
    // Faces turned toward the sun catch it; normal ~ (dY/dx, -1).
    // Normal: the crest's own slope near the top, the face relief below.
    float below0 = max(p.y - ridgeY, 0.0);
    vec2 q = vec2(p.x * 16.0 + p.y * 3.0, p.y * 3.5) + depth * 17.0;
    const float e = 0.03;
    float hC = gully(q);
    vec2 grad = vec2(gully(q + vec2(e, 0.0)) - hC, gully(q + vec2(0.0, e)) - hC) / e;
    vec2 n = normalize(vec2(slope * exp(-below0 * 30.0) + grad.x * 0.16, -1.0));
    vec2 toSun = normalize(gBody - p + vec2(1e-4));
    float lit = clamp(dot(n, toSun), 0.0, 1.0) * (0.35 + 0.65 * gDaylight) * (1.0 - gGloom * 0.7);
    float below = clamp((p.y - ridgeY) / 0.12, 0.0, 1.0);
    vec3 c = rock * (0.55 + 0.9 * lit) * (1.0 - below * 0.35);
    // Rock texture: strata and gullies.
    c *= 0.88 + 0.22 * fbm3(vec2(p.x * 26.0, p.y * 40.0 + p.x * 9.0));
    // Snow above a line set by the temperature.
    float alt = WL - p.y;
    float snowAlt = mix(0.30, 0.03, clamp(gCold + wxSnow * 0.8, 0.0, 1.0))
                  + (fbm3(vec2(p.x * 30.0, 1.0)) - 0.5) * 0.04;
    float snow = smoothstep(snowAlt, snowAlt + 0.012, alt) * step(0.02, gCold + wxSnow);
    vec3 snowCol = mix(fgColor.rgb, gSkyLow, 0.35) * (0.45 + 0.75 * lit + 0.2 * gDaylight);
    c = mix(c, snowCol, snow * (0.55 + 0.45 * smoothstep(0.0, 0.4, lit + 0.2)));
    // Distance: hazes into the air colour.
    return mix(c, air, depth);
}

// ----------------------------------------------------------------- sky ---

vec3 skyAt(vec2 p, bool refl) {
    float up = 1.0 - smoothstep(-0.5, WL, p.y);
    vec3 col = mix(gSkyLow, gSkyTop, pow(up, 0.8));
    float dBody = length(p - gBody);

    // Sun-side brightening and the twilight band.
    float sideW = smoothstep(-gHalfW, gHalfW, p.x * gSideSign);
    float band = exp(-max(WL - p.y, 0.0) * 3.0);
    col += gDusk * gTwilight * band * (0.25 + 0.75 * sideW) * 1.3 * (1.0 - gGloom * 0.55);
    col += gSunLight * exp(-dBody * 2.2) * 0.22 * gDaylight * (1.0 - gGloom * 0.6);

    // ---- night sky ----
    float starVis = (1.0 - gDaylight) * (1.0 - gTwilight * 0.6) * (1.0 - wxFog * 0.8);
    if (starVis > 0.01) {
        // Milky way: a soft diagonal band, clumped and lane-split.
        float bandD = dot(p, normalize(vec2(0.42, 1.0))) - 0.05;
        float mw = exp(-bandD * bandD / 0.018) * (0.4 + 0.9 * fbm5(p * 5.0 + 3.0))
                 * smoothstep(0.35, 0.65, fbm3(p * 9.0));
        col += mix(fgColor.rgb, accentColor.rgb, 0.35) * mw * 0.16 * starVis * up;

        for (int layer = 0; layer < 2; layer++) {
            float sc = layer == 0 ? 60.0 : 28.0;
            vec2 sq = p * sc + float(layer) * 17.0;
            vec2 sid = floor(sq);
            float sh = hash21(sid + 5.1);
            float thresh = layer == 0 ? 0.93 - mw * 0.15 : 0.975;
            if (sh > thresh) {
                vec2 jit = vec2(hash21(sid + 2.2), hash21(sid + 8.8)) - 0.5;
                float d = length(fract(sq) - 0.5 - jit * 0.8);
                float tw = 0.55 + 0.45 * sin(time * (0.6 + sh * 3.0) + sh * 70.0);
                float size = layer == 0 ? 0.09 : 0.12;
                vec3 sc3 = mix(fgColor.rgb, hsv2rgb(vec3(fract(gAccHsv.x + hash21(sid) * 0.3 - 0.15), 0.35, 1.0)), 0.4);
                col += sc3 * (1.0 - smoothstep(0.0, size, d)) * tw * starVis * up * (layer == 0 ? 0.55 : 0.9);
            }
        }

        // Aurora on some clear nights: curtains with a sharp lower hem.
        float auroraNight = smoothstep(0.45, 0.8, vnoise(vec2(time / 1100.0, 5.0)))
                          + smoothstep(0.4, 1.0, gCold) * 0.35;
        float aVis = clamp(auroraNight, 0.0, 1.0) * starVis * (1.0 - gCover * 0.9);
        if (aVis > 0.01) {
            float wob = fbm3(vec2(p.x * 1.6, time * 0.015));
            float hem = -0.20 + 0.07 * sin(p.x * 1.1 + time * 0.021) + 0.035 * sin(p.x * 5.0 + wob * 5.0 + time * 0.05);
            float above = hem - p.y;
            float reach = 0.16 + 0.14 * fbm3(vec2(p.x * 3.0, time * 0.03));
            float curtain = above > 0.0 ? exp(-above / reach * 2.2) : exp(above * 80.0);
            // Separate sheets that brighten and fade along the arc.
            float sheets = 0.15 + 0.85 * smoothstep(0.30, 0.62, fbm3(vec2(p.x * 0.7 + time * 0.012, 7.0)));
            float rays = pow(fbm3(vec2(p.x * 38.0 + wob * 6.0 + time * 0.12, time * 0.06)), 2.0) * 2.2;
            float fold = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(p.x * 7.0 + wob * 9.0), 3.0);
            curtain *= sheets;
            vec3 hemCol = hsv2rgb(vec3(fract(gAccHsv.x + 0.10), clamp(gAccHsv.y * 1.2 + 0.2, 0.0, 1.0), 1.0));
            vec3 crownCol = hsv2rgb(vec3(fract(gAccHsv.x - 0.12), clamp(gAccHsv.y * 1.2 + 0.2, 0.0, 1.0), 0.9));
            vec3 ac = mix(hemCol, crownCol, smoothstep(0.0, 0.2, above));
            col += ac * curtain * rays * fold * aVis * 0.85;
        }

        // Shooting star: rare, quick.
        if (!refl) {
            float seg = floor(time / 19.0);
            if (hash1(seg * 2.3) > 0.55) {
                float st = fract(time / 19.0) * 19.0 - hash1(seg * 4.1) * 12.0;
                if (st > 0.0 && st < 0.8) {
                    vec2 s0 = vec2((hash1(seg * 5.3) - 0.5) * gHalfW * 1.6, -0.45 + hash1(seg * 6.7) * 0.2);
                    vec2 dir = normalize(vec2(hash1(seg) > 0.5 ? 1.0 : -1.0, 0.45));
                    vec2 head = s0 + dir * st * 0.55;
                    vec2 tail = head - dir * 0.12 * min(st * 3.0, 1.0);
                    float d = segDist(p, head, tail);
                    float along = clamp(dot(p - tail, dir) / 0.12, 0.0, 1.0);
                    col += fgColor.rgb * exp(-d / 0.0012) * along * (1.0 - st / 0.8) * starVis * 1.3;
                }
            }
        }
    }

    // ---- sun or moon ----
    if (gIsDay) {
        float disc = 1.0 - smoothstep(0.020, 0.025, dBody);
        float glow = exp(-dBody * 14.0) * 0.45 + exp(-dBody * 45.0) * 0.6;
        col += gBodyCol * disc * 1.2 * (1.0 - gGloom * 0.85);
        col += gBodyCol * glow * (1.0 - gGloom * 0.45);
    } else {
        float r = 0.032;
        vec2 lp = (p - gBody) / r;
        float disc = 1.0 - smoothstep(0.90, 1.0, length(lp));
        float k = cos(moonPhase * 2.0 * PI);
        float xt = k * sqrt(max(1.0 - lp.y * lp.y, 0.0));
        float lit = moonPhase < 0.5 ? smoothstep(-0.08, 0.08, lp.x - xt)
                                    : smoothstep(-0.08, 0.08, -xt - lp.x);
        float fullness = 0.5 - 0.5 * k;
        float maria = 0.78 + 0.22 * smoothstep(0.35, 0.65, fbm3(lp * 1.8 + 3.0));
        col = mix(col, col * 0.4, disc);
        col += gBodyCol * disc * (lit * maria + 0.05) * (1.0 - gGloom * 0.6);
        // Halo ring on hazy nights, plain glow otherwise.
        float halo = exp(-pow((dBody - 0.11) / 0.02, 2.0)) * clamp(gCover * 1.5, 0.0, 1.0) * 0.08;
        col += gBodyCol * (exp(-dBody * 7.0) * 0.22 + halo) * fullness * (1.0 - gGloom * 0.7);
    }

    // ---- high cirrus: catches sunset long after the land is dark ----
    float ci = cirrus(p);
    vec3 cirCol = mix(mix(gSkyLow, fgColor.rgb, 0.4) * (0.35 + 0.65 * gDaylight), gDusk * 1.2, gTwilight * 0.85);
    col = mix(col, cirCol, ci * 0.55);

    // ---- cumulus ----
    float d = cloudDensity(p, true);
    if (d > 0.002) {
        vec2 toSun = normalize(gBody - p + vec2(1e-4));
        float dS = cloudDensity(p + toSun * 0.022, false);
        float dU = cloudDensity(p + vec2(0.0, -0.02), false);
        float lit = clamp(0.55 + (d - dS) * 3.6, 0.05, 1.5);
        // Undersides (denser above than here) sit in their own shadow.
        float under = clamp((dU - d) * 2.0 + d * 0.5, 0.0, 1.0);
        vec3 shadowCol = mix(gSkyTop, bgColor.rgb, 0.45) * (0.55 + 0.35 * gDaylight);
        vec3 litCol = mix(gSkyLow, fgColor.rgb, 0.55) * (0.45 + 0.75 * gDaylight) + gDusk * gTwilight * 0.9;
        vec3 cc = mix(shadowCol, litCol, clamp(lit * (1.0 - under * 0.6), 0.0, 1.3));
        // Silver lining near the sun or moon.
        cc += gBodyCol * exp(-length(p - gBody) * 5.0) * (1.0 - d) * 0.7 * (gIsDay ? 1.0 : 0.35);
        cc *= 1.0 - gStorm * 0.5;
        // Lightning lights the deck from inside.
        cc += mix(accentColor.rgb, fgColor.rgb, 0.4) * gFlash * exp(-abs(p.x - gFlashX) * 1.6) * 1.2;
        col = mix(col, cc, clamp(d * 1.05, 0.0, 0.96));
    }

    // ---- land beyond the lake ----
    float fr = farRidge(p.x);
    if (p.y > fr) {
        float sl = (farRidge(p.x + 0.012) - farRidge(p.x - 0.012)) / 0.024;
        vec3 rock = mix(mutedColor.rgb, bgColor.rgb, 0.4);
        col = shadeRange(p, fr, sl, 0.62, rock);
    }
    // Valley fog lies between the ranges.
    float haze = 0.12 + wxFog * 0.7 + (gIsDay ? smoothstep(0.18, 0.0, sunPhase) * 0.45 : 0.0);
    float fogBand = exp(-pow((p.y - (WL - 0.03)) / 0.035, 2.0))
                  * (0.45 + 0.9 * fbm3(vec2(p.x * 2.2 - time * 0.008, p.y * 18.0)));
    vec3 fogCol = mix(gSkyLow, fgColor.rgb, 0.25) * (0.45 + 0.55 * gDaylight) + gDusk * gTwilight * 0.3;
    col = mix(col, fogCol, clamp(fogBand * haze, 0.0, 0.85));

    float mr = midRidge(p.x);
    if (p.y > mr) {
        float sl = (midRidge(p.x + 0.012) - midRidge(p.x - 0.012)) / 0.024;
        vec3 rock = mix(mutedColor.rgb, bgColor.rgb, 0.65);
        col = shadeRange(p, mr, sl, 0.34, rock);
    }
    float fogBand2 = exp(-pow((p.y - (WL - 0.008)) / 0.018, 2.0))
                   * (0.5 + 0.8 * fbm3(vec2(p.x * 3.0 + time * 0.011, p.y * 30.0 + 4.0)));
    col = mix(col, fogCol, clamp(fogBand2 * haze * 1.1, 0.0, 0.85));

    float nr = nearRidge(p.x, p.y);
    if (p.y > nr) {
        vec3 forest = mix(bgColor.rgb * 0.45, mutedColor.rgb * 0.35, 0.3);
        forest = mix(forest, mix(fgColor.rgb, gSkyLow, 0.4) * 0.6, wxSnow * 0.55 + gCold * 0.25);
        col = mix(forest, mix(gSkyLow, gSkyTop, 0.25), 0.18);
    }

    // Distant rain shafts under the clouds.
    if (wxRain > 0.01) {
        float slant = 0.08 + wxWind * 0.5;
        float shafts = smoothstep(0.45, 0.8, fbm3(vec2((p.x + p.y * slant) * 2.4 + gDrift * 1.5, 0.5)));
        float span = smoothstep(-0.25, -0.05, p.y) * smoothstep(WL + 0.01, WL - 0.06, p.y);
        col = mix(col, mix(gSkyTop, gSkyLow, 0.5) * 0.8, shafts * span * wxRain * 0.55);
    }
    return col;
}

// --------------------------------------------------------------- foreground ---

// A big spruce: tiered, jagged, swaying at the top.
float spruce(vec2 p, float cx, float topY, float halfBase, float seed, out float tierTop) {
    tierTop = 0.0;
    if (p.y < topY) return 0.0;
    float H = 0.52 - topY;
    float u = (p.y - topY) / H;
    float tiers = 9.0 + hash1(seed) * 4.0;
    float tier = fract(u * tiers + hash1(seed * 3.0));
    float w = halfBase * pow(u, 0.9) * (0.62 + 0.38 * tier);
    w *= 0.82 + 0.36 * vnoise(vec2(p.y * 160.0, seed * 11.0));
    float sway = sin(time * (0.6 + wxWind * 1.2) + seed * 5.0) * (0.002 + wxWind * 0.010) * (1.0 - u);
    float dx = abs(p.x - cx - sway);
    float trunk = step(dx, 0.005) * step(0.9, u);
    // Branch tops: inside here, but open air a few pixels above.
    float uA = (p.y - 0.006 - topY) / H;
    float tierA = fract(uA * tiers + hash1(seed * 3.0));
    float wA = halfBase * pow(max(uA, 0.0), 0.9) * (0.62 + 0.38 * tierA)
             * (0.82 + 0.36 * vnoise(vec2((p.y - 0.006) * 160.0, seed * 11.0)));
    tierTop = step(dx, w) * (uA < 0.0 ? 1.0 : smoothstep(wA - 0.002, wA + 0.002, dx));
    return max(smoothstep(w + 0.0015, w - 0.0015, dx), trunk);
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;
    p.x *= aspect;
    gHalfW = aspect * 0.5;

    // ---- sun, moon, light ----
    gIsDay = sunPhase < 1.0;
    float dayFrac = clamp(sunPhase, 0.0, 1.0);
    float nightFrac = clamp(sunPhase - 1.0, 0.0, 1.0);
    float arcFrac = gIsDay ? dayFrac : nightFrac;
    float sunElev = gIsDay ? sin(PI * dayFrac) : -sin(PI * nightFrac);
    gDaylight = smoothstep(-0.06, 0.38, sunElev);
    gTwilight = exp(-abs(sunElev) * 5.5);
    gNight = 1.0 - gDaylight;
    gSideSign = gIsDay ? (dayFrac < 0.5 ? -1.0 : 1.0) : (nightFrac < 0.5 ? 1.0 : -1.0);
    gBody = vec2(mix(-gHalfW * 0.88, gHalfW * 0.88, arcFrac), WL - 0.02 - 0.72 * sin(PI * arcFrac));
    gBodyUp = sin(PI * arcFrac);

    gStorm = max(wxStorm, wxRain * 0.6);
    gCover = clamp(wxCloud, 0.0, 1.0);
    gGloom = clamp(wxCloud * 0.30 + gStorm * 0.45 + wxFog * 0.25, 0.0, 0.8);
    gDrift = time * (0.004 + wxWind * 0.035);
    gCold = clamp((6.0 - wxTemp) / 14.0, 0.0, 1.0);
    gAccHsv = rgb2hsv(accentColor.rgb);

    // ---- palette, all from the theme ----
    // Sky hue follows the accent; the pale horizon leans toward the text colour.
    vec3 dayTop = hsv2rgb(vec3(gAccHsv.x, clamp(gAccHsv.y * 1.0, 0.42, 0.82), 0.62));
    vec3 dayLow = mix(hsv2rgb(vec3(fract(gAccHsv.x - 0.03), clamp(gAccHsv.y * 0.5, 0.18, 0.45), 0.86)), fgColor.rgb, 0.22);
    vec3 nightTop = mix(bgColor.rgb * 0.30, hsv2rgb(vec3(gAccHsv.x, 0.65, 0.13)), 0.6);
    vec3 nightLow = mix(bgColor.rgb, mutedColor.rgb, 0.35) * 0.78;
    gSkyTop = mix(nightTop, dayTop, gDaylight);
    gSkyLow = mix(nightLow, dayLow, gDaylight);
    // Overcast: flatter, greyer, darker.
    vec3 greyTop = vec3(luma(gSkyTop)) * 0.8, greyLow = vec3(luma(gSkyLow)) * 0.85;
    gSkyTop = mix(gSkyTop, mix(greyTop, greyLow, 0.5), gGloom);
    gSkyLow = mix(gSkyLow, greyLow, gGloom * 0.8);

    // Sunset colour: the theme's own warmest tones (see warmScore).
    vec3 cA = accentColor.rgb, cB = urgentColor.rgb, cC = fgColor.rgb;
    float sA = warmScore(cA), sB = warmScore(cB), sC = warmScore(cC);
    vec3 best = sA >= sB && sA >= sC ? cA : (sB >= sC ? cB : cC);
    vec3 second = best == cA ? (sB >= sC ? cB : cC) : (best == cB ? (sA >= sC ? cA : cC) : (sA >= sB ? cA : cB));
    vec3 duskHsv = rgb2hsv(mix(best, second, 0.35));
    duskHsv.y = clamp(duskHsv.y * 1.45 + 0.08, 0.0, 1.0);
    duskHsv.z = clamp(duskHsv.z * 1.15, 0.0, 1.0);
    gDusk = hsv2rgb(duskHsv);
    gSunLight = mix(fgColor.rgb, gDusk, 0.25 + gTwilight * 0.6);
    gBodyCol = gIsDay ? mix(mix(fgColor.rgb, gDusk, 0.30), gDusk, gTwilight * 0.7)
                      : mix(fgColor.rgb, mutedColor.rgb, 0.18);

    // ---- storm ----
    gFlash = 0.0;
    gFlashX = 0.0;
    float boltSeed = 0.0;
    bool bolt = false;
    if (wxStorm > 0.01) {
        float period = 2.7;
        float seg = floor(time / period);
        boltSeed = seg;
        if (hash1(seg * 7.13) > 1.0 - 0.55 * wxStorm) {
            float t0 = seg * period + hash1(seg * 3.1) * 1.4;
            float dt = time - t0;
            if (dt > 0.0) {
                gFlash = exp(-dt * 11.0) + 0.55 * exp(-max(dt - 0.12, 0.0) * 14.0) * step(0.12, dt);
                bolt = hash1(seg * 9.7) > 0.45;
            }
        }
        gFlashX = mix(-gHalfW * 0.8, gHalfW * 0.8, hash1(seg * 5.7));
        // Keep bolts off the tree.
        if (abs(gFlashX) < 0.35) gFlashX = sign(gFlashX + 1e-3) * (0.35 + abs(gFlashX));
    }

    // ---- the lake and the shore ----
    float shoreY = 0.405 + 0.028 * fbm3(vec2(p.x * 1.3, 9.0)) + 0.018 * sin(p.x * 0.9 + 1.0);
    vec3 col;
    float dl = p.y - WL;

    if (dl <= 0.0) {
        col = skyAt(p, false);

        // Crepuscular rays: march toward the sun through the cloud deck.
        if (gIsDay && gBodyUp > 0.05 && gCover > 0.12 && gCover < 0.92) {
            vec2 stepV = (gBody - p) / 12.0;
            vec2 q = p;
            float acc = 0.0;
            for (int i = 0; i < 12; i++) {
                q += stepV;
                acc += 1.0 - cloudDensity(q, false);
            }
            float rays = pow(acc / 12.0, 3.0) * exp(-length(p - gBody) * 1.8);
            float strength = smoothstep(0.12, 0.35, gCover) * smoothstep(0.92, 0.6, gCover);
            col += gSunLight * rays * strength * 0.22 * (1.0 - wxFog * 0.6);
        }

        // Lightning bolt from cloud base to the far hills.
        if (bolt) {
            float y0 = -0.18, y1 = WL - 0.02;
            if (p.y > y0 && p.y < y1) {
                float bx = gFlashX + (fbm3(vec2(p.y * 5.0, boltSeed)) - 0.5) * 0.22
                         + (vnoise(vec2(p.y * 40.0, boltSeed + 3.0)) - 0.5) * 0.025;
                float dd = abs(p.x - bx);
                vec3 bc = mix(accentColor.rgb, fgColor.rgb, 0.6);
                col += bc * (exp(-dd / 0.0012) * 1.5 + exp(-dd / 0.02) * 0.25) * gFlash;
            }
        }
    } else if (p.y < shoreY) {
        // Ripples: a wave field on the water plane, seen in perspective,
        // choppier with wind and smoother in the distance.
        float z = 1.0 / (dl + 0.012);
        vec2 wv = vec2(p.x * z * 0.9, z * 2.2);
        float t = time * (0.35 + wxWind * 1.2);
        float rough = 0.25 + wxWind * 1.3 + wxRain * 0.6;
        float nx = fbm3(wv * vec2(1.0, 0.35) + vec2(t * 0.3, t)) - 0.5;
        float ny = fbm3(wv * vec2(0.8, 0.30) + vec2(-t * 0.2, t * 0.8 + 5.0)) - 0.5;
        vec2 ripple = vec2(nx * 0.010, ny * 0.006) * rough * (0.35 + dl * 9.0);

        // Rain rings on the surface.
        if (wxRain > 0.01) {
            vec2 rp = vec2(p.x * z * 3.0, z * 7.0);
            vec2 id = floor(rp);
            vec2 f = fract(rp) - 0.5;
            float h = hash21(id);
            if (h < wxRain * 0.8) {
                float ph = fract(time * 1.4 + h * 7.0);
                float ring = exp(-pow((length(f) - ph * 0.45) / 0.03, 2.0)) * (1.0 - ph);
                ripple += normalize(f + 1e-4) * ring * 0.004;
            }
        }

        vec2 pr = vec2(p.x, WL - dl) + ripple;
        vec3 refl = skyAt(pr, true);

        // The tree mirrored in the water.
        vec2 ruv = pr / ICON_SCALE + 0.5;
        if (ruv.x >= 0.0 && ruv.x <= 1.0 && ruv.y >= 0.0 && ruv.y <= 1.0) {
            float ra = texture(maskSource, ruv).a;
            refl = mix(refl, mix(bgColor.rgb * 0.2, gSkyLow * 0.3, 0.3), ra * 0.85);
        }

        vec3 deep = mix(bgColor.rgb * 0.35, gSkyTop * 0.25, 0.4);
        float fres = mix(0.92, 0.50, smoothstep(0.0, 0.13, dl));
        col = mix(deep, refl * 0.88, fres);

        // Glitter path under the sun or moon.
        if (gBodyUp > 0.0) {
            float w = 0.012 + dl * 0.9;
            float path = exp(-pow((p.x - gBody.x - ripple.x * 8.0) / w, 2.0));
            float spark = pow(vnoise(vec2(p.x * z * 5.0, z * 9.0 + time * 1.8)), 6.0) * 5.0;
            float bright = gIsDay ? 0.9 : 0.5 * (0.5 - 0.5 * cos(moonPhase * 2.0 * PI));
            col += gBodyCol * path * (0.25 + spark) * bright * (1.0 - gGloom * 0.8) * (0.3 + rough * 0.4);
        }
        // Lake mist on still mornings and fog.
        float mist = (0.10 + wxFog * 0.6 + (gIsDay ? smoothstep(0.18, 0.0, sunPhase) * 0.4 : 0.0))
                   * exp(-dl * 22.0) * (0.5 + fbm3(vec2(p.x * 3.0 - time * 0.02, dl * 50.0)));
        col = mix(col, mix(gSkyLow, fgColor.rgb, 0.25) * (0.5 + 0.5 * gDaylight), clamp(mist, 0.0, 0.7));
        col += mix(accentColor.rgb, fgColor.rgb, 0.4) * gFlash * 0.12 * fres;
    } else {
        col = vec3(0.0);   // shore, painted below
    }

    // ---- shore ----
    float ground = step(shoreY, p.y);
    // Grass: two layers of blades bending with the wind.
    float grass = 0.0;
    for (int layer = 0; layer < 2; layer++) {
        float dens = layer == 0 ? 190.0 : 320.0;
        float cell = floor(p.x * dens);
        float h = hash1(cell * 1.3 + float(layer) * 17.0);
        float bladeH = (layer == 0 ? 0.026 : 0.014) * (0.35 + h);
        float baseY = shoreY + (layer == 0 ? 0.004 : 0.0);
        float tt = (baseY - p.y) / bladeH;             // 0 root, 1 tip
        if (tt > 0.0 && tt < 1.0) {
            float lean = (0.25 + wxWind * 1.1) * (0.6 + 0.4 * sin(time * (1.3 + h) + p.x * 4.0 + h * 9.0));
            float cx = (cell + 0.5) / dens + lean * tt * tt * bladeH * 0.8;
            float wdt = (1.0 - tt) * 0.45 / dens;
            grass = max(grass, step(abs(p.x - cx), wdt));
        }
    }
    float shoreMask = max(ground, grass);
    if (shoreMask > 0.0) {
        vec3 soil = mix(bgColor.rgb * 0.30, mutedColor.rgb * 0.30, 0.35) + gSkyLow * 0.04;
        soil *= 0.8 + 0.4 * fbm3(p * vec2(40.0, 90.0));
        // Rim light from the sky on the top of the bank.
        float rim = exp(-(p.y - shoreY) * 90.0) * ground;
        soil += gSkyLow * rim * 0.25 + gDusk * gTwilight * rim * 0.2;
        float snowG = clamp(wxSnow * 1.2 + gCold * 0.3 - 0.15, 0.0, 1.0);
        soil = mix(soil, mix(fgColor.rgb, gSkyLow, 0.35) * (0.35 + 0.55 * gDaylight), snowG * ground * (0.7 + 0.3 * fbm3(p * 30.0)));
        col = mix(col, soil, shoreMask);
    }

    // ---- fireflies on warm, calm nights ----
    float warmNight = gNight * smoothstep(10.0, 16.0, wxTemp) * (1.0 - wxRain) * (1.0 - wxWind * 0.8);
    if (warmNight > 0.01 && p.y > WL - 0.05) {
        vec2 fq = p * vec2(9.0, 22.0) + vec2(time * 0.03, 0.0);
        vec2 fid = floor(fq);
        float fh = hash21(fid + 13.0);
        if (fh > 0.72) {
            vec2 pos = fid + 0.5 + vec2(sin(time * 0.5 + fh * 30.0), cos(time * 0.37 + fh * 17.0)) * 0.35;
            float d = length((fq - pos) * vec2(1.0, 22.0 / 9.0));
            float blink = pow(max(sin(time * (0.8 + fh) + fh * 40.0), 0.0), 8.0);
            vec3 ffc = hsv2rgb(vec3(fract(gAccHsv.x + 0.15), 0.7, 1.0));
            col += ffc * exp(-d * 18.0) * blink * warmNight * 0.9;
        }
    }

    // ---- birds on fair days ----
    float fair = gDaylight * (1.0 - wxRain) * (1.0 - gStorm) * (1.0 - wxFog);
    if (fair > 0.05 && p.y < WL) {
        float fl = floor(time / 80.0);
        float ph = fract(time / 80.0) / 0.45;
        if (ph < 1.0 && hash1(fl * 3.7) > 0.3) {
            float dir = hash1(fl * 1.9) > 0.5 ? 1.0 : -1.0;
            vec2 lead = vec2(dir * mix(-gHalfW - 0.25, gHalfW + 0.25, ph),
                             -0.30 + hash1(fl * 2.2) * 0.14 + sin(ph * 6.0) * 0.02);
            float birds = 0.0;
            for (int i = 0; i < 7; i++) {
                float fi = float(i);
                float k = abs(fi - 3.0);
                vec2 off = vec2(-dir * k * 0.030, k * 0.016 * (fi < 3.0 ? -1.0 : 1.0) * 0.6 + k * 0.004);
                off += vec2(sin(time * 0.7 + fi * 2.0), cos(time * 0.9 + fi)) * 0.004;
                vec2 b = lead + off;
                float flap = sin(time * 9.0 + fi * 1.7);
                vec2 wl = b + vec2(-0.014, -0.006 * flap - 0.002);
                vec2 wr = b + vec2(0.014, -0.006 * flap - 0.002);
                float d = min(segDist(p, b, wl), segDist(p, b, wr));
                birds = max(birds, smoothstep(0.0020, 0.0008, d));
            }
            col = mix(col, bgColor.rgb * 0.18, birds * fair * 0.85);
        }
    }

    // ---- precipitation behind the tree ----
    float slant = 2.0 + wxWind * 14.0;
    vec3 rainCol = mix(mutedColor.rgb, fgColor.rgb, 0.45) * (0.55 + 0.45 * gDaylight);
    vec3 snowCol = fgColor.rgb * 1.05;
    if (wxRain > 0.01) {
        vec2 q1 = vec2(p.x * 220.0 + p.y * slant, p.y * 24.0 - time * 7.0);
        vec2 q2 = vec2(p.x * 150.0 + p.y * slant * 1.2, p.y * 16.0 - time * 10.0);
        float r = 0.0;
        for (int k = 0; k < 2; k++) {
            vec2 q = k == 0 ? q1 : q2;
            vec2 id = floor(q);
            vec2 f = fract(q);
            float seed = k == 0 ? 0.0 : 31.0;
            if (hash21(id + seed) < (k == 0 ? 0.10 : 0.08) * wxRain) {
                float jitter = (hash21(id.yx + seed * 1.7) - 0.5) * 0.7;
                float across = smoothstep(k == 0 ? 0.05 : 0.07, 0.0, abs(f.x - 0.5 - jitter));
                float along = smoothstep(0.0, 0.12, f.y) * (1.0 - smoothstep(0.50, 0.95, f.y));
                r += across * along * (k == 0 ? 0.55 : 0.8);
            }
        }
        col += rainCol * r * (0.40 + gFlash * 0.5);
    }

    // ---- the tree ----
    vec2 iconUV = p / ICON_SCALE + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float edge = 0.0;
    float snowCap = 0.0;
    float litSide = 0.0;
    if (inIcon) {
        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        vec2 g = vec2(aR - aL, aD - aU);
        edge = clamp(length(g), 0.0, 1.0);
        // Edges facing the sun or moon catch more of it.
        vec2 toBody = normalize(gBody - p + vec2(1e-4));
        litSide = clamp(dot(normalize(-g + vec2(1e-5)), toBody), 0.0, 1.0);

        if (wxSnow > 0.01) {
            float st = 4.0 / 1024.0;
            float above = texture(maskSource, clamp(iconUV - vec2(0.0, st), 0.0, 1.0)).a;
            snowCap = smoothstep(0.25, 0.75, mask.a - above) * clamp(wxSnow * 1.4, 0.0, 1.0);
        }
    }
    vec3 silhouette = mix(bgColor.rgb * 0.20, gSkyLow * 0.40, 0.25);
    col = mix(col, silhouette, mask.a * 0.93);
    vec3 rimCol = mix(mix(mutedColor.rgb, fgColor.rgb, 0.4), gBodyCol, 0.35 + 0.4 * litSide)
                + gDusk * gTwilight * 0.45;
    rimCol += mix(accentColor.rgb, fgColor.rgb, 0.35) * gFlash * 0.8;
    col += rimCol * edge * (0.45 + 0.55 * litSide) * edgeGlowBrightness;
    col = mix(col, snowCol * (0.55 + 0.45 * gDaylight), snowCap * 0.9);

    // ---- framing spruces ----
    float tierA, tierB, tierC, tierD;
    float sA1 = spruce(p, -gHalfW + 0.10, -0.34, 0.20, 1.0, tierA);
    float sA2 = spruce(p, -gHalfW + 0.36, -0.06, 0.12, 2.0, tierB);
    float sB1 = spruce(p, gHalfW - 0.14, -0.40, 0.22, 3.0, tierC);
    float sB2 = spruce(p, gHalfW - 0.42, 0.02, 0.10, 4.0, tierD);
    float trees = max(max(sA1, sA2), max(sB1, sB2));
    if (trees > 0.0) {
        vec3 bark = mix(bgColor.rgb * 0.12, mutedColor.rgb * 0.10, 0.3);
        // Sky light on the needle tips.
        bark += gSkyLow * 0.05 + gDusk * gTwilight * 0.04;
        float tierTop = max(max(tierA * sA1, tierB * sA2), max(tierC * sB1, tierD * sB2));
        float snowT = clamp(wxSnow * 1.3 + gCold * 0.2 - 0.1, 0.0, 1.0);
        bark = mix(bark, mix(fgColor.rgb, gSkyLow, 0.4) * (0.35 + 0.5 * gDaylight), tierTop * snowT * 0.85);
        col = mix(col, bark, trees);
    }

    // ---- precipitation in front of everything ----
    if (wxRain > 0.01) {
        vec2 q = vec2(p.x * 90.0 + p.y * slant * 1.4, p.y * 10.0 - time * 13.0);
        vec2 id = floor(q);
        vec2 f = fract(q);
        if (hash21(id + 57.0) < 0.05 * wxRain) {
            float jitter = (hash21(id.yx + 97.0) - 0.5) * 0.7;
            float r = smoothstep(0.08, 0.0, abs(f.x - 0.5 - jitter))
                    * smoothstep(0.0, 0.12, f.y) * (1.0 - smoothstep(0.50, 0.95, f.y));
            col += rainCol * r * (0.22 + gFlash * 0.4);
        }
    }
    if (wxSnow > 0.01) {
        float windX = wxWind * 1.4;
        float s = 0.0;
        for (int layer = 0; layer < 3; layer++) {
            float scale = layer == 0 ? 40.0 : (layer == 1 ? 24.0 : 11.0);
            float fall = layer == 0 ? 1.0 : (layer == 1 ? 1.4 : 2.0);
            float size = layer == 0 ? 0.09 : (layer == 1 ? 0.11 : 0.16);
            float amount = (layer == 0 ? 0.16 : (layer == 1 ? 0.12 : 0.05)) * wxSnow;
            float seed = float(layer) * 19.0 + 5.0;
            vec2 q = p * scale;
            q.y -= time * fall;
            q.x -= time * windX * (1.0 + float(layer) * 0.3);
            vec2 base = floor(q);
            float best = 0.0;
            for (int oy = -1; oy <= 1; oy++) {
                for (int ox = -1; ox <= 1; ox++) {
                    vec2 cell = base + vec2(float(ox), float(oy));
                    float h = hash21(cell + seed);
                    if (h > amount) continue;
                    vec2 jit = vec2(hash21(cell + seed + 3.3), hash21(cell + seed + 7.7)) - 0.5;
                    vec2 sway = vec2(sin(time * (0.6 + h * 0.9) + h * 40.0) * 0.28, 0.0);
                    float d = length(q - (cell + 0.5 + jit * 0.7 + sway));
                    float sz = size * (0.6 + 0.4 * hash21(cell + seed + 11.0));
                    best = max(best, 1.0 - smoothstep(sz * 0.15, sz, d));
                }
            }
            s = max(s, best * (layer == 0 ? 0.45 : (layer == 1 ? 0.7 : 0.45)));
        }
        col = mix(col, snowCol, clamp(s, 0.0, 1.0) * 0.85);
    }

    // ---- fog over everything, thickest low ----
    float lowness = smoothstep(-0.35, WL + 0.06, p.y);
    float banks = smoothstep(0.30, 0.78, fbm3(vec2(p.x * 1.3 - time * 0.018, p.y * 6.0 + 1.7)));
    float fogAmt = clamp(wxFog * (0.30 + 0.75 * lowness) * (0.45 + 0.70 * banks), 0.0, 0.85);
    vec3 fogCol = mix(gSkyLow, mix(mutedColor.rgb, fgColor.rgb, 0.5), 0.5) * (0.7 + 0.35 * gDaylight);
    fogCol += gBodyCol * exp(-length(p - gBody) * 2.5) * 0.15;
    col = mix(col, fogCol, fogAmt * 0.85);

    // Global flash and a soft vignette.
    col += mix(accentColor.rgb, fgColor.rgb, 0.35) * gFlash * 0.05;
    vec2 vq = vec2(p.x / gHalfW, p.y * 2.0);
    col *= 1.0 - 0.22 * smoothstep(0.6, 1.4, length(vq));

    // Hue-preserving highlight rolloff.
    float peak = max(col.r, max(col.g, col.b));
    float knee = 0.82;
    if (peak > knee) col *= (knee + (peak - knee) / (1.0 + (peak - knee) * 2.2)) / peak;

    fragColor = vec4(max(col, vec3(0.0)), 1.0) * qt_Opacity;
}
