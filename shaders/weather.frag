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
//   shore    -- a meadow of particle blades bent by gusting wind, framed by
//               a birch and an oak whose leaves follow the season
//   season   -- the date turns grass and leaves from spring green through
//               autumn gold to winter bare; frost shrinks the grass away
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
    float season;      // fraction of the year, 0 = 1 January
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
// Season and wind, derived once in main().
float gLeaf, gAutumn, gSpring, gDry, gFallRate, gFlowers, gGrassAmt, gGrassH, gWindS, gWindDir;
vec3 gGrassCol, gFoliage;

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

// Crag relief: ridged noise whose octaves are each rotated, so no layer
// lines up with the screen axes and nothing reads as stripes.
float crag(vec2 q) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * (1.0 - abs(vnoise(q) * 2.0 - 1.0));
        q = mat2(1.6, 1.2, -1.2, 1.6) * q + vec2(3.1, 7.7);
        a *= 0.5;
    }
    return v;
}

// Height of the rock surface on a mountain face, domain-warped so buttresses
// and gullies wander instead of running in rulings.
float faceHeight(vec2 p, float seed) {
    vec2 w = vec2(fbm3(p * vec2(5.0, 9.0) + seed), fbm3(p * vec2(5.0, 9.0) + seed + 4.3)) - 0.5;
    return crag(vec2(p.x * 15.0, p.y * 24.0) + w * 1.7 + seed);
}

// One mountain range: rock lit through real surface normals, ledges, forest
// on the lower slopes, snow that reaches further down in the hollows, drifting
// cloud shadows, a rim of light along the crest when backlit, and the air in
// front of it all.
vec3 shadeRange(vec2 p, float ridgeY, float slope, float depth, vec3 rock, float seed) {
    vec3 air = mix(gSkyLow, gSkyTop, 0.25);
    float below = max(p.y - ridgeY, 0.0);
    float alt = WL - p.y;

    // Surface normal (x right, y up, z toward us): relief gradient plus the
    // crest's own slope right at the top, and faces lean back toward the sky.
    const float e = 0.0016;
    float h0 = faceHeight(p, seed);
    float hx = faceHeight(p + vec2(e, 0.0), seed);
    float hy = faceHeight(p + vec2(0.0, e), seed);
    const float k = 0.016;
    vec3 n = normalize(vec3(-(hx - h0) / e * k + slope * exp(-below * 45.0) * 0.9,
                            (hy - h0) / e * k + 0.30,
                            1.0));

    float sunStrength = gIsDay ? (0.25 + 0.75 * gDaylight) * (1.0 - gGloom * 0.75)
                               : 0.22 * (0.5 - 0.5 * cos(moonPhase * 2.0 * PI)) * (1.0 - gGloom * 0.8);
    vec3 L = normalize(vec3(gBody.x - p.x, p.y - gBody.y, 0.30));
    float direct = max(dot(n, L), 0.0) * sunStrength;
    float ambient = 0.40 + 0.30 * n.y;
    float ao = 0.62 + 0.38 * smoothstep(0.25, 0.8, h0);

    vec3 skyTint = mix(gSkyTop, gSkyLow, 0.5);
    vec3 c = rock * (skyTint * 1.6 * ambient + gSunLight * direct * 1.3) * ao;

    // Ledges: broken bands of strata, dark under a lit lip.
    float sb = fract(alt * 34.0 + (fbm3(p * vec2(9.0, 4.0) + seed) - 0.5) * 3.0 + (h0 - 0.5) * 1.5);
    float bandOn = smoothstep(0.55, 0.8, fbm3(p * vec2(14.0, 5.0) + seed)) * (1.0 - depth);
    c *= 1.0 - smoothstep(0.78, 1.0, sb) * bandOn * 0.30;
    c *= 1.0 + smoothstep(0.18, 0.0, sb) * bandOn * 0.15 * (0.3 + direct);
    // Fine grain.
    c *= 0.88 + 0.24 * fbm3(p * vec2(90.0, 140.0) + seed);

    // Forest on the lower slopes, thinning out upward.
    float treeAlt = 0.035 + 0.035 * fbm3(vec2(p.x * 3.0 + seed, 2.0)) - depth * 0.02;
    float forest = smoothstep(treeAlt + 0.004, treeAlt - 0.010, alt) * smoothstep(-0.2, 0.25, n.y);
    float crowns = smoothstep(0.3, 0.8, vnoise(p * vec2(520.0, 380.0) + seed));
    vec3 forestCol = mix(bgColor.rgb * 0.55, mix(mutedColor.rgb, accentColor.rgb, 0.35) * 0.6, 0.5);
    forestCol *= (0.55 + 0.45 * crowns) * (skyTint * 1.1 * ambient + gSunLight * direct * 0.9);
    c = mix(c, forestCol, forest * 0.9);

    // Snow: temperature sets the line; hollows and gentle faces hold it lower.
    float coldness = clamp(gCold + wxSnow * 0.8, 0.0, 1.0);
    float snowAlt = mix(0.30, 0.03, coldness) + (fbm3(vec2(p.x * 30.0, seed)) - 0.5) * 0.03
                  - (0.55 - h0) * 0.06 - n.y * 0.02;
    float snow = smoothstep(snowAlt, snowAlt + 0.010, alt) * step(0.02, gCold + wxSnow);
    vec3 snowCol = mix(fgColor.rgb, gSkyLow, 0.30) * (skyTint * 0.9 * ambient + gSunLight * direct * 1.4 + 0.12);
    c = mix(c, snowCol, snow * 0.95);

    // Shadows of passing clouds.
    if (gIsDay) {
        float cs = smoothstep(0.52, 0.72, fbm3(vec2(p.x * 1.3 - gDrift * 0.9, p.y * 3.0 + seed)));
        c *= 1.0 - cs * 0.45 * gDaylight * smoothstep(0.05, 0.3, gCover) * smoothstep(1.0, 0.75, gCover);
    }

    // Backlit crest: a thin rim of light where the sun or moon sits behind.
    float rim = exp(-below / 0.0016) * exp(-abs(p.x - gBody.x) * 1.4) * sunStrength;
    c += gSunLight * rim * 0.8;

    // Air: farther ranges and lower slopes sink into the haze.
    float hazeAmt = clamp(depth + (1.0 - exp(-below * 7.0)) * 0.14, 0.0, 0.95);
    return mix(c, air, hazeAmt);
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
        col = shadeRange(p, fr, sl, 0.60, rock, 1.0);
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
        col = shadeRange(p, mr, sl, 0.30, rock, 7.0);
    }
    float fogBand2 = exp(-pow((p.y - (WL - 0.008)) / 0.018, 2.0))
                   * (0.5 + 0.8 * fbm3(vec2(p.x * 3.0 + time * 0.011, p.y * 30.0 + 4.0)));
    col = mix(col, fogCol, clamp(fogBand2 * haze * 1.1, 0.0, 0.85));

    float nr = nearRidge(p.x, p.y);
    if (p.y > nr) {
        // A dark wall of forest: individual crowns, their tops catching sky.
        float crowns = vnoise(p * vec2(640.0, 420.0));
        float topLight = exp(-(p.y - nr) / 0.004);
        vec3 forest = mix(bgColor.rgb * 0.40, mix(mutedColor.rgb, accentColor.rgb, 0.3) * 0.40, 0.45);
        forest *= 0.65 + 0.55 * crowns;
        forest += gSkyLow * topLight * 0.10 + gSunLight * topLight * 0.10 * gDaylight * (1.0 - gGloom);
        forest = mix(forest, mix(fgColor.rgb, gSkyLow, 0.4) * 0.6 * (0.7 + 0.3 * crowns), wxSnow * 0.55 + gCold * 0.25);
        col = mix(forest, mix(gSkyLow, gSkyTop, 0.25), 0.16);
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

vec2 rot2(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Hue blend along the short way round the wheel.
float hueMix(float a, float b, float t) {
    float d = b - a;
    d -= floor(d + 0.5);
    return fract(a + d * t);
}

// A plant colour through the year: fresher and yellower in spring, turning
// toward `autumnHue` in autumn, cured to straw and brown when dead.
vec3 seasonTint(vec3 c, float autumnHue, float dead) {
    vec3 h = rgb2hsv(c);
    h.x = hueMix(h.x, 0.24, gSpring * 0.35);
    h.z *= 1.0 + gSpring * 0.25;
    h.x = hueMix(h.x, autumnHue, gAutumn);
    h.y = mix(h.y, max(h.y, 0.62), gAutumn * 0.8);
    h.z *= 1.0 + gAutumn * 0.15;
    h.x = hueMix(h.x, 0.09, dead);
    h.y = mix(h.y, 0.32, dead);
    h.z *= 1.0 - dead * 0.25;
    return hsv2rgb(clamp(h, 0.0, 1.0));
}

// Distance to a segment, with the position along it.
float segD(vec2 p, vec2 a, vec2 b, out float h) {
    vec2 pa = p - a, ba = b - a;
    h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    return length(pa - ba * h);
}

// How a tree leans: a steady push with the wind plus gust-driven rocking,
// growing with height (hN = 0 at the root, 1 at the crown).
float treeSway(float hN, float seed) {
    float gust = fbm3(vec2(time * (0.25 + 0.9 * gWindS), seed));
    float push = gWindDir * (0.003 + 0.100 * pow(gWindS, 1.5)) * (0.55 + 0.9 * gust);
    float rock = sin(time * (0.7 + 2.4 * gWindS) + seed * 3.0) * (0.002 + 0.012 * gWindS);
    return (push + rock) * hN * hN;
}

// Leaf particles: a grid of cells, each holding at most one small leaf with
// its own position, angle and flutter. `density` (0..1) is the chance a cell
// has a leaf; `shade` returns that leaf's random tone, `found` its coverage.
float leafDots(vec2 q, float cell, float density, float seed, out float shade) {
    shade = 0.0;
    if (density <= 0.0) return 0.0;
    vec2 g = q / cell;
    vec2 b = floor(g);
    float best = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
            vec2 c = b + vec2(float(ox), float(oy));
            float h = hash21(c + seed);
            if (h > density) continue;
            float hh = hash21(c + seed + 3.7);
            vec2 flutter = vec2(sin(time * (3.0 + 10.0 * gWindS) + hh * 30.0),
                                cos(time * (2.5 + 9.0 * gWindS) + hh * 17.0)) * (0.05 + 0.25 * gWindS);
            vec2 ctr = c + 0.5 + (vec2(hash21(c + seed + 1.1), hh) - 0.5) * 0.8 + flutter;
            float ang = hh * 6.2831 + sin(time * (2.0 + 6.0 * gWindS) + h * 20.0) * (0.2 + 0.8 * gWindS);
            vec2 lq = rot2(g - ctr, ang);
            float d = length(lq / vec2(0.62, 0.36));
            float m = smoothstep(1.0, 0.72, d);
            if (m > best) { best = m; shade = hash21(c + seed + 9.9); }
        }
    }
    return best;
}

vec2 bez(vec2 a, vec2 c, vec2 b, float t) {
    return mix(mix(a, c, t), mix(c, b, t), t);
}

// Silver birch: slender white trunk with dark lenticels; branches rise and
// arch over, and from them hang thin weeping twigs dressed in small leaves
// (bare in winter). Returns colour in rgb and coverage in a.
vec4 birch(vec2 p, float bx, float topY, float seed) {
    const float baseY = 0.56;
    float H = baseY - topY;
    float hN = (baseY - p.y) / H;
    if (hN < -0.05 || hN > 1.1 || abs(p.x - bx) > H * 0.52) return vec4(0.0);
    vec2 q = vec2(p.x - treeSway(clamp(hN, 0.0, 1.2), seed), p.y);

    vec3 skyAmb = mix(gSkyTop, gSkyLow, 0.5);
    float bodyStr = gIsDay ? gDaylight * (1.0 - gGloom * 0.7) : 0.25 * (1.0 - gGloom);
    vec3 L = normalize(vec3(gBody.x - p.x, p.y - gBody.y, 0.4));
    float snowFall = clamp(wxSnow * 1.3 + gCold * 0.2 - 0.1, 0.0, 1.0);

    vec3 col = vec3(0.0);
    float cov = 0.0;

    // Trunk.
    float tx = bx + 0.022 * sin(hN * 2.6 + seed) * hN;
    float tw = mix(0.020, 0.0022, pow(clamp(hN, 0.0, 1.0), 0.75));
    float dT = abs(q.x - tx);
    if (hN < 1.0 && dT < tw + 0.002) {
        float m = smoothstep(tw + 0.0012, tw - 0.0012, dT);
        float u = (q.x - tx) / tw;
        float round_ = sqrt(max(1.0 - u * u, 0.0));
        vec3 bark = mix(fgColor.rgb, mutedColor.rgb, 0.25) * 0.95;
        float dash = smoothstep(0.62, 0.72, vnoise(vec2(u * 2.5 + seed, q.y * 260.0)))
                   * smoothstep(0.3, 0.6, vnoise(vec2(u * 6.0, q.y * 40.0 + seed)));
        float base = smoothstep(0.30, 0.05, hN) * smoothstep(0.35, 0.75, vnoise(vec2(u * 5.0, q.y * 90.0)));
        bark = mix(bark, bgColor.rgb * 0.15, clamp(dash * 0.85 + base * 0.9, 0.0, 1.0));
        float lit = 0.45 + 0.55 * clamp(dot(normalize(vec3(u, 0.2, round_)), L), 0.0, 1.0) * bodyStr;
        col = bark * (skyAmb * 0.9 + gSunLight * lit * 0.6) * (0.55 + 0.45 * round_);
        cov = m;
    }

    // Branches (curved) and hanging twigs; track the nearest twig for leaves.
    float twigD = 1e3;
    float branchD = 1e3;
    float twigT = 0.0;
    vec2 twigRoot = vec2(0.0);
    for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float hh = hash1(seed * 7.0 + fi * 3.1);
        float h0 = mix(0.38, 1.0, (fi + hh * 0.9) / 12.0);
        float side = mod(fi, 2.0) < 0.5 ? -1.0 : 1.0;
        if (hash1(fi * 5.3 + seed) > 0.8) side = -side;
        vec2 a = vec2(bx + 0.022 * sin(h0 * 2.6 + seed) * h0, baseY - h0 * H);
        float len = H * (0.30 - 0.19 * h0) * (0.7 + 0.6 * hh);
        float rise = 0.35 + 0.5 * hash1(fi * 2.9 + seed);
        vec2 e = a + vec2(side * len * (0.7 + 0.3 * hh), len * (0.30 * hash1(fi + seed * 2.0) - 0.1));
        vec2 c = a + vec2(side * len * (0.2 + 0.25 * hh), -len * rise);
        // Wood, as four chords of the curve.
        float mb = 0.0;
        vec2 prev = a;
        for (int k = 1; k <= 4; k++) {
            float t = float(k) / 4.0;
            vec2 cur = bez(a, c, e, t);
            float tt;
            float d = segD(q, prev, cur, tt);
            float w = mix(0.0026, 0.0006, (float(k - 1) + tt) / 4.0) * (1.0 - h0 * 0.35);
            mb = max(mb, smoothstep(w + 0.0009, w - 0.0004, d));
            if (k >= 2) branchD = min(branchD, d);
            prev = cur;
        }
        if (mb > 0.0) {
            vec3 wood = mix(fgColor.rgb * 0.55, bgColor.rgb * 0.30, 0.45) * (skyAmb * 1.0 + gSunLight * bodyStr * 0.3);
            col = mix(col, wood, mb * (1.0 - cov) * (1.0 - gLeaf * 0.35));
            cov = max(cov, mb);
        }
        // Weeping twigs off the outer half of the branch.
        for (int k = 0; k < 6; k++) {
            float fk = float(k);
            float tr = 0.25 + fk * 0.14;
            vec2 root = bez(a, c, e, tr);
            float tl = len * (0.45 + 0.45 * hash1(fi * 9.0 + fk + seed)) * (1.0 - gWindS * 0.25);
            float swing = gWindDir * gWindS * tl * 0.9 + sin(time * (1.5 + 4.0 * gWindS) + fi + fk * 2.0) * tl * (0.04 + 0.2 * gWindS);
            vec2 mid = root + vec2(side * tl * 0.10 + swing * 0.4, tl * 0.5);
            vec2 tip = root + vec2(side * tl * 0.05 + swing, tl);
            float t1, t2;
            float d1 = segD(q, root, mid, t1);
            float d2 = segD(q, mid, tip, t2);
            float d = min(d1, d2);
            float tAlong = d1 < d2 ? t1 * 0.5 : 0.5 + t2 * 0.5;
            if (d < twigD) { twigD = d; twigT = tAlong; twigRoot = root; }
            float twig = smoothstep(0.0010, 0.0003, d) * (1.0 - gLeaf * 0.7);
            if (twig > 0.0) {
                vec3 tc = mix(fgColor.rgb * 0.35, bgColor.rgb * 0.3, 0.5) * skyAmb * 1.2;
                tc = mix(tc, mix(fgColor.rgb, gSkyLow, 0.3) * 0.7, snowFall * 0.5);
                col = mix(col, tc, twig * (1.0 - cov));
                cov = max(cov, twig);
            }
        }
    }

    // Leaves: small particles strung along the twigs, airy at the edges.
    if (gLeaf > 0.01) {
        float env = max(smoothstep(0.019, 0.003, twigD) * smoothstep(0.0, 0.10, twigT),
                        smoothstep(0.012, 0.002, branchD) * 0.9);
        float shade;
        float lm = leafDots(q, 0.0055, gLeaf * env * 0.95, seed * 3.1, shade);
        if (lm > 0.0) {
            vec3 fol = seasonTint(gFoliage * (0.75 + 0.5 * shade), 0.135, 0.0);
            // Some leaves turn earlier than others.
            fol = mix(fol, seasonTint(gFoliage, 0.12, 0.35), step(0.8, shade) * gAutumn);
            float lit = 0.55 + 0.6 * bodyStr * (0.5 + 0.5 * sign(gBody.x - twigRoot.x) * sign(q.x - twigRoot.x));
            vec3 lc = fol * (skyAmb * 1.1 + gSunLight * lit * 0.7) * (0.8 + 0.3 * (1.0 - twigT));
            col = mix(col, lc, lm);
            cov = max(cov, lm);
        }
    }
    return vec4(col, cov);
}

// Oak: a thick, furrowed trunk that forks into crooked limbs under a broad,
// lumpy crown. The crown thins and turns rust in autumn; bare limbs in winter.
vec4 oak(vec2 p, float bx, float seed) {
    const float baseY = 0.56;
    const float crownY = -0.14;
    float H = baseY - crownY;
    float hN = (baseY - p.y) / H;
    if (hN < -0.05 || hN > 1.75 || abs(p.x - bx) > 0.62) return vec4(0.0);
    vec2 q = vec2(p.x - treeSway(clamp(hN, 0.0, 1.6), seed) * 0.6, p.y);

    vec3 skyAmb = mix(gSkyTop, gSkyLow, 0.5);
    float bodyStr = gIsDay ? gDaylight * (1.0 - gGloom * 0.7) : 0.25 * (1.0 - gGloom);
    vec3 L = normalize(vec3(gBody.x - p.x, p.y - gBody.y, 0.4));
    vec3 barkBase = mix(bgColor.rgb, mutedColor.rgb, 0.35) * 0.45;

    vec3 col = vec3(0.0);
    float cov = 0.0;

    // Trunk: wide at the flare, gnarled.
    float trunkTop = 0.08;
    if (q.y > trunkTop - 0.02) {
        float tN = clamp((baseY - q.y) / (baseY - trunkTop), 0.0, 1.0);
        float tx = bx + (fbm3(vec2(q.y * 6.0, seed)) - 0.5) * 0.03;
        float tw = mix(0.060, 0.032, pow(tN, 0.6)) * (0.92 + 0.16 * vnoise(vec2(q.y * 30.0, seed)));
        float dT = abs(q.x - tx);
        float m = smoothstep(tw + 0.0015, tw - 0.0015, dT);
        if (m > 0.0) {
            float u = (q.x - tx) / tw;
            float round_ = sqrt(max(1.0 - u * u, 0.0));
            float furrow = vnoise(vec2(u * 9.0 + seed, q.y * 22.0)) * 0.6 + vnoise(vec2(u * 22.0, q.y * 60.0)) * 0.4;
            vec3 bark = barkBase * (0.55 + 0.7 * furrow);
            float lit = clamp(dot(normalize(vec3(u, 0.1, round_)), L), 0.0, 1.0) * bodyStr;
            col = bark * (skyAmb * 0.8 + gSunLight * lit * 0.9) * (0.5 + 0.5 * round_);
            cov = m;
        }
    }

    // Limbs: crooked, two bends each, spreading wide.
    float snowFall = clamp(wxSnow * 1.3 + gCold * 0.2 - 0.1, 0.0, 1.0);
    for (int i = 0; i < 8; i++) {
        float fi = float(i);
        float hh = hash1(seed * 5.0 + fi * 2.7);
        float ang = mix(-2.75, -0.39, (fi + 0.5) / 8.0) + (hh - 0.5) * 0.3;   // upward fan
        vec2 dir = vec2(cos(ang), sin(ang));
        vec2 a = vec2(bx + (hh - 0.5) * 0.03, trunkTop + 0.02 - hh * 0.05);
        float len = 0.16 + 0.12 * hash1(fi * 4.1 + seed);
        vec2 b = a + rot2(dir, (hh - 0.5) * 0.6) * len * 0.45;
        vec2 c = b + rot2(dir, (hash1(fi + seed) - 0.5) * 0.9) * len * 0.35;
        vec2 e = c + rot2(dir, (hash1(fi * 2.0 + seed) - 0.5) * 1.1 - 0.2 * sign(dir.x)) * len * 0.30;
        float t1, t2, t3;
        float d1 = segD(q, a, b, t1), d2 = segD(q, b, c, t2), d3 = segD(q, c, e, t3);
        float w1 = mix(0.020, 0.012, t1), w2 = mix(0.012, 0.006, t2), w3 = mix(0.006, 0.0018, t3);
        float mb = max(max(smoothstep(w1 + 0.0012, w1 - 0.0008, d1), smoothstep(w2 + 0.0012, w2 - 0.0006, d2)),
                       smoothstep(w3 + 0.0010, w3 - 0.0004, d3));
        if (mb > 0.0) {
            float furrow = vnoise(q * vec2(90.0, 120.0) + fi);
            vec3 wood = barkBase * (0.6 + 0.5 * furrow) * (skyAmb * 0.9 + gSunLight * bodyStr * 0.35);
            vec2 pa = d1 < d2 ? mix(a, b, t1) : (d2 < d3 ? mix(b, c, t2) : mix(c, e, t3));
            wood = mix(wood, mix(fgColor.rgb, gSkyLow, 0.3) * (0.5 + 0.4 * gDaylight), snowFall * step(q.y, pa.y - 0.001) * 0.9);
            col = mix(col, wood, mb * (1.0 - cov * 0.0));
            cov = max(cov, mb);
        }
        // Sub-branches off each limb, each ending in a spray of twigs.
        for (int k = 0; k < 3; k++) {
            float fk = float(k);
            vec2 s0 = k == 0 ? mix(a, b, 0.7) : (k == 1 ? mix(b, c, 0.6) : mix(c, e, 0.5));
            float sa = ang + (hash1(fi * 7.1 + fk * 3.3 + seed) - 0.5) * 1.8 + (fk - 1.0) * 0.4;
            float sl = len * (0.30 + 0.25 * hash1(fi * 5.7 + fk + seed));
            vec2 s1 = s0 + vec2(cos(sa), sin(sa)) * sl * 0.55;
            vec2 s2 = s1 + rot2(vec2(cos(sa), sin(sa)), (hash1(fi + fk * 9.0 + seed) - 0.5) * 1.2) * sl * 0.45;
            float u1, u2;
            float e1 = segD(q, s0, s1, u1), e2 = segD(q, s1, s2, u2);
            float sw1 = mix(0.0055, 0.0030, u1), sw2 = mix(0.0030, 0.0012, u2);
            float ms = max(smoothstep(sw1 + 0.001, sw1 - 0.0005, e1), smoothstep(sw2 + 0.0009, sw2 - 0.0004, e2));
            if (gLeaf < 0.6) {
                for (int m = 0; m < 3; m++) {
                    float fm = float(m);
                    vec2 w0 = mix(s1, s2, 0.3 + fm * 0.35);
                    vec2 w1 = w0 + rot2(vec2(cos(sa), sin(sa)), (hash1(fi * 3.0 + fk * 5.0 + fm + seed) - 0.5) * 2.0) * 0.035;
                    float uu;
                    float ed = segD(q, w0, w1, uu);
                    ms = max(ms, smoothstep(0.0011, 0.0003, ed) * (1.0 - gLeaf * 1.6));
                }
            }
            if (ms > 0.0) {
                vec3 wood = barkBase * (0.7 + 0.4 * vnoise(q * 140.0 + fk)) * (skyAmb * 0.95 + gSunLight * bodyStr * 0.3);
                wood = mix(wood, mix(fgColor.rgb, gSkyLow, 0.3) * (0.5 + 0.4 * gDaylight), snowFall * step(q.y, mix(s0, s2, 0.5).y) * 0.5);
                col = mix(col, wood, ms);
                cov = max(cov, ms);
            }
        }
        // Winter twigs off each limb end.
        if (gLeaf < 0.5) {
            for (int k = 0; k < 3; k++) {
                float fk = float(k);
                vec2 tw0 = mix(c, e, 0.3 + fk * 0.3);
                vec2 tw1 = tw0 + rot2(dir, (hash1(fi * 3.0 + fk + seed) - 0.5) * 1.6) * 0.05;
                float tt;
                float dd = segD(q, tw0, tw1, tt);
                float twig = smoothstep(0.0012, 0.0003, dd) * (1.0 - gLeaf * 2.0);
                col = mix(col, barkBase * skyAmb * 0.9, twig * (1.0 - cov));
                cov = max(cov, twig);
            }
        }
    }

    // Crown: one lumpy mass (a soft union of clumps), solid inside and
    // breaking into leaf particles at its edge. Shaded as a whole, with the
    // lumps adding local relief.
    if (gLeaf > 0.01) {
        float field = 0.0;
        vec2 grad = vec2(0.0);
        for (int i = 0; i < 30; i++) {
            float fi = float(i);
            vec2 cp;
            if (i < 8) {
                float hh = hash1(seed * 5.0 + fi * 2.7);
                float ang = mix(-2.75, -0.39, (fi + 0.5) / 8.0) + (hh - 0.5) * 0.3;
                float len = 0.16 + 0.12 * hash1(fi * 4.1 + seed);
                cp = vec2(bx, trunkTop) + vec2(cos(ang), sin(ang)) * len * 0.95;
            } else {
                float r1 = hash1(fi * 1.7 + seed), r2 = hash1(fi * 3.9 + seed);
                float an = r1 * 6.2831;
                cp = vec2(bx, crownY + 0.03) + vec2(cos(an) * 0.29, sin(an) * 0.16) * sqrt(r2);
            }
            float rr = (0.060 + 0.035 * hash1(fi * 6.1 + seed)) * (0.7 + 0.3 * gLeaf);
            vec2 dq = (q - cp) * vec2(1.0, 1.15);
            float k = exp(-dot(dq, dq) / (rr * rr));
            field += k;
            grad += k * dq / (rr * rr);
        }
        // Lumpy boundary: a threshold on the summed field, broken by noise.
        float edgeN = (fbm3(q * 22.0 + seed) - 0.5) * 0.7 + (fbm3(q * 70.0 + seed * 2.0) - 0.5) * 0.35;
        float level = field + edgeN;
        // Sky gaps through the crown where the foliage is thinnest.
        float holes = smoothstep(0.30, 0.50, fbm3(q * 16.0 + seed * 4.0) + (field - 1.0) * 0.25);
        float inner = smoothstep(0.55, 0.9, level) * holes;
        float halo = smoothstep(0.20, 0.55, level);
        float shade;
        float dots = leafDots(q, 0.0075, gLeaf * halo, seed * 1.7, shade);
        float thin = 1.0 - gLeaf;                         // autumn: see through it
        float mass = max(inner * (1.0 - thin * 0.9) * smoothstep(0.35, 0.6, vnoise(q * 160.0 + seed) + gLeaf * 0.6), dots);
        if (mass > 0.0) {
            // Crown-scale shape plus the relief of individual leaf clusters.
            vec2 cq = q * 38.0 + seed;
            float c0 = fbm3(cq);
            vec2 cg = vec2(fbm3(cq + vec2(0.05, 0.0)) - c0, fbm3(cq + vec2(0.0, 0.05)) - c0) / 0.05;
            vec3 n = normalize(vec3(-grad.x * 0.02 - cg.x * 0.9, grad.y * 0.02 + cg.y * 0.9, 1.0));
            float lit = clamp(dot(n, L), 0.0, 1.0) * bodyStr;
            float cy = clamp((q.y - crownY) / 0.18, -1.0, 1.0);
            float under = smoothstep(-0.2, 1.0, cy);
            vec3 fol = seasonTint(gFoliage * (0.75 + 0.45 * shade), 0.07, 0.0);
            fol = mix(fol, seasonTint(gFoliage, 0.10, 0.4), step(0.75, shade) * gAutumn);
            float depthShade = mix(0.72, 1.0, dots) * (0.78 + 0.35 * smoothstep(0.3, 0.7, c0));          // the solid core sits behind the edge leaves
            vec3 fc = fol * (skyAmb * (1.0 - under * 0.40) * 1.45 + gSunLight * lit * 1.0) * depthShade;
            col = mix(col, fc, mass);
            cov = max(cov, mass);
        }
    }
    return vec4(col, cov);
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
    gDrift = time * (0.004 + pow(wxWind, 1.2) * 0.08);
    gCold = clamp((6.0 - wxTemp) / 14.0, 0.0, 1.0);
    gAccHsv = rgb2hsv(accentColor.rgb);

    // ---- season and wind ----
    float sN = fract(season);
    gSpring = smoothstep(0.25, 0.33, sN) * (1.0 - smoothstep(0.42, 0.50, sN));
    gLeaf = smoothstep(0.30, 0.42, sN) * (1.0 - smoothstep(0.80, 0.905, sN));
    gAutumn = smoothstep(0.66, 0.80, sN) * (1.0 - smoothstep(0.93, 0.98, sN));
    gFallRate = smoothstep(0.72, 0.80, sN) * (1.0 - smoothstep(0.87, 0.92, sN));
    gDry = max(smoothstep(0.68, 0.88, sN), 1.0 - smoothstep(0.22, 0.33, sN));
    gFlowers = smoothstep(0.36, 0.42, sN) * (1.0 - smoothstep(0.62, 0.70, sN)) * smoothstep(6.0, 12.0, wxTemp);
    // Grass shrinks and browns with frost and is gone by -15.
    gGrassAmt = smoothstep(-15.0, -6.0, wxTemp);
    gGrassH = mix(0.35, 1.0, smoothstep(-15.0, 3.0, wxTemp)) * (1.0 - clamp(wxSnow * 1.1, 0.0, 1.0) * 0.7);
    gDry = max(gDry, 1.0 - smoothstep(-8.0, 2.0, wxTemp));
    gWindS = pow(clamp(wxWind, 0.0, 1.0), 0.8);
    gWindDir = 1.0;
    // Plants lean on the theme, with a share of natural green so they read as
    // plants on any palette.
    vec3 natural = vec3(0.30, 0.42, 0.20);
    gGrassCol = mix(mix(mutedColor.rgb, accentColor.rgb, 0.55), natural * (0.6 + luma(accentColor.rgb)), 0.30);
    gFoliage = mix(mix(accentColor.rgb, mutedColor.rgb, 0.25), natural * (0.6 + luma(accentColor.rgb)), 0.35);

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
            // Shafts are seen against the sky; the ranges stand in front of them.
            float land = min(farRidge(p.x), midRidge(p.x));
            strength *= 0.15 + 0.85 * smoothstep(land + 0.004, land - 0.004, p.y);
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
        float rough = 0.25 + gWindS * 2.2 + wxRain * 0.6;
        float nx = fbm3(wv * vec2(1.0, 0.35) + vec2(t * 0.3, t)) - 0.5;
        float ny = fbm3(wv * vec2(0.8, 0.30) + vec2(-t * 0.2, t * 0.8 + 5.0)) - 0.5;
        vec2 ripple = vec2(nx * 0.010, ny * 0.006) * rough * (0.35 + dl * 9.0);
        // A hard wind chops the whole surface: short, steep wind waves that
        // shatter the reflection, even far out.
        if (gWindS > 0.3) {
            vec2 cw = vec2(p.x * z * 2.6 - time * 1.4 * gWindDir, z * 7.0 + time * 0.5);
            vec2 chop = vec2(fbm3(cw), fbm3(cw + vec2(5.2, 1.3))) - 0.5;
            ripple += chop * vec2(0.020, 0.030) * smoothstep(0.3, 1.0, gWindS) * (0.6 + dl * 6.0);
        }

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
        // Whitecaps when it blows hard: breaking crests streaked by the wind.
        if (gWindS > 0.35) {
            vec2 cq = vec2(p.x * z * 2.2 - time * 0.9 * gWindDir, z * 5.0 + time * 0.3);
            float crest = smoothstep(0.72, 0.9, fbm3(cq + vec2(0.0, fbm3(cq * 0.5) * 0.8)));
            float caps = crest * smoothstep(0.35, 0.9, gWindS) * smoothstep(0.0, 0.06, dl);
            col = mix(col, mix(fgColor.rgb, gSkyLow, 0.4) * (0.5 + 0.5 * gDaylight), caps * 0.55);
        }
        // Lake mist on still mornings and fog.
        float mist = (0.10 + wxFog * 0.6 + (gIsDay ? smoothstep(0.18, 0.0, sunPhase) * 0.4 : 0.0))
                   * exp(-dl * 22.0) * (0.5 + fbm3(vec2(p.x * 3.0 - time * 0.02, dl * 50.0)));
        col = mix(col, mix(gSkyLow, fgColor.rgb, 0.25) * (0.5 + 0.5 * gDaylight), clamp(mist, 0.0, 0.7));
        col += mix(accentColor.rgb, fgColor.rgb, 0.4) * gFlash * 0.12 * fres;
    } else {
        col = vec3(0.0);   // shore, painted below
    }

    // ---- the meadow: every blade a particle on the ground plane ----
    // Blades are scattered in world space (x along the shore, depth z) and
    // projected: y = WL + CAM_H / z. Each has its own jittered depth, height,
    // shade and a curved spine bent by the local wind, so there are no rows
    // or outlines. Rows rooted below the frame give tall, out-of-focus blades
    // across the bottom.
    if (p.y > shoreY - 0.16) {
        const float CAM_H = 0.03;
        const float BLADE_H = 0.0050;
        const float CELL_W = 0.00072;
        const int ROWS = 36;
        float invFar = (shoreY - WL) / CAM_H;
        float invNear = (0.53 - WL) / CAM_H;
        float invMax = invNear * 2.4;
        float rowStep = (invMax - invFar) / float(ROWS - 1);
        vec3 airCol = mix(gSkyLow, gSkyTop, 0.3);
        vec3 skyAmb = mix(gSkyTop, gSkyLow, 0.5);
        float bodyStr = gIsDay ? gDaylight * (1.0 - gGloom * 0.7) : 0.2 * (1.0 - gGloom);
        float backlight = gTwilight * (1.0 - gGloom) + (gIsDay ? 0.25 * gDaylight : 0.0);
        float snowG = clamp(wxSnow * 1.2 + gCold * 0.3 - 0.15, 0.0, 1.0);
        float frost = smoothstep(0.0, -6.0, wxTemp) * (1.0 - snowG);
        float pix = 1.0 / 1440.0;

        // Ground under the grass: sod in summer, litter in autumn, frost, snow.
        if (p.y >= shoreY) {
            float invZ = (p.y - WL) / CAM_H;
            vec3 sod = seasonTint(gGrassCol, 0.10, gDry) * 0.30;
            sod *= 0.7 + 0.6 * fbm3(vec2(p.x / invZ * 900.0, invZ * 3.0));
            sod *= skyAmb * 1.2 + gSunLight * bodyStr * 0.4;
            sod = mix(sod, mix(fgColor.rgb, gSkyLow, 0.4) * 0.6, frost * 0.5);
            sod = mix(sod, mix(fgColor.rgb, gSkyLow, 0.35) * (0.35 + 0.55 * gDaylight) * (0.85 + 0.15 * fbm3(p * 40.0)), snowG);
            float haze = smoothstep(invFar * 1.8, invFar, invZ) * 0.3;
            col = mix(sod, airCol * 0.5, haze);
        }

        if (gGrassAmt > 0.01) {
            for (int r = 0; r < ROWS; r++) {
                float rowInv = invFar + float(r) * rowStep;
                float rowY = WL + CAM_H * rowInv;
                float hbMax = BLADE_H * rowInv * 1.6 * gGrassH;
                if (p.y > rowY + CAM_H * rowStep * 0.6 || p.y < rowY - hbMax) continue;
                float X = p.x / rowInv;
                float c0 = floor(X / CELL_W);
                for (int k = -3; k <= 3; k++) {
                    float cell = c0 + float(k);
                    float seedB = cell * 1.37 + float(r) * 57.13;
                    float h = hash1(seedB);
                    // Clumps and bare patches, and fewer blades in the cold.
                    float clump = vnoise(vec2(cell * 0.045, float(r) * 0.7));
                    if (h > (0.35 + 0.75 * clump) * gGrassAmt) continue;
                    float inv = rowInv + (hash1(seedB + 1.9) - 0.5) * rowStep;
                    float rootX = (cell + hash1(seedB + 5.3)) * CELL_W;
                    float rx = rootX * inv;
                    float ry = WL + CAM_H * inv;
                    float hb = BLADE_H * inv * (0.45 + 0.9 * hash1(seedB + 2.1)) * (0.55 + 0.7 * clump) * gGrassH;
                    // Wind: gust fronts roll across in world space; strong wind
                    // lays the blades over and makes them thrash.
                    float gust = fbm3(vec2(rootX * 5.0 - time * (0.35 + 2.2 * gWindS), inv * 0.35));
                    float lean = gWindDir * (0.08 + 1.35 * gWindS * (0.35 + 1.0 * gust))
                               + (h - 0.5) * 0.45
                               + sin(time * (1.4 + 9.0 * gWindS) + seedB * 6.0) * (0.03 + 0.16 * gWindS);
                    lean = clamp(lean, -1.4, 1.4);
                    float vy = hb * max(1.0 - 0.38 * lean * lean, 0.28);
                    float t = (ry - p.y) / vy;
                    if (t < 0.0 || t > 1.0) continue;
                    float cx = rx + lean * hb * 0.18;
                    float tx = rx + lean * hb * 0.95;
                    float bx = (1.0 - t) * (1.0 - t) * rx + 2.0 * (1.0 - t) * t * cx + t * t * tx;
                    float dxdt = 2.0 * (1.0 - t) * (cx - rx) + 2.0 * t * (tx - cx);
                    float slope = dxdt / vy;
                    float d = abs(p.x - bx) / sqrt(1.0 + slope * slope);
                    float w = 0.00045 * inv * pow(1.0 - t, 0.85);
                    float blur = max(inv - invNear * 0.95, 0.0) * 0.00018;
                    float aa = pix * 0.8 + blur;
                    float m = smoothstep(w + aa, max(w - aa * 0.3, 0.0), d) * clamp(w * 2.5 / aa + 0.35, 0.0, 1.0);
                    if (m <= 0.0) continue;

                    // Colour: each blade its own shade; some already turned or dead.
                    float ownDry = clamp(gDry + (hash1(seedB + 4.4) - 0.6) * 0.5 * (gDry + gAutumn), 0.0, 1.0);
                    vec3 base = gGrassCol * (0.55 + 0.6 * hash1(seedB + 3.3));
                    vec3 bh3 = rgb2hsv(base);
                    bh3.x = hueMix(bh3.x, bh3.x + (hash1(seedB + 7.7) - 0.5) * 0.08, 1.0);
                    vec3 bc = seasonTint(hsv2rgb(bh3), 0.11, ownDry);
                    bc = mix(bc * 0.25, bc, t);                         // dark at the root
                    bc *= 0.85 + 0.25 * smoothstep(w, 0.0, d);          // lighter spine
                    bc *= skyAmb * 1.3 + gSunLight * bodyStr * 0.7;
                    bc += gSunLight * bc * backlight * t * t * 1.4;     // low sun through the tips
                    // Laid-over blades show their pale undersides: gusts read as sheen.
                    bc += mix(fgColor.rgb, skyAmb, 0.5) * smoothstep(0.45, 1.2, abs(lean)) * t * 0.22 * (0.4 + gDaylight);
                    bc = mix(bc, mix(fgColor.rgb, gSkyLow, 0.35) * (0.45 + 0.5 * gDaylight), (snowG * 0.8 + frost * 0.6) * smoothstep(0.35, 1.0, t));
                    float haze = smoothstep(invFar * 1.8, invFar, inv) * 0.3;
                    bc = mix(bc, airCol * 0.55, haze);
                    col = mix(col, bc, m);

                    // Flowers on some blades in late spring and summer.
                    if (gFlowers > 0.01 && hash1(seedB + 8.8) > 1.0 - 0.035 * gFlowers) {
                        float r0 = 0.0011 * inv;
                        vec2 dq = vec2(p.x - tx, (p.y - (ry - vy)) * 1.3);
                        float an = atan(dq.y, dq.x);
                        float pet = r0 * (0.75 + 0.25 * cos(an * 5.0 + seedB));
                        float fd = length(dq);
                        vec3 fcol = hsv2rgb(vec3(fract(gAccHsv.x + (hash1(seedB * 9.1) - 0.5) * 0.45 + 0.5), 0.40, 0.85))
                                  * (skyAmb * 1.2 + gSunLight * bodyStr * 0.6);
                        fcol = mix(fcol, fcol * 0.35, smoothstep(r0 * 0.35, 0.0, fd));
                        col = mix(col, mix(fcol, airCol * 0.55, haze), smoothstep(pet + aa, pet - aa * 0.5, fd));
                    }
                }
            }
        }

        // Hoarfrost glints on the bare, frozen meadow.
        if (frost > 0.01 && p.y > shoreY) {
            vec2 gq = p * vec2(420.0, 900.0);
            float g = pow(vnoise(gq), 22.0) * 3.0;
            col += fgColor.rgb * g * frost * (0.3 + 0.7 * gDaylight);
        }
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
    float slant = 2.0 + gWindS * 30.0;
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

    // ---- framing trees: birch on the left, oak on the right ----
    vec4 tB = birch(p, -gHalfW + 0.20, -0.44, 1.0);
    col = mix(col, tB.rgb, tB.a);
    vec4 tB2 = birch(p, -gHalfW + 0.46, -0.16, 5.0);
    col = mix(col, tB2.rgb, tB2.a * (1.0 - tB.a));
    vec4 tO = oak(p, gHalfW - 0.44, 3.0);
    col = mix(col, tO.rgb, tO.a);

    // ---- leaves in the air ----
    // Falling in autumn, torn off and blown sideways in a strong wind.
    float airLeaves = gFallRate * (0.25 + 0.9 * gWindS) + pow(gWindS, 2.0) * 0.35 * gLeaf;
    if (airLeaves > 0.005) {
        for (int layer = 0; layer < 3; layer++) {
            float fl = float(layer);
            float scale = layer == 0 ? 34.0 : (layer == 1 ? 20.0 : 10.0);
            vec2 q = p * scale;
            float drift = time * (0.25 + 4.5 * gWindS) * gWindDir * (0.8 + fl * 0.35);
            float fall = time * (0.45 + fl * 0.2) * (1.0 - 0.55 * gWindS);
            q += vec2(-drift, -fall);
            vec2 base = floor(q);
            for (int oy = -1; oy <= 1; oy++) {
                for (int ox = -1; ox <= 1; ox++) {
                    vec2 cell = base + vec2(float(ox), float(oy));
                    float h = hash21(cell + 17.0 + fl * 7.0);
                    if (h > airLeaves * (0.18 - fl * 0.04)) continue;
                    vec2 ctr = cell + 0.5 + (vec2(hash21(cell + 3.3), hash21(cell + 7.7)) - 0.5) * 0.7
                             + vec2(sin(time * (1.2 + h * 3.0) + h * 40.0) * 0.35, cos(time * (0.9 + h * 2.0) + h * 20.0) * 0.2);
                    vec2 lq = rot2(q - ctr, time * (1.5 + 4.0 * h + 3.0 * gWindS) + h * 6.0);
                    float flip = abs(cos(time * (2.0 + 3.0 * h) + h * 9.0));
                    float size = 0.11 + 0.05 * hash21(cell + 11.0);
                    float d = length(lq / vec2(size, size * (0.12 + 0.45 * flip)));
                    float m = smoothstep(1.0, 0.7, d);
                    if (m <= 0.0) continue;
                    float pick = hash21(cell + 23.0);
                    vec3 lc = seasonTint(gFoliage, pick < 0.5 ? 0.13 : 0.06, 0.0);
                    lc = mix(lc, seasonTint(gFoliage, 0.07, 0.6), step(0.85, pick));
                    lc *= mix(gSkyTop, gSkyLow, 0.5) * 1.2 + gSunLight * (gIsDay ? gDaylight : 0.1) * 0.7;
                    col = mix(col, lc, m * (layer == 2 ? 0.85 : 1.0));
                }
            }
        }
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
        float windX = gWindS * 4.5;
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
