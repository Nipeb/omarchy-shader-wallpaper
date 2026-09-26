#version 440

// Nebula -- a black hole feeding in a nebula. The mark is the event horizon:
// its ring of knotwork is the shadow's edge, and the gaps inside it look down
// the throat at gas plunging in.
//
// - Everything behind the hole is seen through a point-mass lens
//   (beta = theta - thetaE^2 / theta), so star fields and gas smear into
//   arcs, a doubled inner image appears flipped, and an Einstein ring forms.
//   A frame-dragging twist, fixed in space and not in time, wrings the view
//   closer in.
// - A thin accretion disc sits almost edge-on. Its near half crosses in
//   front of the horizon, its far half is lifted up and over the shadow
//   (plus a fainter image under it) by the same lensing. Doppler beaming
//   makes the approaching side brighter and bluer and the receding side dim
//   and warm.
// - A photon ring hugs the shadow, and faint polar jets carry knots outward.
//
// Nothing here rotates differentially. The old version sheared the gas
// with a radius-dependent angular speed, which kept winding with no limit
// until the field became concentric rings. Each moving pattern is now either
// a rigid rotation or a rigid translation in log-polar space, which is a
// spiral inflow that stays the same shape.

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
    float audioBass;
    float audioMid;
    float audioTreble;
    float audioBassPulse;
    float audioTreblePulse;
    float iconWarpScale;
    float edgeGlowWidth;
    float edgeGlowBrightness;
    float nebulaDrift;
};

layout(binding = 1) uniform sampler2D maskSource;
layout(binding = 2) uniform sampler2D distSource;

const float ICON_SCALE = 0.6;
const float HORIZON = 0.262;   // shadow radius: the outer ring of the mark
const float RING = 0.276;      // photon ring, just outside the knotwork
const float EINSTEIN = 0.40;   // lens strength (Einstein radius)
const float TILT = -0.11;      // roll of the disc on screen (rad)
const float INCL = 0.15;       // disc minor/major axis ratio, near edge-on
const float DISC_IN = 0.34;    // inner edge of the disc (disc-plane units)
const float DISC_OUT = 1.30;
const float TAU = 6.2831853;

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

// Value noise that wraps every `per` cells in x -- used for patterns laid
// out around a circle, so there is no seam where the angle wraps.
float pnoise(vec2 p, float per) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float i0 = mod(i.x, per);
    float i1 = mod(i.x + 1.0, per);
    return mix(mix(hash21(vec2(i0, i.y)), hash21(vec2(i1, i.y)), u.x),
               mix(hash21(vec2(i0, i.y + 1.0)), hash21(vec2(i1, i.y + 1.0)), u.x), u.y);
}

float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.09; a *= 0.5; }
    return v;
}

float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.04; a *= 0.53; }
    return v;
}

// Three octaves of wrapping noise; each octave doubles the wrap period.
float pfbm(vec2 p, float per) {
    return 0.55 * pnoise(p, per)
         + 0.30 * pnoise(p * 2.0 + vec2(0.0, 3.1), per * 2.0)
         + 0.15 * pnoise(p * 4.0 + vec2(0.0, 7.7), per * 4.0);
}

// ---------------------------------------------------------------- colour ---

vec2 rot(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

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

// ------------------------------------------------------------------ lens ---

// Where a ray seen at screen point p came from in the plane behind the hole.
// Inside the Einstein radius the image flips to the far side, which is what
// produces the doubled, mirrored inner sky.
vec2 lensMap(vec2 p) {
    float r = max(length(p), 1e-3);
    float b = r - EINSTEIN * EINSTEIN / r;
    // Frame dragging: a twist that grows toward the horizon. It depends on
    // radius only, never on time, so it bends the view without winding it.
    float twist = 0.34 * (EINSTEIN * EINSTEIN) / (r * r + 0.02);
    return rot(p / r, twist) * b;
}

// ------------------------------------------------------------- the sky ---

float starPlane(vec2 p, float scale, float cut, float sizeScale, float seed) {
    vec2 q = p * scale;
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash21(id + seed);
    if (h < cut) return 0.0;
    vec2 jit = vec2(hash21(id + seed + 2.1), hash21(id + seed + 6.4)) - 0.5;
    float d = length(f - jit * 0.82);
    float size = (0.045 + hash21(id + seed + 11.3) * 0.035) * sizeScale;
    float aa = clamp(fwidth(d), 0.001, 0.25);
    float core = 1.0 - smoothstep(max(0.0, size - aa), size + aa, d);
    // Lensing stretches a star into an arc; spread its light over the smear
    // instead of letting magnified stars turn into bright bars.
    core *= clamp(0.06 / (aa + 0.03), 0.25, 1.0);
    float twinkle = 0.88 + 0.12 * sin(time * (0.7 + h * 2.6) + h * 91.0);
    float pick = step(hash21(id + seed + 11.3), clamp(audioTreblePulse, 0.0, 1.0));
    return core * twinkle * (1.0 + pick * 0.75);
}

// Gas in the plane behind the hole. It turns rigidly and drifts, so it can
// never shear itself into rings.
float gasDensity(vec2 b) {
    vec2 q = rot(b, time * 0.006 * nebulaDrift) * 1.45 + vec2(time * 0.004 * nebulaDrift, 0.0);
    vec2 w = vec2(fbm3(q * 0.9 + vec2(0.0, time * 0.012)),
                  fbm3(q * 0.9 + vec2(7.3, -time * 0.010)));
    float d = fbm5(q + w * 1.25);
    float body = smoothstep(2.1, 0.35, length(b));
    return smoothstep(0.36, 0.86, d) * body;
}

float gasDensityLite(vec2 b) {
    vec2 q = rot(b, time * 0.006 * nebulaDrift) * 1.45 + vec2(time * 0.004 * nebulaDrift, 0.0);
    return smoothstep(0.36, 0.86, fbm3(q)) * smoothstep(2.1, 0.35, length(b));
}

// Light from the disc reaching a gas point, dimmed by gas in between.
float gasTransmit(vec2 b) {
    vec2 stepV = -b / 4.0;
    float acc = 0.0;
    vec2 s = b;
    for (int i = 0; i < 4; i++) {
        s += stepV;
        acc += gasDensityLite(s);
    }
    return exp(-acc * (length(b) / 4.0) * 4.0);
}

// ------------------------------------------------------------------ disc ---

// Streaked, spiralling structure of the disc at disc-plane radius r and
// azimuth phi. Laid out in (angle, log radius) and moved as one rigid shift
// there: orbiting + falling inward, forever, without tightening.
float discPattern(float r, float phi, float seed) {
    float u = log(r);
    float a = phi / TAU;
    float t = time * nebulaDrift;
    vec2 c = vec2(a * 14.0 + u * 6.0 - t * 0.30 + seed,
                  u * 11.0 + t * 0.20);
    float n = pfbm(c, 14.0);
    // Sharpen into lanes of bright gas with dark gaps between.
    float lanes = smoothstep(0.30, 0.78, n);
    float fine = pnoise(vec2(a * 56.0 - t * 1.2, u * 38.0 + t * 0.8), 56.0);
    return lanes * (0.65 + 0.55 * fine);
}

// Emission profile: brightest at the inner edge, a soft outer fade.
float discProfile(float r) {
    float inner = smoothstep(DISC_IN * 0.97, DISC_IN * 1.10, r);
    float outer = smoothstep(DISC_OUT, DISC_OUT * 0.45, r);
    return inner * outer * pow(DISC_IN / max(r, 1e-3), 1.35);
}

// Colour of disc light at radius r and azimuth phi, with Doppler beaming.
// `hot`, `warm`, `blue` and `red` are theme-derived tones.
vec3 discLight(float r, float phi, float seed, vec3 hot, vec3 warm,
               vec3 blue, vec3 red, float pulse) {
    float prof = discProfile(r);
    if (prof <= 0.0) return vec3(0.0);
    float structure = discPattern(r, phi, seed);
    float temp = clamp(pow(DISC_IN / r, 0.9), 0.0, 1.0);
    vec3 base = mix(warm, hot, temp * temp);

    // Line-of-sight velocity: the left side comes toward us.
    float beta = 0.42 * sqrt(DISC_IN / r);
    float los = -cos(phi);
    float boost = clamp(pow(1.0 / max(1.0 - beta * los, 0.2), 3.0) * 0.55, 0.12, 3.2);
    vec3 shift = los > 0.0 ? mix(base, blue, los * beta * 1.3)
                           : mix(base, red, -los * beta * 1.3);

    return shift * prof * (0.25 + structure * 1.1) * boost * (1.0 + pulse);
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;   // y points down
    p.x *= aspect;
    float rho = length(p);
    float t = time * nebulaDrift;

    // ---- theme tones ----
    vec3 accHsv = rgb2hsv(accentColor.rgb);
    vec3 hot = mix(accentColor.rgb, fgColor.rgb, 0.55);    // white-hot inner edge
    vec3 warm = shifted(accHsv, -28.0, 1.10, 0.95);         // outer disc gas
    vec3 blue = shifted(accHsv, 38.0, 1.05, 1.10);          // approaching side
    vec3 red = shifted(accHsv, -55.0, 1.15, 0.70);          // receding side
    float pulse = clamp(audioBassPulse, 0.0, 1.0);

    // ---- icon ----
    vec2 iconUV = p / ICON_SCALE + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float edge = 0.0;
    vec2 gradSdf = vec2(0.0);
    if (inIcon) {
        float texel = 1.0 / 1024.0;
        float dl = texture(distSource, clamp(iconUV - vec2(texel, 0.0), 0.0, 1.0)).r;
        float dr = texture(distSource, clamp(iconUV + vec2(texel, 0.0), 0.0, 1.0)).r;
        float du = texture(distSource, clamp(iconUV - vec2(0.0, texel), 0.0, 1.0)).r;
        float dd = texture(distSource, clamp(iconUV + vec2(0.0, texel), 0.0, 1.0)).r;
        gradSdf = vec2(dr - dl, dd - du) * 512.0;

        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        edge = clamp(length(vec2(aR - aL, aD - aU)), 0.0, 1.0);
    }

    // ================================================== behind the hole ===
    vec2 b = lensMap(p);
    float bLen = length(b);
    // Magnification: light piles up along the Einstein ring.
    float magnify = clamp(sqrt(rho / (abs(rho - EINSTEIN * EINSTEIN / max(rho, 1e-3)) + 0.06)), 0.6, 2.2);

    vec3 col = bgColor.rgb * 0.26;

    // Stars, three planes turning rigidly at their own rates.
    vec3 starCool = mix(fgColor.rgb, mutedColor.rgb, 0.35);
    vec3 starWarm = mix(fgColor.rgb, accentColor.rgb, 0.40);
    col += starCool * starPlane(rot(b, t * 0.004), 26.0, 0.940, 0.7, 3.0) * 0.50 * magnify;
    col += starWarm * starPlane(rot(b, t * 0.009), 32.0, 0.970, 1.0, 17.0) * 0.70 * magnify;
    col += fgColor.rgb * starPlane(rot(b, t * 0.015), 20.0, 0.982, 0.8, 53.0) * 0.85 * magnify;

    // Gas, lit by the disc.
    float dens = gasDensity(b);
    // The hole has blown a cavity in the gas behind it.
    dens *= 0.35 + 0.65 * smoothstep(0.04, 0.45, bLen);
    float trans = gasTransmit(b);
    float falloff = 1.0 / (1.0 + bLen * bLen * 2.6);
    float lighting = trans * falloff;
    vec3 gasLit = mix(accentColor.rgb, warm, 0.35);
    vec3 gasCool = mix(mutedColor.rgb, bgColor.rgb, 0.50);
    vec3 gasColor = mix(gasCool, gasLit, clamp(lighting * 2.4, 0.0, 1.0));
    col = mix(col, gasColor, clamp(dens * 0.85, 0.0, 1.0));
    col += gasLit * pow(dens, 1.5) * lighting * 1.3 * magnify;

    // Dust lanes in the same lensed plane: dark filaments bent round the hole.
    vec2 dq = rot(b, t * 0.004) * 1.05 + vec2(-t * 0.003, 0.0);
    float dustField = fbm5(dq + vec2(fbm3(dq * 2.1) * 0.6, 0.0));
    float dust = smoothstep(0.55, 0.26, dustField) * smoothstep(2.2, 0.4, bLen);
    col = mix(col, bgColor.rgb * 0.12, dust * 0.80);

    // Light from close to the hole is redshifted and dimmed on its way out.
    col *= 0.25 + 0.75 * smoothstep(HORIZON * 0.95, HORIZON * 1.9, rho);

    // =================================================== the disc: far ===
    vec2 d = rot(p, TILT);
    vec2 dp = vec2(d.x, d.y / INCL);           // disc plane; +y = near side
    float dr = length(dp);
    float dphi = atan(dp.y, dp.x);
    // Soft seam between the halves -- a hard step showed as a blade edge.
    float nearSide = smoothstep(-0.004, 0.004, d.y);

    // Direct image of the far half (the shadow hides what is behind it).
    // The disc's gas absorbs the background behind it, both halves alike.
    float discAlpha = clamp(discProfile(dr) * 2.4, 0.0, 1.0);
    col = mix(col, col * 0.35, discAlpha * 0.55);
    vec3 farDisc = discLight(dr, dphi, 0.0, hot, warm, blue, red, pulse * 0.35);
    col += farDisc * (1.0 - nearSide);

    // Lensed images of the far half. Light from behind the hole is bent up
    // over the top of the shadow (the bright arc) and, more weakly, under it.
    float ang = atan(-d.y, d.x);               // 0 = right, +pi/2 = up
    float arcTop = max(sin(ang), 0.0);
    float arcBot = max(-sin(ang), 0.0);
    float rTop = DISC_IN + (length(d) - RING - 0.006) / 0.30;
    float rBot = DISC_IN + (length(d) - RING - 0.002) / 0.12;
    vec3 topArc = discLight(rTop, -ang, 0.0, hot, warm, blue, red, pulse * 0.35);
    vec3 botArc = discLight(rBot, ang, 5.3, hot, warm, blue, red, pulse * 0.35);
    col += topArc * pow(arcTop, 0.6) * 0.95;
    col += botArc * pow(arcBot, 0.8) * 0.45;

    // =================================================== the horizon ===
    float shadow = 1.0 - smoothstep(HORIZON - 0.003, HORIZON + 0.003, rho);

    // Looking down the throat: gas spiralling in, falling faster and dimming
    // toward the centre. A rigid shift in log-polar space again. Near the
    // knotwork the plunge bends round the strands.
    float u = log(max(rho, 1e-3));
    float a = atan(p.y, p.x) / TAU;
    vec2 bendAlong = vec2(-gradSdf.y, gradSdf.x) * 0.16 * iconWarpScale;
    float swirl = pfbm(vec2(a * 10.0 + u * 4.5 - t * 0.55 + bendAlong.x,
                            u * 7.0 + t * 0.9 + bendAlong.y), 10.0);
    float throat = smoothstep(0.30, 0.80, swirl) * smoothstep(0.03, HORIZON, rho);
    vec3 throatCol = mix(red, accentColor.rgb, smoothstep(0.08, HORIZON, rho)) * 0.55;
    vec3 inside = bgColor.rgb * 0.02 + throatCol * throat * throat * (1.0 + pulse * 0.6);
    col = mix(col, inside, shadow);

    // The tree itself is darker than anything: the horizon's structure.
    col = mix(col, vec3(0.0), mask.a * 0.97);

    // Photon ring: a razor-thin circle right on the edge plus a soft halo,
    // brighter on the approaching side like the disc.
    float ringCore = exp(-pow((rho - RING) / 0.0032, 2.0));
    float ringHalo = exp(-pow((rho - RING) / 0.020, 2.0));
    float ringSide = 0.75 + 0.45 * (-cos(ang));
    col += hot * (ringCore * 0.85 + ringHalo * 0.16) * ringSide * (1.0 + pulse * 0.9);

    // Rim light on the knotwork, caught from the disc below it.
    col += mix(accentColor.rgb, hot, 0.30) * edge * 0.22 * edgeGlowBrightness
         * (0.6 + 0.4 * smoothstep(-0.1, 0.2, p.y)) * (1.0 + audioPeak * 0.03);

    // ==================================================== polar jets ===
    // Perpendicular to the disc, knots riding outward. Hidden by the shadow.
    float along = abs(d.y);
    float across = d.x;
    // The beam wanders and flares open, and brightness comes in discrete
    // knots travelling outward rather than as a flat bar.
    float side = step(0.0, d.y);
    float sway = (fbm3(vec2(along * 3.0 - t * 0.25, side * 5.0)) - 0.5) * along * 0.18;
    float jw = 0.004 + along * 0.045;
    float jetCore = exp(-pow((across - sway) / jw, 2.0));
    float knotPos = along * 9.0 - t * 0.9 + side * 3.7;
    float knots = pow(max(sin(knotPos + fbm3(vec2(knotPos * 0.3, side)) * 3.0), 0.0), 6.0);
    float jetTex = fbm3(vec2((across - sway) * 40.0, knotPos * 1.5));
    float jet = jetCore * smoothstep(HORIZON, HORIZON + 0.05, along)
              * exp(-(along - HORIZON) * 3.2) * (0.12 + knots * 0.9) * (0.5 + jetTex);
    col += blue * jet * 0.28 * (1.0 - shadow) * (1.0 + pulse * 0.5);

    // =================================================== the disc: near ===
    // Composited last so it crosses in front of the horizon and the tree.
    vec3 nearDisc = discLight(dr, dphi, 0.0, hot, warm, blue, red, pulse * 0.35);
    // Where the near half crosses the horizon it absorbs the throat too.
    col = mix(col, col * 0.35, discAlpha * nearSide * shadow * 0.55);
    col += nearDisc * nearSide;

    // Soft highlight rolloff -- keeps the inner edge from clipping flat.
    col = col / (1.0 + max(col - vec3(0.78), vec3(0.0)));

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
