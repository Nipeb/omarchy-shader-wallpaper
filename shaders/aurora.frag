#version 440

// Aurora -- curtains ("slør") of light hanging in the night sky. Each curtain
// is a ribbon whose lower edge meanders and folds across the screen; from
// that sharp, bright hem, fine vertical rays climb and fade upward, each to
// its own height, so the top of the curtain frays into streaks instead of
// ending on a line. Where a fold turns edge-on you look through more of the
// sheet, so it burns brighter there, and surges of light travel along the
// arc. Colour is anchored on the theme accent; the hem and the crown are
// hue-shifted from it, the way a real aurora's pink hem and red crown sit
// either side of its green body. The old slow haze still hangs behind
// everything, so it keeps its weight.

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
    float audioLevel;
    float audioPeak;
    float auroraTime;
    float iconWarpScale;
    float edgeGlowWidth;
    float edgeGlowBrightness;
    float auroraHueSpread;
    float auroraRays;
};

layout(binding = 1) uniform sampler2D maskSource;
layout(binding = 2) uniform sampler2D distSource;

// ---------------------------------------------------------------- noise ---

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return v;
}

float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.55; }
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

// The accent's hue turned by `deg`, with saturation and value scaled.
vec3 shifted(vec3 hsv, float deg, float satMul, float valMul) {
    return hsv2rgb(vec3(fract(hsv.x + deg / 360.0),
                        clamp(hsv.y * satMul, 0.0, 1.0),
                        clamp(hsv.z * valMul, 0.0, 1.0)));
}

// --------------------------------------------------------------- curtain ---

// Height of a curtain's hem at horizontal position x. A slow meander carries
// the whole sheet across the sky; three fold waves of rising frequency roll
// along it, which is what makes it drape rather than just drift.
float curtainBase(float x, float baseY, float seed, float t) {
    float meander = (fbm3(vec2(x * 0.32 + seed * 1.7, t * 0.016 + seed)) - 0.5) * 0.36;
    float folds = sin(x * 2.1 + seed * 3.1 - t * 0.19) * 0.050
                + sin(x * 4.7 + seed * 5.3 - t * 0.37) * 0.020
                + sin(x * 9.3 + seed * 2.2 - t * 0.63) * 0.007;
    // Fine crinkle, so the hem kinks and ripples instead of being one
    // perfectly smooth line.
    float crinkle = (vnoise(vec2(x * 14.0 + seed * 9.0, t * 0.35)) - 0.5) * 0.013;
    return baseY + meander + folds + crinkle;
}

// Emission of one curtain at p. hFrac is height above the hem as a fraction
// of the curtain's height, for colouring by altitude.
float curtain(vec2 p, float baseY, float height, float seed, float t, out float hFrac) {
    float yb = curtainBase(p.x, baseY, seed, t);
    const float e = 0.006;
    float slope = (curtainBase(p.x + e, baseY, seed, t) - yb) / e;

    float h = yb - p.y;               // height above the hem; up is -y
    hFrac = h / height;

    // Soft light scattered into the air around the whole sheet, above and
    // below the hem -- the glow the sky picks up from it.
    float scatter = (h > 0.0 ? exp(-h / (height * 0.50)) : exp(h / (height * 0.10))) * 0.035;
    if (h < -0.05 || hFrac > 1.8) return scatter;

    // Rays: vertical striations along the sheet, drifting along it and
    // flickering, each with its own length -- that uneven fringe at the top
    // is what reads as a veil instead of a band.
    float rx = p.x * 52.0 + seed * 13.0 - t * 0.55;
    float r1 = vnoise(vec2(rx, t * 0.85 + seed));
    float r2 = vnoise(vec2(rx * 2.4 + 7.0, t * 1.6 - seed));
    float ray = smoothstep(0.2, 0.9, r1 * 0.62 + r2 * 0.38);
    float rayLen = height * mix(1.0, mix(0.28, 1.0, ray), auroraRays);
    float strength = mix(1.0, mix(0.45, 1.2, ray), auroraRays);

    // Sharp lower edge, with its brightest band right on the hem.
    float hem = smoothstep(-0.010, 0.006, h);
    float hemBand = exp(-max(h, 0.0) / (height * 0.06)) * 0.9;
    float rise = exp(-max(h, 0.0) / (rayLen * 0.42));
    float sheet = hem * (rise * strength + hemBand);

    // Where the sheet folds edge-on you look through more of it.
    float fold = 1.0 + min(abs(slope) * 1.8, 2.4);

    // Surges of brightness gliding along the arc.
    float surge = 0.55 + 0.75 * pow(0.5 + 0.5 * sin(p.x * 1.15 - t * 0.48 + seed * 2.0), 3.0);

    // Segments: a real arc is bright in stretches and fades out in others,
    // so several sheets never read as parallel stripes across the sky.
    float seg = smoothstep(0.24, 0.62, fbm3(vec2(p.x * 0.23 + seed * 3.7, t * 0.010 + seed)));

    return (sheet * fold * surge + scatter) * seg;
}

// One curtain's coloured light: altitude colouring (shifted hem, accent
// body, shifted crown), a slow hue drift along the arc so sections of one
// sheet differ, and haze for the far ones.
vec3 curtainLight(vec2 p, float baseY, float height, float gain, float seed,
                  float haze, float t, vec3 mainCol, vec3 hemCol, vec3 crownCol,
                  vec3 sky, float spread) {
    float hFrac;
    float em = curtain(p, baseY, height, seed, t, hFrac);
    if (em <= 0.0005) return vec3(0.0);

    vec3 c = mix(hemCol, mainCol, smoothstep(0.0, 0.14, hFrac));
    c = mix(c, crownCol, smoothstep(0.42, 1.05, hFrac));

    float drift = (fbm3(vec2(p.x * 0.28 + seed, t * 0.012)) - 0.5) * spread * 0.9;
    vec3 ch = rgb2hsv(c);
    c = hsv2rgb(vec3(fract(ch.x + drift / 360.0), ch.y, ch.z));

    c = mix(c, mix(c, sky, 0.6), haze);
    return c * em * gain;
}

// ------------------------------------------------------------------ stars ---

float stars(vec2 p) {
    vec2 q = p * 38.0;
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash(id + 3.1);
    if (h < 0.965) return 0.0;
    vec2 jit = vec2(hash(id + 7.7), hash(id + 1.3)) - 0.5;
    float d = length(f - jit * 0.8);
    float tw = 0.6 + 0.4 * sin(time * (0.6 + h * 2.0) + h * 80.0);
    return (1.0 - smoothstep(0.0, 0.07, d)) * tw;
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;
    p.x *= aspect;
    // auroraTime is integrated by the host: music nudges its rate a few
    // percent, keeping phase continuous instead of jumping the curtains.
    float t = auroraTime;

    // ---- icon lookup + the flow field that bends the sky around it ----
    float iconScale = 0.62;
    vec2 iconUV = p / iconScale + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float sdfHere = inIcon ? texture(distSource, iconUV).r : 0.0;

    vec2 warp = vec2(0.0);
    // Outline from the mask's own alpha edge, not the SDF's 0.5 contour: a
    // thin filament never reaches a true interior plateau in the distance
    // field, so that contour bloomed unevenly on the fine knotwork.
    float edge = 0.0;
    if (inIcon) {
        float texel = 1.0 / 1024.0;
        float dl = texture(distSource, clamp(iconUV - vec2(texel, 0.0), 0.0, 1.0)).r;
        float dr = texture(distSource, clamp(iconUV + vec2(texel, 0.0), 0.0, 1.0)).r;
        float du = texture(distSource, clamp(iconUV - vec2(0.0, texel), 0.0, 1.0)).r;
        float dd = texture(distSource, clamp(iconUV + vec2(0.0, texel), 0.0, 1.0)).r;
        vec2 gradSdf = vec2(dr - dl, dd - du);
        vec2 tangent = normalize(vec2(-gradSdf.y, gradSdf.x) + 1e-5);
        // Inside the outline only: abs() here made the weight symmetric about
        // the edge, bending the sky on the outside of the mark as well. The
        // sdf is 0.5 exactly on the outline and above it inside, so a narrow
        // ramp across 0.5 keeps the warp on the mark and nothing beyond it.
        float inside = smoothstep(0.495, 0.515, sdfHere);
        float edgeWeight = smoothstep(0.5, 0.0, abs(sdfHere - 0.5)) * inside;
        float boxFade = smoothstep(1.0, 0.75, max(abs(iconUV.x - 0.5), abs(iconUV.y - 0.5)) * 2.0);
        warp = tangent * edgeWeight * boxFade * (0.06 + 0.03 * sin(t * 0.6) + audioLevel * 0.005) * iconWarpScale;

        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        edge = clamp(length(vec2(aR - aL, aD - aU)), 0.0, 1.0);
    }
    vec2 pw = p + warp;

    // ---- palette ----
    // The body is the accent; hem and crown are turned either side of it on
    // the colour wheel. A near-grey accent has no hue to turn, so there the
    // extra colour leans on the theme's urgent tone instead.
    vec3 mainCol = mix(accentColor.rgb, fgColor.rgb, 0.08);
    vec3 mainHsv = rgb2hsv(mainCol);
    mainHsv.y = clamp(mainHsv.y * 1.25, 0.0, 1.0);
    mainCol = hsv2rgb(mainHsv);
    float spread = auroraHueSpread;
    float greyness = 1.0 - smoothstep(0.08, 0.30, mainHsv.y);
    vec3 hemCol = shifted(mainHsv, -spread * 0.85, 1.40, 1.30);
    vec3 crownCol = shifted(mainHsv, spread, 1.35, 0.95);
    hemCol = mix(hemCol, mix(urgentColor.rgb, fgColor.rgb, 0.35), greyness * 0.6);
    crownCol = mix(crownCol, urgentColor.rgb, 0.15 + greyness * 0.45);

    // ---- night sky ----
    vec3 sky = mix(bgColor.rgb * 0.55, bgColor.rgb * 0.95, smoothstep(-0.5, 0.5, p.y));
    vec3 col = sky + mix(fgColor.rgb, mainCol, 0.3) * stars(p) * 0.55;

    // ---- the heavy haze: the old aurora, now the weather behind the veil ----
    vec2 flow = vec2(fbm(pw * 1.4 + vec2(0.0, t * 0.06)),
                     fbm(pw * 1.4 + vec2(5.2, t * 0.05)));
    float bands = fbm(vec2(pw.x * 1.8 + flow.x * 1.2, pw.y * 0.6 - t * 0.09 + flow.y));
    bands = smoothstep(0.15 - audioLevel * 0.006, 0.85, bands);
    col = mix(col, mix(mainCol, crownCol, 0.35) * 0.52, bands * 0.55);

    // ---- curtains, far to near ----
    // Far sheets sit higher, are shorter and hazier; the nearest hangs low
    // and tall across the tree. (Unrolled on purpose: the shell runs on
    // OpenGL and picks the GLSL 1.x variant of the .qsb, which has no
    // constant arrays.)
    vec3 light = vec3(0.0);
    light += curtainLight(pw, -0.27, 0.24, 0.19, 1.3,  0.50, t, mainCol, hemCol, crownCol, sky, spread);
    light += curtainLight(pw, -0.06, 0.34, 0.30, 4.7,  0.30, t, mainCol, hemCol, crownCol, sky, spread);
    light += curtainLight(pw,  0.10, 0.44, 0.41, 8.2,  0.12, t, mainCol, hemCol, crownCol, sky, spread);
    light += curtainLight(pw,  0.30, 0.62, 0.54, 12.9, 0.0,  t, mainCol, hemCol, crownCol, sky, spread);
    light *= 1.0 + audioLevel * 0.08 + audioPeak * 0.06;
    col += light;

    // ---- the tree ----
    float pulse = 0.5 + 0.5 * sin(t * 0.8);
    vec3 rim = mix(accentColor.rgb, fgColor.rgb, 0.3) * (0.6 + 0.4 * pulse + audioPeak * 0.05);
    col = mix(col, bgColor.rgb * 0.7, mask.a * 0.40);
    col += rim * edge * 0.9 * edgeGlowBrightness;

    // Soft-knee highlight rolloff: folds stacking up compress instead of
    // clipping to white, so they keep their colour.
    float peak = max(col.r, max(col.g, col.b));
    float knee = 0.80;
    if (peak > knee) col *= (knee + (peak - knee) / (1.0 + (peak - knee) * 2.2)) / peak;

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
