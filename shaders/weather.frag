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
//               birches whose leaves follow the season and a Scots pine
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
    float windSide;    // sideways wind on screen: +1 to the right, -1 left
    float windTravel;  // integrated cloud drift (host-side)
    float eggCampfire; // easter eggs forced on from the test panel (0/1)
    float eggHikers;
    float eggAurora;
    float eggBirds;
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
float gLush, gLeaf, gAutumn, gSpring, gDry, gFallRate, gFlowers, gGrassAmt, gGrassH, gWindS, gWindDir;
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

// A range's skyline: a few distinct massifs (a slow swell), ridged crests on
// top of them with saddles between, and crag roughness that grows toward
// the summits so peaks are rugged and valleys smooth.
float rangeHeight(float x, float seed, float scale, float rugged) {
    float massif = vnoise(vec2(x * 0.5 * scale + seed * 3.3, seed * 0.37 + 0.5));
    float h = (0.55 + 0.45 * massif) * pow(ridged(x * 0.85 * scale + seed * 2.0 + 1.0, seed), 1.6) * 1.15;
    float crag = (vnoise(vec2(x * 36.0 * scale, seed)) - 0.5) * 0.07
               + (vnoise(vec2(x * 90.0 * scale, seed + 1.0)) - 0.5) * 0.03;
    return h + crag * h * h * 2.2 * rugged;
}

float farRidge(float x)  { return WL - 0.012 - 0.20 * rangeHeight(x, 1.0, 1.0, 1.0); }
float midRidge(float x)  { return WL - 0.006 - 0.12 * rangeHeight(x, 9.0, 1.56, 0.5); }

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

// One background tree: a conifer (tiered, jagged spire) or a broadleaf
// (round, lumpy crown on a short trunk). `t` returns height along the
// tree (0 base, 1 top) and `side` which flank the pixel is on.
float bgTree(vec2 p, float cx, float baseY, float h, float kind, float seed, out float t, out float side) {
    t = (baseY - p.y) / h;
    // Leans and rocks with the wind, more at the top.
    float tt0 = clamp(t, 0.0, 1.0);
    p.x -= gWindDir * (0.03 + 0.40 * pow(gWindS, 1.4)) * (0.65 + 0.35 * sin(time * (0.8 + 2.5 * gWindS) + seed * 3.0)) * h * tt0 * tt0;
    side = sign(p.x - cx);
    if (t < -0.05 || t > 1.05 || abs(p.x - cx) > h * 0.45) return 0.0;
    float aa = 0.0006;
    if (kind < 0.5) {
        // Conifer: tiers make the edge a saw, needle fringe roughens it.
        float saw = fract(t * (5.0 + 3.0 * hash1(seed)) + hash1(seed * 2.0));
        float w = h * 0.26 * pow(max(1.0 - t, 0.0), 0.95) * (0.62 + 0.38 * saw);
        w *= 0.85 + 0.3 * vnoise(vec2(p.y * 900.0, seed));
        float trunk = step(t, 0.10) * step(abs(p.x - cx), h * 0.025);
        return max(smoothstep(w + aa, w - aa, abs(p.x - cx)), trunk);
    }
    // Broadleaf: a lumpy crown over a short trunk; a twig haze when bare.
    vec2 c = vec2(cx, baseY - h * 0.60);
    vec2 d = (p - c) / vec2(h * 0.30, h * 0.40);
    float lump = (fbm3(p * 260.0 + seed) - 0.5) * 0.55;
    float crown = smoothstep(1.08, 0.92, length(d) + lump) * (0.35 + 0.65 * gLeaf);
    float trunk = step(t, 0.30) * step(abs(p.x - cx), h * 0.03);
    float twigs = smoothstep(1.0, 0.7, length(d)) * (1.0 - gLeaf) * step(0.45, vnoise(p * vec2(900.0, 500.0) + seed)) * 0.6;
    return max(max(crown, trunk), twigs);
}

// Colour of a background tree at depth `haze` (0 near .. 1 lost in air).
vec3 bgTreeCol(float kind, float t, float side, float seed, float haze, float cx) {
    vec3 skyAmb = mix(gSkyTop, gSkyLow, 0.5);
    float bodyStr = gIsDay ? gDaylight * (1.0 - gGloom * 0.7) : 0.2 * (1.0 - gGloom);
    float lit = clamp(0.5 + 0.5 * side * sign(gBody.x - cx), 0.0, 1.0) * bodyStr;
    vec3 c;
    if (kind < 0.5) {
        c = mix(gFoliage * vec3(0.50, 0.66, 0.62), bgColor.rgb, 0.35) * (0.75 + 0.4 * hash1(seed));
    } else {
        c = seasonTint(mix(gFoliage, bgColor.rgb, 0.25) * (0.75 + 0.4 * hash1(seed)), hash1(seed * 3.0) > 0.5 ? 0.12 : 0.05, 0.0);
        c = mix(c, mix(bgColor.rgb, mutedColor.rgb, 0.4) * 0.8, 1.0 - gLeaf);
    }
    c *= skyAmb * (0.65 + 0.35 * t) * 0.85 + gSunLight * lit * 0.25;
    float snowT = clamp(wxSnow * 1.2 + gCold * 0.35 - 0.1, 0.0, 1.0);
    c = mix(c, mix(fgColor.rgb, gSkyLow, 0.35) * (0.45 + 0.4 * gDaylight), snowT * smoothstep(0.3, 0.9, t) * 0.6);
    return mix(c, mix(gSkyLow, gSkyTop, 0.25), haze);
}

// Forest texture on a mountainside: a carpet of small spires in staggered
// rows, their sunward flanks lit, so a slope reads as trees.
float slopeTrees(vec2 p, float scale, float seed, float density, out float shade) {
    vec2 g = p * vec2(260.0, 150.0) / scale;
    float row = floor(g.y);
    g.x += mod(row, 2.0) * 0.5;
    vec2 id = floor(g);
    vec2 f = fract(g);
    shade = 0.5;
    float hh = hash21(id + seed);
    // Scattered like particles: each spot holds a tree with the local
    // density's probability, so the edge of the forest thins out tree by tree.
    if (hash21(id + seed + 7.3) > density) return 0.0;
    float y = 1.0 - f.y;
    float sway = gWindDir * (0.04 + 0.35 * pow(gWindS, 1.4)) * (0.7 + 0.3 * sin(time * (1.0 + 2.5 * gWindS) + hh * 20.0)) * y * y;
    float x = f.x - 0.5 - (hh - 0.5) * 0.3 - sway;
    float tip = 0.75 + 0.45 * hh;
    float w = max(tip - y, 0.0) * 0.50;
    float m = smoothstep(w + 0.06, w - 0.06, abs(x)) * step(y, tip);
    shade = 0.5 + 0.5 * sign(x) * sign(gBody.x - p.x);
    return m;
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
    // The treeline follows the mountain: a share of the crest's height above
    // the water, so it climbs under the peaks and drops in the saddles.
    float crestAlt = WL - ridgeY;
    float treeAlt = crestAlt * (0.22 + 0.14 * fbm3(vec2(p.x * 3.0 + seed, 2.0))) + 0.012 - depth * 0.01;
    float tShade;
    float density = smoothstep(treeAlt + 0.016, treeAlt - 0.012, alt) * smoothstep(-0.2, 0.25, n.y);
    float spires = slopeTrees(p, 1.0 + depth * 1.5, seed, density, tShade);
    // Solid canopy only where the forest is dense; scattered trees above.
    float forest = max(spires, smoothstep(0.80, 1.0, density) * 0.85);
    vec3 forestCol = mix(bgColor.rgb * 0.50, gFoliage * vec3(0.55, 0.72, 0.68), 0.55);
    // Birch stands through the conifers, gold in autumn, grey when bare.
    float decid = smoothstep(0.55, 0.75, fbm3(p * vec2(40.0, 25.0) + seed));
    forestCol = mix(forestCol, seasonTint(gFoliage * 0.8, 0.12, 0.0), decid * 0.6 * gLeaf);
    forestCol *= (0.45 + 0.55 * mix(0.35, 1.0, spires) * (0.7 + 0.3 * tShade))
               * (skyTint * 1.1 * ambient + gSunLight * direct * 0.9);
    c = mix(c, forestCol, forest * 0.92);

    // Snow: temperature sets the line; hollows and gentle faces hold it lower.
    float coldness = clamp(gCold + wxSnow * 0.8, 0.0, 1.0);
    float snowAlt = mix(0.30, 0.03, coldness) + (fbm3(vec2(p.x * 30.0, seed)) - 0.5) * 0.03
                  - (0.55 - h0) * 0.06 - n.y * 0.02;
    float snow = smoothstep(snowAlt, snowAlt + 0.010, alt) * step(0.02, gCold + wxSnow);
    vec3 snowCol = mix(fgColor.rgb, gSkyLow, 0.30) * (skyTint * 0.9 * ambient + gSunLight * direct * 1.4 + 0.12);
    c = mix(c, snowCol, snow * 0.95);

    // Shadows of passing clouds.
    if (gIsDay) {
        float cs = smoothstep(0.52, 0.72, fbm3(vec2(p.x * 1.3 + gDrift * 0.9, p.y * 3.0 + seed)));
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
        float auroraNight = eggAurora + smoothstep(0.45, 0.8, vnoise(vec2(time / 1100.0, 5.0)))
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
    // Outlines are blended over about a pixel, not cut, so skylines stay
    // clean instead of stair-stepping.
    const float SKY_AA = 0.0008;
    float fr = farRidge(p.x);
    float cFar = smoothstep(fr - SKY_AA, fr + SKY_AA, p.y);
    if (cFar > 0.0) {
        float sl = (farRidge(p.x + 0.012) - farRidge(p.x - 0.012)) / 0.024;
        vec3 rock = mix(mutedColor.rgb, bgColor.rgb, 0.4);
        col = mix(col, shadeRange(p, fr, sl, 0.60, rock, 1.0), cFar);
    }

    // ---- easter egg: hikers on the far range ----
    // Now and then a small party walks a path below the crest and passes
    // out of sight behind a shoulder of the mountain. At night each carries
    // a head torch that flares when they look toward us and dims as they
    // turn away, flickering as they walk.
    {
        float slotLen = 900.0;
        float hSlot = floor(time / slotLen);
        float st = time - hSlot * slotLen;
        bool on = hash1(hSlot * 4.3) > 0.55 && st < 300.0;
        if (eggHikers > 0.5) { hSlot = floor(time / 200.0); st = time - hSlot * 200.0; on = true; }
        if (on && abs(p.y - (WL - 0.12)) < 0.14) {
            float dir = hash1(hSlot * 1.9) > 0.5 ? 1.0 : -1.0;
            float x0 = (hash1(hSlot * 2.7) - 0.5) * 2.2;
            if (eggHikers > 0.5) x0 = -0.75 - dir * 0.18;
            float count = 1.0 + floor(hash1(hSlot * 6.1) * 3.0);
            float dur = eggHikers > 0.5 ? 200.0 : 300.0;
            float fade = smoothstep(0.0, 6.0, st) * smoothstep(dur, dur - 6.0, st);
            float nightF = 1.0 - gDaylight;
            for (int i = 0; i < 3; i++) {
                float fi = float(i);
                if (fi >= count) break;
                float hx = x0 + dir * (st * 0.0026 - fi * 0.010);
                float crestY = farRidge(hx);
                float hy = crestY + 0.020 + 0.005 * sin(hx * 9.0 + hSlot);
                // Hidden where the nearer range stands in front of the path.
                if (midRidge(hx) < hy) continue;
                if (abs(p.x - hx) > 0.02) continue;
                float step_ = st * 3.2 + fi * 1.3;
                float bob = abs(sin(step_)) * 0.00025;
                vec2 fq = p - vec2(hx, hy);
                float body = step(abs(fq.x), 0.00050) * step(fq.y, -0.0013) * step(-0.0034 - bob, fq.y);
                float legA = step(abs(fq.x - 0.00035 * sin(step_)), 0.00022) * step(fq.y, 0.0) * step(-0.0014, fq.y);
                float legB = step(abs(fq.x + 0.00035 * sin(step_)), 0.00022) * step(fq.y, 0.0) * step(-0.0014, fq.y);
                float head = step(length(fq - vec2(0.0, -0.0040 - bob)), 0.00055);
                float pack = step(abs(fq.x + dir * 0.00065), 0.00040) * step(fq.y, -0.0018 - bob) * step(-0.0032 - bob, fq.y);
                float fig = max(max(body, max(legA, legB)), max(head, pack));
                col = mix(col, mix(bgColor.rgb * 0.12, mix(gSkyLow, gSkyTop, 0.3), 0.25), fig * fade * (0.7 + 0.3 * gDaylight));
                if (nightF > 0.15) {
                    // Head yaw: scanning the trail, glancing round.
                    float look = sin(time * 0.55 + fi * 2.1 + hSlot) * 1.5 + sin(time * 1.7 + fi) * 0.35;
                    float facing = cos(look);
                    float flick = 0.85 + 0.15 * sin(step_ * 2.0) * sin(time * 23.0 + fi);
                    float lampI = smoothstep(-0.15, 0.9, facing) * flick;
                    vec2 lp = vec2(hx + dir * 0.00035, hy - 0.0041 - bob);
                    float dl2 = dot(p - lp, p - lp);
                    vec3 lampCol = mix(fgColor.rgb, vec3(1.0, 0.95, 0.85), 0.5);
                    col += lampCol * (exp(-dl2 / 3.0e-8) * 2.2 * lampI + exp(-dl2 / 5.0e-6) * 0.20 * (0.3 + lampI)) * nightF * fade;
                    // When turned sideways the beam itself shows, raking the slope.
                    vec2 bd = vec2(sin(look) * dir, 0.35);
                    float along = dot(p - lp, normalize(bd));
                    float acr = abs(dot(p - lp, vec2(-normalize(bd).y, normalize(bd).x)));
                    float beam = step(0.0, along) * exp(-along / 0.012) * smoothstep(along * 0.35 + 0.0004, 0.0, acr)
                               * (1.0 - lampI * 0.6) * abs(sin(look));
                    col += lampCol * beam * 0.18 * nightF * fade;
                }
            }
        }
    }
    // Valley fog lies between the ranges.
    float haze = 0.12 + wxFog * 0.7 + (gIsDay ? smoothstep(0.18, 0.0, sunPhase) * 0.45 : 0.0);
    float fogBand = exp(-pow((p.y - (WL - 0.03)) / 0.035, 2.0))
                  * (0.45 + 0.9 * fbm3(vec2(p.x * 2.2 - time * 0.008, p.y * 18.0)));
    vec3 fogCol = mix(gSkyLow, fgColor.rgb, 0.25) * (0.45 + 0.55 * gDaylight) + gDusk * gTwilight * 0.3;
    col = mix(col, fogCol, clamp(fogBand * haze, 0.0, 0.85));

    float mr = midRidge(p.x);
    float cMid = smoothstep(mr - SKY_AA, mr + SKY_AA, p.y);
    if (cMid > 0.0) {
        float sl = (midRidge(p.x + 0.012) - midRidge(p.x - 0.012)) / 0.024;
        vec3 rock = mix(mutedColor.rgb, bgColor.rgb, 0.65);
        col = mix(col, shadeRange(p, mr, sl, 0.30, rock, 7.0), cMid);
    }
    float fogBand2 = exp(-pow((p.y - (WL - 0.008)) / 0.018, 2.0))
                   * (0.5 + 0.8 * fbm3(vec2(p.x * 3.0 + time * 0.011, p.y * 30.0 + 4.0)));
    col = mix(col, fogCol, clamp(fogBand2 * haze * 1.1, 0.0, 0.85));

    // ---- the forested hills across the lake ----
    // Rows of individual trees from the hill crest down to the water, each
    // row nearer, larger and less hazed than the one behind, over a dark
    // forest floor -- a forest with depth, not a fringe on the shore.
    {
        // The wooded hills follow the foot of the mountains behind them.
        float hillTop = mix(WL - 0.006, midRidge(p.x), 0.22) - 0.022 * fbm3(vec2(p.x * 1.6 + 5.0, 2.0));
        if (p.y > hillTop - 0.045) {
            for (int r = 0; r < 5; r++) {
                float fr2 = float(r) / 4.0;
                float h = mix(0.014, 0.030, fr2);
                float cellW = h * 0.30;
                float c0 = floor(p.x / cellW);
                float rowHaze = mix(0.45, 0.10, fr2) + haze * 0.2;
                for (int k = -1; k <= 1; k++) {
                    float cell = c0 + float(k);
                    float seedT = cell * 3.17 + float(r) * 41.3;
                    float cx = (cell + 0.5 + (hash1(seedT) - 0.5) * 0.6) * cellW;
                    float top = mix(WL - 0.006, midRidge(cx), 0.22) - 0.022 * fbm3(vec2(cx * 1.6 + 5.0, 2.0));
                    // Each tree's own depth jitter, so rows dissolve into a scatter.
                    float baseY = mix(top + 0.006, WL + 0.003, fr2) + (hash1(seedT + 1.0) - 0.5) * 0.012;
                    // Thinner toward the top of the hill, and some clearings.
                    if (hash1(seedT + 7.0) > mix(0.55, 0.92, fr2)) continue;
                    float hT = h * (0.45 + 1.1 * pow(hash1(seedT + 2.0), 1.5));
                    float kind = hash1(seedT + 3.0) < 0.22 ? 1.0 : 0.0;
                    if (kind > 0.5) hT *= 0.75;
                    float tt, sd;
                    float m = bgTree(p, cx, baseY, hT, kind, seedT, tt, sd);
                    // Forest floor behind each row keeps the sky from showing through.
                    float floor_ = step(baseY - hT * 0.25, p.y) * step(abs(p.x - cx), cellW * 0.7);
                    if (floor_ > 0.0 && m < 0.5) {
                        vec3 fl = mix(bgColor.rgb * 0.35, gFoliage * 0.25, 0.4) * (mix(gSkyTop, gSkyLow, 0.5) * 1.2);
                        col = mix(col, mix(fl, mix(gSkyLow, gSkyTop, 0.25), rowHaze), floor_);
                    }
                    if (m > 0.0) col = mix(col, bgTreeCol(kind, tt, sd, seedT, rowHaze, cx), m);
                }
            }
        }
    }

    // ---- easter egg: a campfire on the far shore ----
    // Some evenings someone lights a fire at the water's edge: a flickering
    // core, tongues of flame, warm light on the trees round it (and in the
    // lake, since this is reflected), and smoke drifting off with the wind.
    // Rain puts it out.
    {
        float fireSlot = floor(time / 1500.0);
        float fireOn = step(0.60, hash1(fireSlot * 7.7)) * smoothstep(0.9, 0.2, gDaylight + (1.0 - gTwilight) * 0.0)
                     * (1.0 - smoothstep(0.2, 0.45, wxRain)) * (1.0 - smoothstep(0.4, 0.8, wxSnow));
        float fx = (hash1(fireSlot * 3.1) > 0.5 ? 1.0 : -1.0) * mix(0.45, 1.25, hash1(fireSlot * 5.9));
        if (eggCampfire > 0.5) { fireOn = 1.0; fx = -0.62; }
        if (fireOn > 0.01 && abs(p.x - fx) < 0.25 && p.y > WL - 0.25 && p.y < WL + 0.01) {
            vec2 fp = vec2(fx, WL - 0.0022);
            float night = 1.0 - gDaylight * 0.8;
            float flick = (0.78 + 0.22 * sin(time * 13.0 + sin(time * 7.3) * 2.0)) * (0.75 + 0.25 * vnoise(vec2(time * 9.0, 1.0)));
            vec3 fireCol = hsv2rgb(vec3(0.075, 0.85, 1.0));
            vec3 emberCol = hsv2rgb(vec3(0.03, 0.9, 0.9));
            vec2 dF2 = (p - fp) * vec2(1.0, 1.4);
            float dF = dot(dF2, dF2);
            // Warm light spilling onto the shore and trees nearby.
            col += fireCol * col * exp(-dF / 0.0010) * 3.0 * flick * night * fireOn;
            col += fireCol * exp(-dF / 0.00020) * 0.16 * flick * night * fireOn;
            // Flames: a few tongues licking up from the core.
            vec2 fq = (p - fp) / 0.0045;
            if (fq.y < 0.3 && fq.y > -1.8 && abs(fq.x) < 1.0) {
                float flame = 0.0;
                for (int k = 0; k < 3; k++) {
                    float fk = float(k);
                    float ox = (fk - 1.0) * 0.28 + sin(time * (7.0 + fk * 2.3) + fq.y * 3.0 + fk) * 0.10;
                    float hgt = 1.0 + 0.5 * sin(time * (5.0 + fk * 3.1) + fk * 2.0);
                    float tt = clamp(-fq.y / hgt, 0.0, 1.0);
                    float wdt = 0.30 * (1.0 - tt) * (1.0 - tt * 0.3);
                    flame = max(flame, smoothstep(wdt, wdt * 0.3, abs(fq.x - ox)) * step(fq.y, 0.2) * step(-hgt, fq.y));
                }
                vec3 fc = mix(fireCol, vec3(1.0, 0.95, 0.7), smoothstep(-0.2, 0.3, fq.y) * 0.6);
                col = mix(col, fc * (0.9 + 0.3 * flick), flame * fireOn * (0.6 + 0.4 * night));
            }
            // Embers at the base.
            col += emberCol * exp(-dF / 0.0000045) * 1.4 * flick * fireOn;
            // Smoke: rises, widens, bends away with the wind.
            float sy = fp.y - p.y;
            if (sy > 0.002 && sy < 0.22) {
                float drift = gWindDir * (0.03 + 0.9 * gWindS) * sy + sin(sy * 22.0 - time * 0.7) * 0.004 * (1.0 + sy * 12.0);
                float wdt = 0.0025 + sy * 0.10;
                float dx = (p.x - fp.x - drift) / wdt;
                float plume = exp(-dx * dx) * smoothstep(0.22, 0.03, sy)
                            * (0.35 + 0.9 * fbm3(vec2(dx * 0.7, sy * 28.0 - time * 0.5)));
                vec3 smokeCol = mix(gSkyLow, fgColor.rgb * 0.75, 0.35) * (0.45 + 0.55 * gDaylight)
                              + fireCol * 0.25 * exp(-sy * 45.0) * night;
                col = mix(col, smokeCol, clamp(plume, 0.0, 1.0) * 0.45 * fireOn);
            }
        }
    }

    // Distant rain shafts under the clouds.
    if (wxRain > 0.01) {
        float slant = (0.08 + wxWind * 0.5) * windSide;
        float shafts = smoothstep(0.45, 0.8, fbm3(vec2((p.x - p.y * slant) * 2.4 + gDrift * 1.5, 0.5)));
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

// Nearest point on a quadratic Bezier, by chords: returns the distance and
// sets `t` (0..1 along) and `across` (signed, + to the right of travel).
float bezD(vec2 p, vec2 a, vec2 c, vec2 b, out float t, out float across) {
    float best = 1e3;
    t = 0.0;
    across = 0.0;
    vec2 prev = a;
    for (int i = 1; i <= 6; i++) {
        vec2 cur = bez(a, c, b, float(i) / 6.0);
        float h;
        float d = segD(p, prev, cur, h);
        if (d < best) {
            best = d;
            t = (float(i - 1) + h) / 6.0;
            vec2 dir = normalize(cur - prev + 1e-6);
            vec2 rel = p - mix(prev, cur, h);
            across = dir.x * rel.y - dir.y * rel.x;
        }
        prev = cur;
    }
    return best;
}

// Silver birch, grown from a few stems out of one root: each stem curves
// up and outward, white with black lenticel dashes, dark diamond scars and a
// rough dark base. Branches arch up and out and weep at the tips; the crown
// is an airy, irregular mass of small leaves with sky through it and
// hanging fringes at the edges. Bare, fine-twigged in winter.
vec4 birch(vec2 p, float bx, float topY, float seed, float stems) {
    const float baseY = 0.57;
    float H = baseY - topY;
    if (abs(p.x - bx) > H * 0.78 || p.y < topY - 0.10) return vec4(0.0);
    float hN = (baseY - p.y) / H;
    vec2 q = vec2(p.x - treeSway(clamp(hN, 0.0, 1.2), seed), p.y);

    vec3 skyAmb = mix(gSkyTop, gSkyLow, 0.5);
    float bodyStr = gIsDay ? gDaylight * (1.0 - gGloom * 0.7) : 0.25 * (1.0 - gGloom);
    vec3 L = normalize(vec3(gBody.x - p.x, p.y - gBody.y, 0.4));
    float snowFall = clamp(wxSnow * 1.3 + gCold * 0.2 - 0.1, 0.0, 1.0);
    vec3 whiteBark = mix(fgColor.rgb, mutedColor.rgb, 0.22) * 0.97;
    vec3 darkMark = bgColor.rgb * 0.14;

    vec3 col = vec3(0.0);
    float cov = 0.0;
    float field = 0.0;
    vec2 grad = vec2(0.0);

    for (int si = 0; si < 3; si++) {
        float fs = float(si);
        if (fs >= stems) break;
        float hs = hash1(seed * 3.0 + fs * 5.1);
        float spread = (fs - (stems - 1.0) * 0.5) * 0.42 + (hs - 0.5) * 0.12;
        vec2 a = vec2(bx + (fs - (stems - 1.0) * 0.5) * 0.010, baseY);
        vec2 top = vec2(bx + spread * H * 0.60, topY + H * (0.04 + 0.16 * hs) + abs(spread) * H * 0.12);
        vec2 c = vec2(bx + spread * H * 0.02 - spread * 0.03 + (hs - 0.5) * 0.02 + sin(seed * 2.0 + fs * 2.4) * 0.035, baseY - H * 0.55);
        float sH = length(top - a);

        // Stem.
        float t, across;
        float d = segD(q, a, top, t) < 0.25 ? bezD(q, a, c, top, t, across) : 1e3;
        float w = mix(stems > 1.5 ? 0.013 : 0.017, 0.0022, pow(t, 0.8));
        if (d < w + 0.002) {
            float m = smoothstep(w + 0.0012, w - 0.0012, d);
            float u = clamp(across / w, -1.0, 1.0);
            float round_ = sqrt(max(1.0 - u * u, 0.0));
            float along = t * sH;
            float dash = smoothstep(0.62, 0.72, vnoise(vec2(u * 2.5 + seed + fs * 7.0, along * 240.0)))
                       * smoothstep(0.3, 0.6, vnoise(vec2(u * 6.0, along * 38.0 + seed + fs)));
            float scar = smoothstep(0.80, 0.90, vnoise(vec2(u * 1.4 + fs * 3.0, along * 22.0 + seed)));
            float base = smoothstep(0.16, 0.02, t) * smoothstep(0.30, 0.70, vnoise(vec2(u * 5.0, along * 80.0)));
            vec3 bark = mix(whiteBark, darkMark, clamp(dash * 0.85 + scar * 0.9 + base * 0.9, 0.0, 1.0));
            float lit = (0.45 + 0.55 * clamp(dot(normalize(vec3(u, 0.2, round_)), L), 0.0, 1.0)) * bodyStr;
            vec3 bc = bark * (skyAmb * 0.9 + gSunLight * lit * 0.6) * (0.55 + 0.45 * round_);
            col = mix(col, bc, m * (1.0 - cov));
            cov = max(cov, m);
        }

        // Branches.
        for (int j = 0; j < 7; j++) {
            float fj = float(j);
            float hb = hash1(seed * 11.0 + fs * 17.0 + fj * 3.7);
            float tb = mix(0.34, 0.94, (fj + hb * 0.8) / 7.0);
            vec2 root = bez(a, c, top, tb);
            float side = mod(fj + fs, 2.0) < 0.5 ? -1.0 : 1.0;
            if (hash1(fj * 5.3 + fs + seed) > 0.72) side = sign(spread + 1e-3);
            float len = H * (0.34 - 0.18 * tb) * (0.65 + 0.6 * hb);
            vec2 bc2 = root + vec2(side * len * 0.35, -len * (0.40 + 0.25 * hb));
            vec2 end = root + vec2(side * len * 0.90, -len * (0.18 + 0.30 * hb) + len * 0.30 * smoothstep(0.7, 0.35, tb));
            if (length(q - mix(root, end, 0.5)) > len * 0.75 + 0.09) continue;
            float tbb, acb;
            float db = bezD(q, root, bc2, end, tbb, acb);
            float wb = mix(0.0036, 0.0007, tbb) * (1.0 - tb * 0.3);
            float mb = smoothstep(wb + 0.0009, wb - 0.0004, db);
            if (mb > 0.0) {
                vec3 wood = mix(whiteBark * 0.8, darkMark * 2.0, smoothstep(0.3, 0.9, tbb)) * (skyAmb * 0.95 + gSunLight * bodyStr * 0.35);
                wood = mix(wood, mix(fgColor.rgb, gSkyLow, 0.3) * (0.5 + 0.4 * gDaylight), snowFall * step(acb * side, 0.0) * 0.8);
                col = mix(col, wood, mb * (1.0 - cov * 0.5));
                cov = max(cov, mb);
            }
            // Winter: a spray of fine twigs off the tip.
            if (gLeaf < 0.6) {
                for (int k = 0; k < 4; k++) {
                    float fk = float(k);
                    vec2 t0 = bez(root, bc2, end, 0.55 + fk * 0.13);
                    vec2 t1 = t0 + rot2(vec2(side, 0.3), (hash1(fj * 3.0 + fk + fs + seed) - 0.5) * 1.8) * len * 0.22
                            + vec2(0.0, len * 0.10);
                    float hk;
                    float dk = segD(q, t0, t1, hk);
                    float tw = smoothstep(0.0009, 0.0002, dk) * (1.0 - gLeaf * 1.6);
                    col = mix(col, darkMark * 2.2 * skyAmb * 1.3, tw * (1.0 - cov));
                    cov = max(cov, tw);
                }
            }
            // Foliage: a clump at the tip, one partway, and a hanging fringe.
            if (gLeaf > 0.01) {
                for (int k = 0; k < 3; k++) {
                    vec2 cp; vec2 rr;
                    float sz = (0.8 + 0.4 * hash1(fj * 7.0 + float(k) + fs * 3.0 + seed)) * (0.7 + 0.3 * gLeaf);
                    if (k == 0) { cp = end + vec2(side * 0.010, 0.004); rr = vec2(0.060, 0.048) * sz; }
                    else if (k == 1) { cp = bez(root, bc2, end, 0.55) + vec2(0.0, -0.006); rr = vec2(0.045, 0.036) * sz; }
                    else { cp = end + vec2(side * 0.022, 0.050); rr = vec2(0.030, 0.060) * sz; }
                    vec2 dq = (q - cp) / rr;
                    float kk = exp(-dot(dq, dq));
                    field += kk;
                    grad += kk * dq / rr;
                }
            }
        }
    }

    // Leaf mass: solid only where it is thick, lacy and holed elsewhere.
    if (gLeaf > 0.01 && field > 0.05) {
        float edgeN = (fbm3(q * 24.0 + seed) - 0.5) * 0.8 + (fbm3(q * 75.0 + seed * 2.0) - 0.5) * 0.4;
        float level = field + edgeN;
        float holes = smoothstep(0.25, 0.48, fbm3(q * 14.0 + seed * 4.0) + (field - 1.0) * 0.2);
        float inner = smoothstep(1.05, 1.5, level) * holes;
        float halo = smoothstep(0.20, 0.60, level) * (0.55 + 0.45 * holes);
        float shade;
        float dots = leafDots(q, 0.0072, gLeaf * halo, seed * 1.9, shade);
        float dotsDeep = leafDots(q + 0.0031, 0.0072, gLeaf * inner * 0.9, seed * 2.7, shade);
        float mass = max(dots, dotsDeep * 0.9);
        if (mass > 0.0) {
            vec2 cq = q * 40.0 + seed;
            float c0 = fbm3(cq);
            vec2 cg = vec2(fbm3(cq + vec2(0.05, 0.0)) - c0, fbm3(cq + vec2(0.0, 0.05)) - c0) / 0.05;
            vec3 n = normalize(vec3(-grad.x * 0.015 - cg.x * 0.8, grad.y * 0.015 + cg.y * 0.8, 1.0));
            float lit = clamp(dot(n, L), 0.0, 1.0) * bodyStr;
            float under = clamp(grad.y * 0.012, -1.0, 1.0) * 0.5 + 0.5;
            vec3 fol = seasonTint(gFoliage * (0.78 + 0.45 * shade), 0.135, 0.0);
            fol = mix(fol, seasonTint(gFoliage, 0.12, 0.35), step(0.82, shade) * gAutumn);
            float depthShade = mix(0.80, 1.0, dots) * (0.82 + 0.30 * smoothstep(0.3, 0.7, c0));
            vec3 fc = fol * (skyAmb * (1.0 - under * 0.30) * 1.45 + gSunLight * lit * 0.95) * depthShade;
            col = mix(col, fc, mass);
            cov = max(cov, mass);
        }
    }
    return vec4(col, cov);
}

// Needle texture inside a pad: tufts of short needles at random angles,
// denser toward the pad's heart, flickering a little in the wind.
float needles(vec2 q, float density, float seed, out float shade) {
    shade = 0.0;
    vec2 g = q / 0.0042;
    vec2 b = floor(g);
    float best = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
            vec2 c = b + vec2(float(ox), float(oy));
            float h = hash21(c + seed);
            if (h > density) continue;
            float hh = hash21(c + seed + 5.1);
            vec2 ctr = c + 0.5 + (vec2(hash21(c + seed + 2.2), hh) - 0.5) * 0.8
                     + vec2(sin(time * (2.0 + 7.0 * gWindS) + hh * 25.0), 0.0) * (0.03 + 0.18 * gWindS);
            // A tuft: three needles fanning from one point.
            for (int n = 0; n < 3; n++) {
                float ang = hh * 6.2831 + float(n) * 0.55 - 0.55;
                vec2 lq = rot2(g - ctr, ang);
                float d = length(lq / vec2(0.95, 0.10));
                float m = smoothstep(1.0, 0.6, d);
                if (m > best) { best = m; shade = hash21(c + seed + float(n)); }
            }
        }
    }
    return best;
}

// Pine, the classic cone: whorls of branches round a straight trunk, rising
// slightly and shortening toward the top so the outline is a triangle.
// Needles grow as brushes along the outer part of each branch, thickest on
// top and at the tip, dark toward the trunk where the tree shades itself,
// with sky showing between the whorls. Bark is grey low down and warm red
// higher up. Evergreen; snow collects on the upper side of the brushes.
vec4 pine(vec2 p, float bx, float topY, float seed) {
    const float baseY = 0.56;
    float H = baseY - topY;
    float hN = (baseY - p.y) / H;
    const float maxR = 0.31;
    if (hN < -0.05 || hN > 1.06 || abs(p.x - bx) > maxR + 0.05) return vec4(0.0);
    float sway = treeSway(clamp(hN, 0.0, 1.1), seed) * 0.7;
    vec2 q = vec2(p.x - sway, p.y);

    vec3 skyAmb = mix(gSkyTop, gSkyLow, 0.5);
    float bodyStr = gIsDay ? gDaylight * (1.0 - gGloom * 0.7) : 0.25 * (1.0 - gGloom);
    vec3 L = normalize(vec3(gBody.x - p.x, p.y - gBody.y, 0.4));
    float snowFall = clamp(wxSnow * 1.3 + gCold * 0.2 - 0.1, 0.0, 1.0);
    vec3 snowCol = mix(fgColor.rgb, gSkyLow, 0.3) * (0.4 + 0.5 * gDaylight + 0.1 * bodyStr);
    vec3 lowBark = mix(bgColor.rgb, mutedColor.rgb, 0.4) * 0.55;
    vec3 highBark = hsv2rgb(vec3(0.055, 0.55, 0.55)) * (0.6 + luma(fgColor.rgb) * 0.5);
    vec3 needleCol = gFoliage * vec3(0.80, 0.95, 0.88);
    needleCol = mix(needleCol, vec3(luma(needleCol)) * 0.9, (1.0 - gLeaf) * 0.25);

    vec3 col = vec3(0.0);
    float cov = 0.0;

    // Trunk.
    float tx = bx + 0.006 * sin(hN * 4.0 + seed);
    float tw = mix(0.020, 0.003, pow(clamp(hN, 0.0, 1.0), 0.9));
    float dT = abs(q.x - tx);
    if (hN < 1.0 && dT < tw + 0.002) {
        float m = smoothstep(tw + 0.0012, tw - 0.0012, dT);
        float u = (q.x - tx) / tw;
        float round_ = sqrt(max(1.0 - u * u, 0.0));
        float upper = smoothstep(0.30, 0.55, hN + (vnoise(vec2(u * 3.0, q.y * 30.0)) - 0.5) * 0.15);
        float furrow = vnoise(vec2(u * 7.0 + seed, q.y * 16.0)) * 0.6 + vnoise(vec2(u * 18.0, q.y * 45.0)) * 0.4;
        float plates = vnoise(vec2(u * 5.0 + seed, q.y * 120.0));
        vec3 bark = mix(lowBark * (0.55 + 0.8 * furrow), highBark * (0.75 + 0.45 * plates), upper);
        float lit = clamp(dot(normalize(vec3(u, 0.15, round_)), L), 0.0, 1.0) * bodyStr;
        col = bark * (skyAmb * 0.85 + gSunLight * lit) * (0.5 + 0.5 * round_);
        cov = m;
    }

    // Whorls: find the brush this pixel belongs to (the strongest envelope),
    // drawing bare wood near the trunk as we go.
    float bestEnv = 0.0;
    float bestTop = 0.0, bestInner = 0.0, bestSide = 0.0;
    for (int l = 0; l < 18; l++) {
        float fl = float(l);
        float hl = mix(0.16, 0.97, (fl + 0.55 * hash1(fl + seed)) / 18.0);
        float wy = baseY - hl * H;
        if (abs(q.y - wy) > 0.09) continue;
        float reachL = maxR * pow(1.0 - hl, 0.9);
        vec2 a = vec2(bx + 0.006 * sin(hl * 4.0 + seed), wy);
        for (int k = 0; k < 5; k++) {
            float fk = float(k);
            float hk = hash1(fl * 7.3 + fk * 2.1 + seed);
            // Two branches to the sides, two turned partly toward or away
            // from us (foreshortened), one pointing at us (short).
            float side = mod(fk, 2.0) < 0.5 ? -1.0 : 1.0;
            if (k == 4) side = hk > 0.5 ? 1.0 : -1.0;
            float fore = k < 2 ? 1.0 : (k < 4 ? 0.62 : 0.35);
            float reach = reachL * fore * (0.72 + 0.45 * hk);
            if (hash1(fl * 3.1 + fk + seed * 4.0) > 0.85) reach *= 0.5;       // broken or stunted
            // Low branches sag, high ones climb.
            float rise = mix(-0.12, 0.30, hl) + 0.16 * (hash1(fl + fk * 5.0 + seed * 2.0) - 0.5);
            vec2 e = a + vec2(side * reach, -reach * rise);
            vec2 mid = mix(a, e, 0.55) + vec2(0.0, -reach * 0.04);    // bows slightly up
            float t1, t2;
            float d1 = segD(q, a, mid, t1);
            float d2 = segD(q, mid, e, t2);
            float t = d1 < d2 ? t1 * 0.55 : 0.55 + t2 * 0.45;
            vec2 onB = d1 < d2 ? mix(a, mid, t1) : mix(mid, e, t2);
            float dper = q.y - onB.y;                              // < 0: above the branch
            // Wood, visible close to the trunk where the needles thin out.
            float w = mix(0.0032, 0.0012, t);
            float wood = smoothstep(w + 0.0008, w - 0.0004, min(d1, d2)) * smoothstep(0.7, 0.2, t);
            if (wood > 0.0) {
                vec3 wc = mix(highBark, lowBark, 0.5) * (skyAmb * 0.9 + gSunLight * bodyStr * 0.3);
                col = mix(col, wc, wood * (1.0 - cov * 0.5));
                cov = max(cov, wood);
            }
            // Needles in separate tufts along the outer branch, each a ragged
            // fan standing up and out, bigger toward the tip.
            float env = 0.0;
            float topv = 0.0;
            if (min(d1, d2) < 0.05) {
                for (int m2 = 0; m2 < 4; m2++) {
                    float fm = float(m2);
                    float ht = hash1(fl * 11.0 + fk * 3.0 + fm * 1.7 + seed);
                    float tt = 0.40 + fm * 0.20 + (ht - 0.5) * 0.12;
                    if (tt > 1.0 || ht > 0.93) continue;
                    vec2 bp = tt <= 0.55 ? mix(a, mid, tt / 0.55) : mix(mid, e, (tt - 0.55) / 0.45);
                    float r = (0.012 + 0.018 * tt) * (0.7 + 0.5 * reach / maxR) * (0.75 + 0.5 * ht);
                    vec2 tc = bp + vec2(side * r * 0.25, -r * (0.35 + 0.3 * ht));
                    vec2 dq = (q - tc) / vec2(r * 1.25, r * 0.85);
                    float rag = (fbm3(q * 110.0 + fm * 5.0 + fk * 3.0 + fl) - 0.5) * 0.8;
                    float d = length(dq) + rag;
                    float te = smoothstep(1.0, 0.55, d);
                    if (te > env) { env = te; topv = clamp(-dq.y, -1.0, 1.0); }
                }
            }
            if (env > bestEnv) {
                bestEnv = env;
                bestTop = topv;
                bestInner = 1.0 - clamp(abs(q.x - a.x) / max(reachL, 1e-3), 0.0, 1.0);
                bestSide = side;
            }
        }
    }
    // Inner cone: the dense, shaded needles close round the trunk, with a
    // few holes of sky.
    {
        float coreW = maxR * pow(clamp(1.0 - hN, 0.0, 1.0), 0.9) * 0.50;
        float dx = abs(q.x - tx) / max(coreW, 1e-3);
        float holes = smoothstep(0.28, 0.45, fbm3(q * 30.0 + seed));
        float core = smoothstep(1.0, 0.6, dx + (fbm3(q * 60.0) - 0.5) * 0.5) * holes * step(0.12, hN) * step(hN, 0.97);
        if (core > bestEnv) { bestEnv = core; bestTop = 0.0; bestInner = 0.9; bestSide = 0.0; }
    }
    // Leader: the top shoot and its tuft.
    vec2 topP = vec2(bx + 0.006 * sin(4.0 + seed), topY + 0.004);
    float lead = smoothstep(1.0, 0.5, length((q - topP - vec2(0.0, 0.018)) / vec2(0.010, 0.030)) + (fbm3(q * 90.0) - 0.5) * 0.6);
    if (lead > bestEnv) { bestEnv = lead; bestTop = 0.6; bestInner = 0.3; bestSide = 0.0; }

    if (bestEnv > 0.0) {
        float shade;
        float nd = needles(q, 0.55 + 0.45 * bestEnv, seed * 3.7, shade);
        float m = max(smoothstep(0.75, 1.0, bestEnv), nd * bestEnv);
        float sunSide = bestSide * sign(gBody.x - bx);
        float lit = (0.35 + 0.45 * max(bestTop, 0.0) + 0.25 * sunSide) * (1.0 - bestInner * 0.6) * bodyStr;
        vec3 nc = needleCol * (0.75 + 0.45 * shade);
        vec3 pc = nc * (skyAmb * (0.7 + 0.35 * bestTop) * 1.15 * (1.0 - bestInner * 0.45) + gSunLight * max(lit, 0.0) * 0.95);
        pc *= mix(0.5, 1.0, smoothstep(-0.9, 0.3, bestTop));
        pc = mix(pc, snowCol * (0.85 + 0.3 * shade), snowFall * smoothstep(0.0, 0.5, bestTop) * smoothstep(0.25, 0.6, shade + 0.25) * 0.95);
        col = mix(col, pc, m);
        cov = max(cov, m);
    }
    return vec4(col, cov);
}

// Shrubs on the near meadow, grown from stems rather than stamped as blobs.
// Juniper (kind 0): several upright leaders of different heights clumped
// together, blue-green needles, a narrow, flame-like, uneven outline.
// Deciduous bush (kind 1): stems fanning out and arching from one root,
// leaf clusters strung along them, so the outline is lobed and twiggy,
// with bare stems showing low down and in winter; red berries in autumn.
vec4 shrub(vec2 p, vec2 base, float w, float h, float kind, float seed) {
    if (abs(p.x - base.x) > w * 0.9 + h * 0.5 || p.y < base.y - h * 1.7 || p.y > base.y + 0.02) return vec4(0.0);
    float hN = clamp((base.y - p.y) / h, 0.0, 1.3);
    vec2 q = vec2(p.x - treeSway(hN, seed) * 0.45, p.y);
    vec3 skyAmb = mix(gSkyTop, gSkyLow, 0.5);
    float bodyStr = gIsDay ? gDaylight * (1.0 - gGloom * 0.7) : 0.2 * (1.0 - gGloom);
    vec3 L = normalize(vec3(gBody.x - p.x, p.y - gBody.y, 0.5));
    float snowFall = clamp(wxSnow * 1.3 + gCold * 0.2 - 0.1, 0.0, 1.0);
    vec3 stemCol = mix(bgColor.rgb, mutedColor.rgb, 0.3) * 0.45 * skyAmb * 1.3;

    vec3 col = vec3(0.0);
    float cov = 0.0;
    float field = 0.0;
    vec2 grad = vec2(0.0);
    int stems = kind < 0.5 ? 8 : 8;
    float stemD = 1e3;
    for (int i = 0; i < 8; i++) {
        if (i >= stems) break;
        float fi = float(i);
        float h1 = hash1(fi * 1.7 + seed), h2 = hash1(fi * 3.9 + seed), h3 = hash1(fi * 5.3 + seed);
        vec2 s0 = base + vec2((h1 - 0.5) * w * (kind < 0.5 ? 0.40 : 0.22), 0.0);
        vec2 s1, sc;
        if (kind < 0.5) {
            // Upright leaders, the middle ones tallest.
            // Outer leaders are shorter and splay out; the middle ones
            // are tallest -- a flame, not a slab.
            float lean = (h1 - 0.5) * 0.9;
            float len = h * (0.40 + 0.60 * h2) * (1.0 - abs(h1 - 0.5) * 1.1);
            s1 = s0 + vec2(lean * len, -len);
            sc = mix(s0, s1, 0.5) + vec2((h3 - 0.5) * 0.015, 0.0);
        } else {
            // Fanned stems that arch outward and droop at the tips.
            float ang = -1.5708 + (fi / float(stems - 1) - 0.5) * 2.2 + (h3 - 0.5) * 0.3;
            float len = h * (0.75 + 0.45 * h2);
            vec2 dir = vec2(cos(ang), sin(ang));
            s1 = s0 + dir * len + vec2(0.0, len * 0.25 * abs(dir.x));
            sc = s0 + dir * len * 0.65 - vec2(0.0, len * 0.10);
        }
        // Stems: seen where the foliage is thin.
        float t, ac;
        float d = bezD(q, s0, sc, s1, t, ac);
        float sw = mix(0.0026, 0.0007, t);
        float ms = smoothstep(sw + 0.0007, sw - 0.0003, d);
        stemD = min(stemD, d);
        if (ms > 0.0) { col = mix(col, stemCol, ms * (1.0 - cov)); cov = max(cov, ms); }
        // Foliage clusters along the stem, bigger toward the outside.
        for (int k = 0; k < 4; k++) {
            float fk = float(k);
            float tc = kind < 0.5 ? 0.25 + fk * 0.23 : 0.35 + fk * 0.20;
            vec2 cp = bez(s0, sc, s1, tc);
            float hk = hash1(fi * 7.0 + fk * 2.3 + seed);
            vec2 rr = kind < 0.5 ? vec2(w * 0.22 * (1.25 - tc * 0.85), h * 0.22) * (0.75 + 0.5 * hk)
                                 : vec2(w * 0.15, h * 0.18) * (0.65 + 0.25 * fk) * (0.8 + 0.4 * hk);
            vec2 dq = (q - cp - vec2(0.0, kind < 0.5 ? 0.0 : -rr.y * 0.3)) / rr;
            float kk = exp(-dot(dq, dq));
            field += kk;
            grad += kk * dq / rr;
        }
    }

    float edgeN = (fbm3(q * 70.0 + seed) - 0.5) * 0.8;
    float level = field + edgeN;
    float leafy = kind < 0.5 ? 1.0 : gLeaf;
    float shade;
    float tex = kind < 0.5 ? needles(q, 0.55 + 0.45 * smoothstep(0.3, 0.9, level), seed, shade)
                           : leafDots(q, 0.0060, leafy * smoothstep(0.15, 0.5, level), seed, shade);
    float inner = smoothstep(0.6, 1.1, level) * leafy;
    float deep = kind < 0.5 ? inner : leafDots(q + 0.0027, 0.0060, inner * 0.9, seed * 2.3, shade);
    float mass = max(tex * smoothstep(0.15, 0.45, level), deep * 0.9);
    if (mass > 0.0) {
        vec3 n = normalize(vec3(-grad.x * 0.02, grad.y * 0.02, 1.0));
        float lit = clamp(dot(n, L), 0.0, 1.0) * bodyStr;
        float topness = clamp(-grad.y * 0.01, -1.0, 1.0);
        vec3 fol = kind < 0.5 ? gFoliage * vec3(0.62, 0.82, 0.92) * (0.7 + 0.45 * shade)
                              : seasonTint(gFoliage * (0.75 + 0.45 * shade), 0.02, 0.0);
        vec3 fc = fol * (skyAmb * (0.8 + 0.3 * topness) * 1.15 + gSunLight * lit * 0.9);
        fc *= mix(0.45, 1.0, smoothstep(0.0, 0.35, hN));                  // shade at the root
        fc *= mix(0.8, 1.0, tex);                                          // depth behind the edge
        fc = mix(fc, mix(fgColor.rgb, gSkyLow, 0.3) * (0.45 + 0.5 * gDaylight), snowFall * smoothstep(0.1, 0.6, topness) * 0.9);
        col = mix(col, fc, mass);
        cov = max(cov, mass);
    }
    // Berries in autumn on the deciduous bush, a few left into winter.
    if (kind > 0.5) {
        float berrySeason = smoothstep(0.66, 0.74, fract(season)) * (1.0 - smoothstep(0.95, 1.0, fract(season)))
                          + (1.0 - smoothstep(0.02, 0.10, fract(season))) * 0.5;
        // Bare bush: berries only where they hang from a stem.
        bool onStem = gLeaf > 0.4 || stemD < 0.0045;
        if (berrySeason > 0.01 && level > 0.35 && onStem) {
            vec2 g = q / 0.006;
            vec2 id = floor(g);
            float hb = hash21(id + seed * 3.0);
            if (hb < 0.045 * berrySeason) {
                vec2 ctr = id + 0.5 + (vec2(hash21(id + 1.3), hash21(id + 4.1)) - 0.5) * 0.6;
                float bd = length(g - ctr);
                float bm = smoothstep(0.30, 0.20, bd);
                vec3 berry = hsv2rgb(vec3(0.99, 0.80, 0.70)) * (skyAmb * 1.1 + gSunLight * bodyStr * 0.8);
                berry += fgColor.rgb * smoothstep(0.12, 0.0, length(g - ctr - vec2(-0.08, -0.08))) * 0.35 * bodyStr;
                col = mix(col, berry, bm);
                cov = max(cov, bm);
            }
        }
    }
    // Juniper berries: a sprinkle of dusty blue-black cones all year.
    if (kind < 0.5 && level > 0.55) {
        vec2 g = q / 0.0045;
        vec2 id = floor(g);
        if (hash21(id + seed * 5.0) < 0.035) {
            vec2 ctr = id + 0.5 + (vec2(hash21(id + 2.3), hash21(id + 6.1)) - 0.5) * 0.6;
            float bd = length(g - ctr);
            float bm = smoothstep(0.30, 0.20, bd);
            vec3 berry = hsv2rgb(vec3(0.62, 0.35, 0.30)) * (skyAmb * 1.2 + gSunLight * bodyStr * 0.5);
            berry += mix(fgColor.rgb, skyAmb, 0.5) * 0.15;                   // the waxy bloom
            col = mix(col, berry, bm);
            cov = max(cov, bm);
        }
    }
    return vec4(col, cov);
}

// Point on a quadratic Bezier.
vec2 qbez(vec2 a, vec2 c, vec2 b, float t) {
    return mix(mix(a, c, t), mix(c, b, t), t);
}

// A bird in flight seen from the side, `span` = half wingspan. Each wing is
// two curved strokes -- shoulder to wrist, wrist to tip -- tapering to a
// point, so the silhouette is the familiar arched "M". `beat` drives the
// flap: the wrist leads and the tip follows a little later, so the wing
// bends through the stroke. `glide` (0..1) holds the wings in a shallow arch.
// `raptor` gives broad wings with spread, fingered tips and a fanned tail.
float birdShape(vec2 p, vec2 c, float span, float beat, float glide, float dir, float raptor) {
    vec2 q = (p - c) / span;
    if (dot(q, q) > 2.6) return 0.0;
    float px = 1.0 / (span * 1440.0);                    // one screen pixel, in bird units
    float flapW = sin(beat);
    float flapT = sin(beat - 0.9);
    float wristY = mix(-0.34 * flapW - 0.06, -0.10 - raptor * 0.06, glide);
    float tipY = mix(-0.58 * flapT + 0.05, 0.02 - raptor * 0.12, glide);
    float thick = mix(0.075, 0.13, raptor);
    float best = 0.0;
    for (int sd = 0; sd < 2; sd++) {
        float side = sd == 0 ? -1.0 : 1.0;
        vec2 sh = vec2(side * 0.07, 0.0);
        vec2 wr = vec2(side * mix(0.46, 0.44, raptor), wristY);
        vec2 tp = vec2(side * 1.0, tipY);
        vec2 c1 = vec2(side * 0.24, wristY * 0.4 - 0.10);      // leading edge arches
        vec2 c2 = vec2(side * 0.74, mix(wristY, tipY, 0.3) - 0.04);
        vec2 prev = sh;
        for (int s2 = 1; s2 <= 8; s2++) {
            float t = float(s2) / 8.0;
            vec2 cur = t <= 0.5 ? qbez(sh, c1, wr, t * 2.0) : qbez(wr, c2, tp, t * 2.0 - 1.0);
            float h;
            float d = segD(q, prev, cur, h);
            float along = (float(s2 - 1) + h) / 8.0;
            float w = thick * (1.0 - along * mix(0.85, 0.55, raptor));
            best = max(best, smoothstep(w + px, w - px * 0.5, d));
            prev = cur;
        }
        // Fingered primaries on the raptor's wingtips.
        if (raptor > 0.5) {
            for (int f = 0; f < 4; f++) {
                float ff = float(f);
                vec2 base = tp - vec2(side * 0.10, 0.0) + vec2(0.0, ff * 0.035);
                vec2 fend = base + vec2(side * 0.16, -0.05 + ff * 0.03);
                float h;
                float d = segD(q, base, fend, h);
                best = max(best, smoothstep(0.03 + px, 0.03 - px * 0.5, d));
            }
        }
    }
    // Body with a head leading and a tail trailing.
    vec2 bq = q * vec2(dir, 1.0);
    float body = length((bq - vec2(0.02, 0.03)) / vec2(0.22, 0.075));
    float head = length((bq - vec2(0.24, 0.0)) / vec2(0.07, 0.06));
    vec2 tq = bq - vec2(-0.26, 0.05);
    float tail = length(tq / vec2(mix(0.12, 0.10, raptor), mix(0.045, 0.09, raptor)));
    best = max(best, smoothstep(1.0 + px * 6.0, 1.0 - px * 3.0, min(min(body, head), tail)));
    return best;
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
    gGloom = clamp(wxCloud * 0.30 + gStorm * 0.45 + wxFog * 0.25 + smoothstep(0.55, 1.0, wxRain) * 0.15 + smoothstep(0.55, 1.0, wxSnow) * 0.15, 0.0, 0.88);
    // Negative: sampling at x + drift moves features the other way.
    gDrift = -windTravel;
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
    // Deep snow buries it too.
    gGrassAmt = smoothstep(-15.0, -6.0, wxTemp) * (1.0 - smoothstep(0.3, 0.8, wxSnow) * 0.9);
    gGrassH = mix(0.35, 1.0, smoothstep(-15.0, 3.0, wxTemp)) * (1.0 - clamp(wxSnow * 1.1, 0.0, 1.0) * 0.7);
    gDry = max(gDry, 1.0 - smoothstep(-8.0, 2.0, wxTemp));
    // High summer: taller, thicker, greener grass.
    gLush = smoothstep(0.38, 0.46, sN) * (1.0 - smoothstep(0.62, 0.71, sN)) * smoothstep(4.0, 12.0, wxTemp);
    gGrassH *= 1.0 + 0.45 * gLush;
    gWindS = pow(clamp(wxWind, 0.0, 1.0), 0.8);
    gWindDir = windSide;
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

        // Fish rising: now and then a ring spreads from where a fish took
        // something off the surface -- a small splash, then a train of
        // rings seen in perspective. Most at dawn and dusk, in calm water,
        // never under ice.
        float fishHi = 0.0;
        float splash = 0.0;
        {
            float dawnDusk = gIsDay ? 1.0 - 0.75 * sin(PI * clamp(sunPhase, 0.0, 1.0)) : 0.30;
            float fishActive = dawnDusk * (1.0 - gWindS * 0.85) * smoothstep(1.0, 5.0, wxTemp)
                         * (1.0 - wxRain * 0.6) * (1.0 - gStorm);
            for (int i = 0; i < 6; i++) {
                float fi = float(i);
                float period = 6.0 + fi * 2.7;
                float tt = time + fi * 5.3;
                float id = floor(tt / period);
                float age = tt - id * period;
                if (age > 4.5 || hash21(vec2(id, fi * 3.1)) > fishActive * 0.85) continue;
                float x0 = (hash21(vec2(id + 1.7, fi)) - 0.5) * 2.0 * gHalfW * 0.85;
                float shoreAt = 0.405 + 0.028 * fbm3(vec2(x0 * 1.3, 9.0)) + 0.018 * sin(x0 * 0.9 + 1.0);
                float y0 = WL + 0.006 + pow(hash21(vec2(id + 4.2, fi)), 1.4) * max(shoreAt - WL - 0.016, 0.01);
                float nearF = clamp((y0 - WL) / 0.13, 0.0, 1.0);
                float scale = mix(0.22, 1.0, nearF);
                float squash = clamp((y0 - WL) * 2.8 + 0.07, 0.08, 0.40);
                vec2 dq = vec2(p.x - x0, (p.y - y0) / squash) / scale;
                float d = length(dq);
                float r = age * 0.040;
                float x = d - r;
                float wave = sin(x * 420.0) * exp(-pow((x + 0.010) / 0.016, 2.0))
                           * exp(-age * 0.85) * smoothstep(0.0, 0.004, r) * step(x, 0.004);
                ripple += normalize(dq + 1e-5) * wave * 0.0035 * scale;
                fishHi += abs(wave);
                splash += exp(-age * 7.0) * exp(-d * d / 0.00004);
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
        // Ring crests catch the sky; the splash glints.
        col += mix(fgColor.rgb, gSkyLow, 0.5) * fishHi * 0.14 * (0.35 + 0.65 * gDaylight + 0.3 * gTwilight);
        col += mix(fgColor.rgb, gSkyLow, 0.3) * clamp(splash, 0.0, 1.0) * 0.5 * (0.4 + 0.6 * gDaylight);

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
                    if (h > (0.35 + 0.75 * clump + 0.45 * gLush) * gGrassAmt) continue;
                    float inv = rowInv + (hash1(seedB + 1.9) - 0.5) * rowStep;
                    float rootX = (cell + hash1(seedB + 5.3)) * CELL_W;
                    float rx = rootX * inv;
                    float ry = WL + CAM_H * inv;
                    float hb = BLADE_H * inv * (0.45 + 0.9 * hash1(seedB + 2.1)) * (0.55 + 0.7 * clump) * gGrassH;
                    // Wind: gust fronts roll across in world space; strong wind
                    // lays the blades over and makes them thrash.
                    float gust = fbm3(vec2(rootX * 5.0 - time * (0.35 + 2.2 * gWindS) * gWindDir, inv * 0.35));
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
                    bh3.y = min(bh3.y * (1.0 + 0.35 * gLush), 1.0);
                    bh3.z *= 1.0 + 0.15 * gLush;
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
    float summer = smoothstep(0.42, 0.48, fract(season)) * (1.0 - smoothstep(0.62, 0.68, fract(season)));
    float warmNight = gNight * summer * smoothstep(10.0, 16.0, wxTemp) * (1.0 - wxRain) * (1.0 - wxWind * 0.8);
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
    // A flock in a loose V, each bird flapping on its own beat and gliding
    // between bursts, and on some days a bird of prey circling on a thermal.
    float fair = max(gDaylight * (1.0 - wxRain) * (1.0 - gStorm) * (1.0 - wxFog), eggBirds * 0.8);
    if (fair > 0.05 && p.y < WL) {
        float birds = 0.0;
        float fl = floor(time / 80.0);
        float ph = fract(time / 80.0) / 0.45;
        if (eggBirds > 0.5) { fl = floor(time / 36.0); ph = fract(time / 36.0); }
        if (ph < 1.0 && (hash1(fl * 3.7) > 0.3 || eggBirds > 0.5)) {
            float dir = hash1(fl * 1.9) > 0.5 ? 1.0 : -1.0;
            // Birds fly into the wind a little slower, with it a little faster.
            vec2 lead = vec2(dir * mix(-gHalfW - 0.25, gHalfW + 0.25, ph),
                             -0.30 + hash1(fl * 2.2) * 0.14 + sin(ph * 6.0) * 0.02);
            if (abs(p.x - lead.x) < 0.30 && abs(p.y - lead.y) < 0.14) {
                int count = 5 + int(hash1(fl * 4.4) * 4.0);
                for (int i = 0; i < 9; i++) {
                    if (i >= count) break;
                    float fi = float(i);
                    float k = floor((fi + 1.0) * 0.5);
                    float wing = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
                    vec2 off = vec2(-dir * k * 0.034, wing * k * 0.013 + k * 0.004);
                    off += vec2(sin(time * 0.7 + fi * 2.0), cos(time * 0.9 + fi)) * 0.005;
                    float span = 0.013 * (0.85 + 0.3 * hash1(fi + fl));
                    // Flap in bursts, glide in between.
                    float beat = time * (7.5 + hash1(fi * 3.3) * 2.0) + fi * 1.7;
                    float glide = smoothstep(0.25, 0.75, sin(time * 0.35 + fi * 1.3) * 0.5 + 0.5);
                    birds = max(birds, birdShape(p, lead + off, span, beat, glide, dir, 0.0));
                }
            }
        }
        // A buzzard or eagle, soaring in wide circles on still, clear days.
        float raptorDay = max(smoothstep(0.35, 0.7, vnoise(vec2(time / 600.0, 9.0))) * (1.0 - gCover) * (1.0 - gWindS * 0.6), eggBirds);
        if (raptorDay > 0.05) {
            float a = time * 0.11;
            vec2 rc = vec2(-gHalfW * 0.45 + sin(time * 0.013) * 0.3, -0.26);
            vec2 rp = rc + vec2(cos(a) * 0.22, sin(a) * 0.045);
            float rdir = -sin(a) >= 0.0 ? 1.0 : -1.0;
            if (length(p - rp) < 0.08) {
                float beat = time * 4.0;
                float glide = 1.0 - smoothstep(0.93, 1.0, sin(time * 0.21) * 0.5 + 0.5);
                birds = max(birds, birdShape(p, rp, 0.030, beat, glide, rdir, 1.0) * raptorDay);
            }
        }
        col = mix(col, bgColor.rgb * 0.16 + gSkyLow * 0.06, birds * fair * 0.9);
    }

    // ---- precipitation behind the tree ----
    float slant = 2.0 + gWindS * 30.0;
    vec3 rainCol = mix(mutedColor.rgb, fgColor.rgb, 0.45) * (0.55 + 0.45 * gDaylight);
    vec3 snowCol = fgColor.rgb * 1.05;
    if (wxRain > 0.01) {
        vec2 q1 = vec2(p.x * 220.0 - p.y * slant * gWindDir, p.y * 24.0 - time * 7.0);
        vec2 q2 = vec2(p.x * 150.0 - p.y * slant * 1.2 * gWindDir, p.y * 16.0 - time * 10.0);
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

        // A downpour is a different animal: a dense sheet of fine streaks,
        // grey curtains of rain sweeping across with the wind, and the
        // world behind them washed out.
        float heavy = smoothstep(0.55, 1.0, wxRain);
        if (heavy > 0.0) {
            vec2 q3 = vec2(p.x * 330.0 - p.y * slant * 0.9 * gWindDir, p.y * 36.0 - time * 12.0);
            vec2 id3 = floor(q3);
            vec2 f3 = fract(q3);
            if (hash21(id3 + 77.0) < 0.26 * heavy) {
                float j3 = (hash21(id3.yx + 5.0) - 0.5) * 0.7;
                float r3 = smoothstep(0.05, 0.0, abs(f3.x - 0.5 - j3)) * smoothstep(0.0, 0.1, f3.y) * (1.0 - smoothstep(0.55, 0.95, f3.y));
                col += rainCol * r3 * 0.35;
            }
            float curtain = fbm3(vec2((p.x - p.y * slant * 0.02 * gWindDir) * 2.2 - gWindDir * time * (0.25 + 0.9 * gWindS), p.y * 1.4 + time * 0.08));
            vec3 veil = mix(gSkyLow, mix(mutedColor.rgb, fgColor.rgb, 0.35), 0.4) * (0.45 + 0.4 * gDaylight);
            col = mix(col, veil, heavy * (0.16 + 0.34 * smoothstep(0.42, 0.78, curtain)));
        }

        // Splashes: little crowns bursting in the meadow.
        if (wxRain > 0.25 && p.y > shoreY) {
            vec2 g = vec2(p.x * 240.0, p.y * 110.0);
            vec2 gid = floor(g);
            float gh = hash21(gid + 31.0);
            if (gh < wxRain * 0.30) {
                float ph = fract(time * 2.2 + gh * 13.0);
                vec2 ctr = gid + vec2(0.5, 0.7);
                vec2 dd = (g - ctr) * vec2(1.0, 1.8);
                float ring = smoothstep(0.08, 0.0, abs(length(dd) - ph * 0.45)) * step(dd.y, 0.02) * (1.0 - ph);
                col += rainCol * ring * 0.55;
            }
        }
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

    // ---- framing trees: birches on the left, a pine on the right ----
    vec4 tB = birch(p, -gHalfW + 0.30, -0.46, 1.0, 3.0);
    col = mix(col, tB.rgb, tB.a);
    vec4 tO = pine(p, gHalfW - 0.34, -0.42, 3.0);
    col = mix(col, tO.rgb, tO.a);

    // ---- shrubs on the near meadow ----
    vec4 sh;
    sh = shrub(p, vec2(-gHalfW + 0.66, 0.545), 0.20, 0.17, 0.0, 11.0);  col = mix(col, sh.rgb, sh.a);
    sh = shrub(p, vec2(-gHalfW + 0.06, 0.560), 0.30, 0.16, 1.0, 12.0);  col = mix(col, sh.rgb, sh.a);
    sh = shrub(p, vec2(-0.72, 0.555), 0.26, 0.13, 1.0, 13.0);          col = mix(col, sh.rgb, sh.a);
    sh = shrub(p, vec2(0.66, 0.555), 0.28, 0.14, 1.0, 14.0);           col = mix(col, sh.rgb, sh.a);
    sh = shrub(p, vec2(gHalfW - 0.70, 0.545), 0.16, 0.20, 0.0, 15.0);  col = mix(col, sh.rgb, sh.a);

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
        vec2 q = vec2(p.x * 90.0 - p.y * slant * 1.4 * gWindDir, p.y * 10.0 - time * 13.0);
        vec2 id = floor(q);
        vec2 f = fract(q);
        if (hash21(id + 57.0) < 0.05 * wxRain) {
            float jitter = (hash21(id.yx + 97.0) - 0.5) * 0.7;
            float r = smoothstep(0.08, 0.0, abs(f.x - 0.5 - jitter))
                    * smoothstep(0.0, 0.12, f.y) * (1.0 - smoothstep(0.50, 0.95, f.y));
            col += rainCol * r * (0.22 + gFlash * 0.4);
        }
        // Big, close, fast streaks in a downpour.
        float heavyF = smoothstep(0.6, 1.0, wxRain);
        if (heavyF > 0.0) {
            vec2 qn = vec2(p.x * 42.0 - p.y * slant * 1.8 * gWindDir, p.y * 5.0 - time * 16.0);
            vec2 idn = floor(qn);
            vec2 fn = fract(qn);
            if (hash21(idn + 91.0) < 0.07 * heavyF) {
                float jn = (hash21(idn.yx + 13.0) - 0.5) * 0.6;
                float rn = smoothstep(0.10, 0.0, abs(fn.x - 0.5 - jn)) * smoothstep(0.0, 0.15, fn.y) * (1.0 - smoothstep(0.45, 0.9, fn.y));
                col += rainCol * rn * 0.30;
            }
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
            q.x -= time * windX * gWindDir * (1.0 + float(layer) * 0.3);
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

        // A blizzard: snow driven sideways in streaks, white-out curtains
        // rolling through, and spindrift racing along the ground and ice.
        float heavyS = smoothstep(0.55, 1.0, wxSnow);
        if (heavyS > 0.0) {
            float drive = 0.8 + gWindS * 6.0;
            for (int layer = 0; layer < 2; layer++) {
                float fl2 = float(layer);
                float sc = layer == 0 ? 95.0 : 48.0;
                vec2 qd = vec2(p.x * sc - p.y * sc * 0.25 * drive * gWindDir * 0.3, p.y * sc * 0.35);
                qd += vec2(-time * drive * (12.0 + fl2 * 8.0) * gWindDir, -time * (6.0 + fl2 * 4.0));
                vec2 idd = floor(qd);
                vec2 fd = fract(qd);
                if (hash21(idd + 55.0 + fl2 * 9.0) < (0.45 - fl2 * 0.12) * heavyS) {
                    vec2 cd = fd - 0.5 - (vec2(hash21(idd + 3.0), hash21(idd + 8.0)) - 0.5) * 0.5;
                    // Streaked along the direction of travel: the harder it
                    // blows, the longer the streak.
                    float streak = length(cd / vec2(0.12 + 0.40 * gWindS, 0.07 + fl2 * 0.03));
                    col = mix(col, snowCol, smoothstep(1.0, 0.35, streak) * (0.65 + fl2 * 0.25) * heavyS);
                }
            }
            // Big flakes whipping past right in front, soft with nearness.
            {
                vec2 qb = p * 11.0 + vec2(-time * drive * 1.6 * gWindDir, -time * 1.4);
                vec2 idb = floor(qb);
                vec2 fb = fract(qb);
                if (hash21(idb + 71.0) < 0.22 * heavyS) {
                    vec2 cb = fb - 0.5 - (vec2(hash21(idb + 1.1), hash21(idb + 2.2)) - 0.5) * 0.5;
                    float db = length(cb / vec2(0.07 + 0.10 * gWindS, 0.05));
                    col = mix(col, snowCol, smoothstep(1.0, 0.2, db) * 0.55 * heavyS);
                }
            }
            float curtain = fbm3(vec2(p.x * 1.8 - gWindDir * time * (0.3 + 1.2 * gWindS), p.y * 1.2 + time * 0.05));
            vec3 whiteout = mix(gSkyLow, fgColor.rgb, 0.55) * (0.55 + 0.35 * gDaylight);
            col = mix(col, whiteout, heavyS * (0.30 + 0.50 * smoothstep(0.35, 0.80, curtain)));
            if (p.y > WL) {
                float low = smoothstep(WL, 0.5, p.y);
                float drift2 = fbm3(vec2(p.x * 6.0 - gWindDir * time * (1.0 + 3.0 * gWindS), p.y * 40.0));
                col = mix(col, whiteout * 1.05, heavyS * (0.4 + low) * smoothstep(0.40, 0.80, drift2) * 0.7);
            }
        }
    }

    // ---- fog over everything, thickest low ----
    float lowness = smoothstep(-0.35, WL + 0.06, p.y);
    float banks = smoothstep(0.30, 0.78, fbm3(vec2(p.x * 1.3 - time * 0.018 * gWindDir, p.y * 6.0 + 1.7)));
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
