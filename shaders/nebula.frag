#version 440

// Nebula -- a slice of deep space. Gas lies in layers that rotate
// differentially, so the field winds itself into spiral shear the way a real
// disc does. The central logo represents the black hole, surrounded by a
// faint accretion glow, with denser gas shadowing the light. Three
// star planes drift at their own rates for parallax, and dust lanes pass in
// front of everything -- the tree included -- which is what puts the mark
// inside the scene instead of on top of it.

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

// ---------------------------------------------------------------- noise ---

float hash21(vec2 p) {
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
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.09; a *= 0.5; }
    return v;
}

float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.04; a *= 0.53; }
    return v;
}

// ------------------------------------------------------------- rotation ---

vec2 rot(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Differential rotation: the inner field turns faster than the outer, which
// is what shears straight gas into spiral arms over time.
vec2 galactic(vec2 p, float rate) {
    float r = length(p);
    return rot(p, time * rate * nebulaDrift / (0.22 + r * 1.5));
}

// ------------------------------------------------------------------ gas ---

// Density of the main gas body at a point, domain-warped into filaments.
float gasDensity(vec2 p) {
    vec2 q = galactic(p, 0.055) * 1.45;
    vec2 w = vec2(fbm3(q * 0.9 + vec2(0.0, time * 0.012)),
                  fbm3(q * 0.9 + vec2(7.3, -time * 0.010)));
    float d = fbm5(q + w * 1.15);
    // Falls away toward the edges of frame so the cloud has a body rather
    // than tiling out to infinity.
    float body = smoothstep(1.55, 0.25, length(p));
    return smoothstep(0.34, 0.86, d) * body;
}

float gasDensityLite(vec2 p) {
    vec2 q = galactic(p, 0.055) * 1.45;
    float body = smoothstep(1.55, 0.25, length(p));
    return smoothstep(0.34, 0.86, fbm3(q)) * body;
}

// How much of the core's light survives the gas in between. Gives the cloud
// genuine depth: near faces glow, far sides fall into their own shadow.
float gasTransmit(vec2 p, vec2 corePos) {
    vec2 delta = corePos - p;
    float dist = length(delta);
    vec2 stepV = delta / 4.0;
    float acc = 0.0;
    vec2 s = p;
    for (int i = 0; i < 4; i++) {
        s += stepV;
        acc += gasDensityLite(s);
    }
    return exp(-acc * (dist / 4.0) * 4.5);
}

// ---------------------------------------------------------------- stars ---

float starPlane(vec2 p, float scale, float cut, float sizeScale, float seed) {
    vec2 q = p * scale;
    vec2 id = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash21(id + seed);
    if (h < cut) return 0.0;
    vec2 jit = vec2(hash21(id + seed + 2.1), hash21(id + seed + 6.4)) - 0.5;
    float d = length(f - jit * 0.82);
    float size = (0.045 + hash21(id + seed + 11.3) * 0.035) * sizeScale;
    float aa = max(fwidth(d), 0.001);
    float core = 1.0 - smoothstep(max(0.0, size - aa), size + aa, d);
    float twinkle = 0.88 + 0.12 * sin(time * (0.7 + h * 2.6) + h * 91.0);
    // Treble hits make a random subset of stars flare -- each star has its
    // own threshold, so it sparkles rather than blinking in unison.
    float pick = step(hash21(id + seed + 11.3), clamp(audioTreblePulse, 0.0, 1.0));
    return core * twinkle * (1.0 + pick * 0.75);
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;
    p.x *= aspect;

    // ---- icon ----
    float iconScale = 0.6;
    vec2 iconUV = p / iconScale + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float sdfHere = inIcon ? texture(distSource, iconUV).r : 0.0;

    vec2 warp = vec2(0.0);
    float edge = 0.0;
    if (inIcon) {
        float texel = 1.0 / 1024.0;
        float dl = texture(distSource, clamp(iconUV - vec2(texel, 0.0), 0.0, 1.0)).r;
        float dr = texture(distSource, clamp(iconUV + vec2(texel, 0.0), 0.0, 1.0)).r;
        float du = texture(distSource, clamp(iconUV - vec2(0.0, texel), 0.0, 1.0)).r;
        float dd = texture(distSource, clamp(iconUV + vec2(0.0, texel), 0.0, 1.0)).r;
        vec2 gradSdf = vec2(dr - dl, dd - du);
        vec2 tangent = normalize(vec2(-gradSdf.y, gradSdf.x) + 1e-5);
        float w = smoothstep(0.55, 0.0, abs(sdfHere - 0.5));
        float boxFade = smoothstep(1.0, 0.75, max(abs(iconUV.x - 0.5), abs(iconUV.y - 0.5)) * 2.0);
        warp = tangent * w * boxFade * 0.07 * iconWarpScale;

        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        edge = clamp(length(vec2(aR - aL, aD - aU)), 0.0, 1.0);
    }
    vec2 pw = p + warp;

    // ---- the void ----
    vec3 col = bgColor.rgb * 0.30;

    // ---- stars, far to near ----
    // Each plane turns at its own rate, so they slide past one another.
    vec3 starCool = mix(fgColor.rgb, mutedColor.rgb, 0.35);
    vec3 starWarm = mix(fgColor.rgb, accentColor.rgb, 0.40);

    col += starCool * starPlane(rot(pw, time * 0.004 * nebulaDrift), 26.0, 0.940, 0.7, 3.0) * 0.55;
    col += starWarm * starPlane(rot(pw, time * 0.009 * nebulaDrift), 32.0, 0.970, 1.0, 17.0) * 0.75;
    col += fgColor.rgb * starPlane(rot(pw, time * 0.017 * nebulaDrift), 20.0, 0.980, 0.8, 53.0) * 0.95;

    // ---- the gas ----
    // Gas illumination is centered on the accretion region around the logo.
    vec2 corePos = vec2(0.0);

    float dens = gasDensity(pw);
    float trans = gasTransmit(pw, corePos);
    float coreDist = length(pw - corePos);
    float falloff = 1.0 / (1.0 + coreDist * coreDist * 2.2);

    // Two gas species at different temperatures: the lit side runs toward the
    // accent, the shadowed body toward the cool muted tone.
    vec3 gasLit = mix(accentColor.rgb, urgentColor.rgb, 0.30);
    vec3 gasCool = mix(mutedColor.rgb, bgColor.rgb, 0.45);

    float lighting = trans * falloff;
    vec3 gasColor = mix(gasCool, gasLit, clamp(lighting * 2.6, 0.0, 1.0));
    col = mix(col, gasColor, clamp(dens * 0.92, 0.0, 1.0));
    col += gasLit * dens * lighting * 1.5 * (1.0 + audioBassPulse * 0.22);

    // A restrained, tilted accretion glow surrounds the central dark mark.
    vec2 disc = rot(p, -0.18);
    float discRadius = length(vec2(disc.x, disc.y * 2.2));
    float accretion = exp(-pow((discRadius - 0.37) / 0.035, 2.0));
    // The ring around the mark pulses with the kick.
    col += gasLit * accretion * 0.08 * (1.0 + clamp(audioBassPulse, 0.0, 1.0) * 2.2);
    col *= smoothstep(0.10, 0.32, length(p));

    // ---- the tree ----
    vec3 silhouette = bgColor.rgb * 0.035;
    col = mix(col, silhouette, mask.a);
    col += mix(accentColor.rgb, fgColor.rgb, 0.35) * edge
         * (0.36 + audioPeak * 0.025) * edgeGlowBrightness;

    // ---- dust lanes, in front of everything ----
    // Composited last, so they cut across the tree as well as the gas and put
    // the mark inside the cloud rather than pasted over it.
    vec2 dq = galactic(pw, 0.030) * 1.05;
    float dustField = fbm5(dq + vec2(fbm3(dq * 2.1) * 0.55, 0.0));
    float dust = smoothstep(0.56, 0.24, dustField) * smoothstep(1.9, 0.3, length(pw));
    col = mix(col, bgColor.rgb * 0.14, dust * 0.85);

    // Soft highlight rolloff -- keeps the core's bloom from clipping flat.
    col = col / (1.0 + max(col - vec3(0.8), vec3(0.0)));

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
