#version 440

// Weather -- the sky outside, right now. Fed by the same location and the
// same Open-Meteo source as the Omarchy weather widget: the sun rides a real
// arc from sunrise to sunset and the moon (in its actual phase) from sunset
// to sunrise, the sky grades through day, dusk and night, and the current
// conditions set the clouds, their drift, rain, snow, fog and storms. The
// tree stands on the horizon in the middle of it; snow settles on the
// upward-facing edges of its branches.

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
const float HORIZON = 0.33;
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

// ---------------------------------------------------------------- clouds ---

// High deck: thinner, broken, drifting with the wind.
float highDeck(vec2 p, float drift, float cover) {
    vec2 q = vec2(p.x * 0.95 + drift * 0.6, p.y * 2.3);
    vec2 w = vec2(fbm3(q * 0.8 + vec2(drift * 0.2, 0.0)), fbm3(q * 0.8 + vec2(4.3, drift * 0.1)));
    float n = fbm5(q + w * 0.7);
    float thr = mix(0.80, 0.30, cover);
    return smoothstep(thr, thr + 0.24, n);
}

// Low deck: heavy, darker, only when the sky is really closing in.
float lowDeck(vec2 p, float drift, float weight) {
    vec2 q = vec2(p.x * 0.7 + drift, p.y * 1.7 + 3.0);
    vec2 w = vec2(fbm3(q * 0.9), fbm3(q * 0.9 + vec2(7.1, 2.2)));
    float n = fbm5(q + w * 0.9);
    float thr = mix(0.85, 0.34, weight);
    return smoothstep(thr, thr + 0.30, n);
}

// ---------------------------------------------------------- precipitation ---

// One sheet of rain streaks, slanted by the wind, `amount` of cells occupied.
float rainSheet(vec2 p, float xScale, float yScale, float speed, float slant,
                float thick, float amount, float seed) {
    vec2 q = vec2(p.x * xScale + p.y * slant, p.y * yScale - time * speed);
    vec2 id = floor(q);
    vec2 f = fract(q);
    if (hash21(id + seed) > amount) return 0.0;
    float jitter = (hash21(id.yx + seed * 1.7) - 0.5) * 0.7;
    float across = smoothstep(thick, 0.0, abs(f.x - 0.5 - jitter));
    float along = smoothstep(0.0, 0.12, f.y) * (1.0 - smoothstep(0.50, 0.95, f.y));
    return across * along;
}

// One plane of snowflakes, searched over the 3x3 neighbourhood so a flake
// near a cell edge is never clipped by the tile boundary.
float snowLayer(vec2 p, float scale, float fall, float size, float amount,
                float windX, float seed) {
    vec2 q = p * scale;
    q.y -= time * fall;
    q.x -= time * windX;
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
            float s = size * (0.6 + 0.4 * hash21(cell + seed + 11.0));
            best = max(best, 1.0 - smoothstep(s * 0.15, s, d));
        }
    }
    return best;
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;
    p.x *= aspect;
    float halfW = aspect * 0.5;

    // ---- where the sun is ----
    bool isDay = sunPhase < 1.0;
    float dayFrac = clamp(sunPhase, 0.0, 1.0);
    float nightFrac = clamp(sunPhase - 1.0, 0.0, 1.0);
    float arcFrac = isDay ? dayFrac : nightFrac;
    float sunElev = isDay ? sin(PI * dayFrac) : -sin(PI * nightFrac);
    float daylight = smoothstep(-0.06, 0.38, sunElev);
    float twilight = exp(-abs(sunElev) * 5.5);
    // Sunrise glows in the east (left), sunset in the west (right).
    float lowSide = isDay ? (dayFrac < 0.5 ? -1.0 : 1.0) : (nightFrac < 0.5 ? 1.0 : -1.0);
    vec2 bodyPos = vec2(mix(-halfW * 0.88, halfW * 0.88, arcFrac),
                        HORIZON - 0.76 * sin(PI * arcFrac));

    float storminess = max(wxStorm, wxRain * 0.65);
    float gloom = clamp(wxCloud * 0.35 + storminess * 0.45 + wxFog * 0.25, 0.0, 0.8);

    // ---- sky ----
    float up = 1.0 - smoothstep(-0.5, HORIZON + 0.1, p.y);
    vec3 nightTop = bgColor.rgb * 0.30;
    vec3 nightLow = mix(bgColor.rgb, mutedColor.rgb, 0.30) * 0.72;
    vec3 dayTop = mix(bgColor.rgb, mutedColor.rgb, 0.55) + accentColor.rgb * 0.05;
    vec3 dayLow = mix(mutedColor.rgb, fgColor.rgb, 0.28);
    vec3 skyTop = mix(nightTop, dayTop, daylight);
    vec3 skyLow = mix(nightLow, dayLow, daylight);
    // Overcast flattens the gradient and pulls the light down.
    skyTop = mix(skyTop, mix(skyTop, skyLow, 0.6) * 0.85, gloom);
    vec3 col = mix(skyLow, skyTop, up);

    // Twilight: a warm band on the horizon, strongest on the sun's side.
    // Sunset colour: the theme's own warmest tones. Blending accent with
    // urgent cancelled to grey on themes like Everforest (teal + red), so
    // pick the two warmest candidates and push their saturation instead.
    vec3 cA = accentColor.rgb, cB = urgentColor.rgb, cC = fgColor.rgb;
    float sA = warmScore(cA), sB = warmScore(cB), sC = warmScore(cC);
    vec3 best = sA >= sB && sA >= sC ? cA : (sB >= sC ? cB : cC);
    float bestS = max(sA, max(sB, sC));
    vec3 second = best == cA ? (sB >= sC ? cB : cC) : (best == cB ? (sA >= sC ? cA : cC) : (sA >= sB ? cA : cB));
    vec3 duskHsv = rgb2hsv(mix(best, second, 0.35));
    duskHsv.y = clamp(duskHsv.y * 1.45 + 0.08, 0.0, 1.0);
    duskHsv.z = clamp(duskHsv.z * 1.15, 0.0, 1.0);
    vec3 duskCol = hsv2rgb(duskHsv);
    float sideW = smoothstep(-halfW, halfW, p.x * lowSide);
    float band = exp(-max(HORIZON - p.y, 0.0) * 2.2);
    col += duskCol * twilight * band * (0.25 + 0.75 * sideW) * 1.25 * (1.0 - gloom * 0.55);
    // Afterglow: the upper sky picks up a cooler, dimmer version of the glow.
    vec3 afterCol = mix(accentColor.rgb, mutedColor.rgb, 0.35);
    col += afterCol * twilight * up * (0.35 + 0.65 * sideW) * 0.22 * (1.0 - gloom * 0.6);

    // Warm days haze the horizon a touch; cold ones cool it toward muted.
    float warmth = clamp((wxTemp - 8.0) / 22.0, 0.0, 1.0);
    float cold = clamp((4.0 - wxTemp) / 16.0, 0.0, 1.0);
    col += duskCol * band * warmth * daylight * 0.05;
    col = mix(col, mix(col, mutedColor.rgb, 0.35), cold * 0.25);

    // ---- stars ----
    float starVis = (1.0 - daylight) * (1.0 - twilight * 0.7) * (1.0 - wxFog) * (1.0 - wxCloud * 0.85);
    if (starVis > 0.01) {
        vec2 sq = p * 42.0;
        vec2 sid = floor(sq);
        float sh = hash21(sid + 5.1);
        if (sh > 0.962) {
            vec2 jit = vec2(hash21(sid + 2.2), hash21(sid + 8.8)) - 0.5;
            float d = length(fract(sq) - 0.5 - jit * 0.8);
            float tw = 0.6 + 0.4 * sin(time * (0.6 + sh * 2.0) + sh * 70.0);
            col += fgColor.rgb * (1.0 - smoothstep(0.0, 0.07, d)) * tw * starVis * up * 0.7;
        }
    }

    // ---- sun or moon ----
    float dBody = length(p - bodyPos);
    vec3 bodyCol;
    float bodyGlow;
    if (isDay) {
        bodyCol = mix(mix(fgColor.rgb, duskCol, 0.30), duskCol, twilight * 0.7);
        float disc = 1.0 - smoothstep(0.018, 0.024, dBody);
        bodyGlow = exp(-dBody * 4.5) * 0.28 + exp(-dBody * 14.0) * 0.45 + exp(-dBody * 45.0) * 0.6;
        // Behind cloud the disc goes, the glow spreads -- a sun through overcast.
        col += bodyCol * disc * 1.15 * (1.0 - gloom * 0.85);
        col += bodyCol * bodyGlow * (1.0 - gloom * 0.45);
    } else {
        bodyCol = mix(fgColor.rgb, mutedColor.rgb, 0.22);
        float r = 0.030;
        vec2 lp = (p - bodyPos) / r;
        float disc = 1.0 - smoothstep(0.90, 1.0, length(lp));
        // Phase: the terminator sweeps right-to-left through the month;
        // waxing is lit on the right, waning on the left.
        float k = cos(moonPhase * 2.0 * PI);
        float xt = k * sqrt(max(1.0 - lp.y * lp.y, 0.0));
        float lit = moonPhase < 0.5 ? smoothstep(-0.08, 0.08, lp.x - xt)
                                    : smoothstep(-0.08, 0.08, -xt - lp.x);
        float fullness = 0.5 - 0.5 * k;
        float crater = 0.85 + 0.15 * fbm3(lp * 2.4 + 3.0);
        bodyGlow = exp(-dBody * 7.0) * 0.20 * fullness;
        col += bodyCol * disc * (lit * crater + 0.06) * (1.0 - gloom * 0.6);
        col += bodyCol * bodyGlow * (1.0 - gloom * 0.7);
    }

    // ---- clouds ----
    float drift = time * (0.006 + wxWind * 0.045);
    float nearHorizon = smoothstep(HORIZON - 0.25, HORIZON, p.y);
    float c1 = highDeck(p, drift, clamp(wxCloud, 0.0, 1.0)) * (1.0 - nearHorizon * 0.5);
    float lowWeight = clamp((wxCloud - 0.45) * 1.4 + storminess * 0.8, 0.0, 1.0);
    float c2 = lowDeck(p, drift * 1.3, lowWeight) * lowWeight * (1.0 - nearHorizon * 0.35);

    // Cloud colour: lit by day, dim silver by night, warmed underneath at
    // dusk, darker as the weather turns, with a lining near the sun or moon.
    vec3 cloudDay = mix(mutedColor.rgb, fgColor.rgb, 0.32);
    vec3 cloudNight = mix(bgColor.rgb, mutedColor.rgb, 0.45) * 0.62;
    vec3 cloudCol = mix(cloudNight, cloudDay, daylight);
    cloudCol += duskCol * twilight * (0.25 + 0.75 * sideW) * 0.85;
    cloudCol += bodyCol * exp(-dBody * 3.5) * 0.30;
    cloudCol *= 1.0 - storminess * 0.42;
    vec3 lowCol = cloudCol * (0.72 - storminess * 0.15);

    // A simple self-shading pass on the high deck: look a little toward the
    // light; where the cloud thins that way, this side is lit.
    vec2 toLight = normalize(bodyPos - p + vec2(1e-4));
    float c1Toward = highDeck(p + toLight * 0.035, drift, clamp(wxCloud, 0.0, 1.0));
    float shade = clamp(1.0 + (c1 - c1Toward) * 1.6, 0.7, 1.3);

    col = mix(col, cloudCol * shade, c1 * 0.86);
    col = mix(col, lowCol, c2 * 0.93);

    // ---- storm ----
    // Strikes live inside the cloud; nothing here depends on the host.
    float flash = 0.0;
    float flashX = 0.0;
    if (wxStorm > 0.01) {
        float period = 2.7;
        float seg = floor(time / period);
        if (hash1(seg * 7.13) > 1.0 - 0.55 * wxStorm) {
            float t0 = seg * period + hash1(seg * 3.1) * 1.4;
            float dt = time - t0;
            if (dt > 0.0) {
                flash = exp(-dt * 11.0) + 0.55 * exp(-max(dt - 0.12, 0.0) * 14.0) * step(0.12, dt);
            }
        }
        flashX = mix(-halfW * 0.8, halfW * 0.8, hash1(seg * 5.7));
        vec3 flashCol = mix(accentColor.rgb, fgColor.rgb, 0.35);
        float reach = exp(-abs(p.x - flashX) * 1.4);
        col += flashCol * flash * (c1 + c2) * reach * 0.9;
        col += flashCol * flash * 0.08;
    }

    // ---- land ----
    // Two ridges: the far one hazed toward the sky, the near one dark.
    vec3 snowGround = mix(mutedColor.rgb, fgColor.rgb, 0.5) * (0.45 + 0.40 * daylight);
    float farRidge = HORIZON - 0.012 + (fbm3(vec2(p.x * 1.6 + 11.0, 4.0)) - 0.5) * 0.10;
    float farLand = smoothstep(farRidge - 0.002, farRidge + 0.003, p.y);
    vec3 farCol = mix(skyLow, bgColor.rgb * 0.35, 0.55);
    farCol = mix(farCol, mix(snowGround, skyLow, 0.35), wxSnow * 0.7);
    col = mix(col, farCol, farLand);
    float nearRidge = HORIZON + 0.022 + (fbm3(vec2(p.x * 0.9, 2.0)) - 0.5) * 0.08;
    float ground = smoothstep(nearRidge - 0.002, nearRidge + 0.003, p.y);
    vec3 groundCol = mix(bgColor.rgb * 0.20, skyLow * 0.30, 0.25);
    groundCol = mix(groundCol, snowGround, wxSnow * 0.8);
    col = mix(col, groundCol, ground);

    // ---- precipitation behind the tree ----
    float slant = 2.0 + wxWind * 14.0;
    vec3 rainCol = mix(mutedColor.rgb, fgColor.rgb, 0.45) * (0.55 + 0.45 * daylight);
    vec3 snowCol = fgColor.rgb * 1.08;
    if (wxRain > 0.01) {
        float amt = wxRain;
        float r = rainSheet(p, 220.0, 24.0, 7.0, slant, 0.05, 0.10 * amt, 0.0) * 0.55
                + rainSheet(p, 150.0, 16.0, 10.0, slant * 1.2, 0.07, 0.08 * amt, 31.0) * 0.8;
        col += rainCol * r * (0.45 + flash * 0.5);
    }
    if (wxSnow > 0.01) {
        float windX = wxWind * 1.2;
        float s = snowLayer(p, 40.0, 1.0, 0.09, 0.16 * wxSnow, windX, 5.0) * 0.45
                + snowLayer(p, 24.0, 1.4, 0.11, 0.12 * wxSnow, windX * 1.3, 19.0) * 0.70;
        col = mix(col, snowCol, clamp(s, 0.0, 1.0) * 0.85);
    }

    // ---- fog, first half: behind the tree ----
    // Horizontal banks drifting slowly, thickest down on the land.
    float banks = smoothstep(0.30, 0.78, fbm3(vec2(p.x * 1.3 - time * 0.018, p.y * 6.0 + 1.7)));
    float lowness = smoothstep(-0.35, HORIZON + 0.06, p.y);
    float fogAmt = clamp(wxFog * (0.22 + 0.78 * lowness) * (0.50 + 0.70 * banks), 0.0, 0.94);
    vec3 fogCol = mix(skyLow, mix(mutedColor.rgb, fgColor.rgb, 0.5), 0.55) * (0.75 + 0.35 * daylight);
    fogCol += bodyCol * exp(-dBody * 2.5) * 0.18;
    col = mix(col, fogCol, fogAmt * 0.75);

    // ---- the tree ----
    vec2 iconUV = p / ICON_SCALE + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float edge = 0.0;
    float snowCap = 0.0;
    if (inIcon) {
        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        edge = clamp(length(vec2(aR - aL, aD - aU)), 0.0, 1.0);

        // Snow settles on surfaces that face up: tree below, open sky above.
        if (wxSnow > 0.01) {
            float st = 4.0 / 1024.0;
            float above = texture(maskSource, clamp(iconUV - vec2(0.0, st), 0.0, 1.0)).a;
            float here = mask.a;
            snowCap = smoothstep(0.25, 0.75, here - above) * clamp(wxSnow * 1.4, 0.0, 1.0);
        }
    }
    vec3 silhouette = mix(bgColor.rgb * 0.22, skyLow * 0.45, 0.25);
    col = mix(col, silhouette, mask.a * 0.92);

    vec3 rimCol = mix(mix(mutedColor.rgb, fgColor.rgb, 0.4), bodyCol, isDay ? daylight * 0.5 : 0.25)
                + duskCol * twilight * 0.45;
    rimCol += mix(accentColor.rgb, fgColor.rgb, 0.35) * flash * 0.8;
    col += rimCol * edge * (0.70 + wxRain * 0.15) * edgeGlowBrightness;
    col = mix(col, snowCol * (0.55 + 0.45 * daylight), snowCap * 0.9);

    // ---- precipitation in front of the tree ----
    if (wxRain > 0.01) {
        float r = rainSheet(p, 90.0, 10.0, 13.0, slant * 1.4, 0.08, 0.05 * wxRain, 57.0);
        col += rainCol * r * (0.22 + flash * 0.4);
    }
    if (wxSnow > 0.01) {
        // Near flakes: few, larger, out of focus.
        float s = snowLayer(p, 12.0, 2.0, 0.16, 0.05 * wxSnow, wxWind * 1.6, 41.0);
        col = mix(col, snowCol, s * 0.45);
    }

    // ---- fog, second half: in front of everything ----
    col = mix(col, fogCol, fogAmt * 0.45);

    // Hue-preserving highlight rolloff.
    float peak = max(col.r, max(col.g, col.b));
    float knee = 0.82;
    if (peak > knee) col *= (knee + (peak - knee) / (1.0 + (peak - knee) * 2.2)) / peak;

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
