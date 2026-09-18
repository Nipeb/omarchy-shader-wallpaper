#version 440

// Ink -- dye bleeding through still water. The motion is a real flow field:
// the velocity is the perpendicular gradient of a drifting noise potential,
// which makes it divergence-free, so it swirls and folds like a fluid instead
// of sliding like a texture. Each pixel traces that flow backwards and picks
// up whatever ink it passes through, so what you see are genuine streaklines.
// The tree is one of the sources -- it bleeds into the water and the current
// carries the colour away from its outline.

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
};

layout(binding = 1) uniform sampler2D maskSource;
layout(binding = 2) uniform sampler2D distSource;

const float ICON_SCALE = 0.6;
const int STEPS = 7;

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
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.08; a *= 0.5; }
    return v;
}

float fbm4(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.05; a *= 0.52; }
    return v;
}

// ------------------------------------------------------------------ flow ---

// Stream function. Two counter-drifting scales so the field never settles
// into a single repeating eddy.
float potential(vec2 p) {
    return fbm3(p * 1.15 + vec2(0.0, time * 0.035))
         + 0.55 * fbm3(p * 2.45 + vec2(-time * 0.028, 4.3));
}

// Velocity = perpendicular gradient of the stream function. Taking the curl
// this way guarantees the field has no sources or sinks, which is exactly
// what stops the ink from piling up or thinning out unnaturally.
vec2 flowAt(vec2 p) {
    const float e = 0.035;
    float dx = potential(p + vec2(e, 0.0)) - potential(p - vec2(e, 0.0));
    float dy = potential(p + vec2(0.0, e)) - potential(p - vec2(0.0, e));
    return vec2(dy, -dx) * (0.5 / e);
}

// ---------------------------------------------------------------- source ---

// Alpha of the mark at a point in scene space, 0 outside its box.
float treeAt(vec2 q) {
    vec2 uv = q / ICON_SCALE + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture(maskSource, uv).a;
}

// Where ink enters the water: broad drifting plumes across the frame, plus
// the tree itself bleeding from its whole silhouette.
float inkSource(vec2 q) {
    float plumes = smoothstep(0.46, 0.95, fbm4(q * 1.9 + vec2(time * 0.018, -time * 0.013)));
    return max(plumes, treeAt(q) * 0.95);
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;
    p.x *= aspect;

    // ---- trace the flow backwards and collect the ink we came through ----
    // Each step back is a step further into the past, so contributions are
    // weighted down with age: what we pick up early is the leading edge of a
    // streak, what we pick up late is its faded tail.
    float dt = 0.055 * inkFlow;
    vec2 s = p;
    float ink = 0.0;
    float norm = 0.0;
    for (int i = 0; i < STEPS; i++) {
        vec2 v = flowAt(s);
        v /= 1.0 + length(v);          // keep a rogue gradient from bolting
        s -= v * dt;
        float age = float(i) / float(STEPS);
        float w = 1.0 - age * 0.72;
        ink += inkSource(s) * w;
        norm += w;
    }
    ink /= max(norm, 1e-3);

    // Filament detail: a finer field advected a little way along the same
    // flow, so the body of each streak has grain rather than being a flat
    // wash of colour.
    vec2 sd = p - flowAt(p) * dt * 2.0;
    float grain = fbm3(sd * 7.5 + vec2(0.0, time * 0.05));
    ink *= 0.58 + grain * 0.85;
    ink = clamp(ink * 0.92, 0.0, 1.0);

    // ---- water and dye ----
    vec3 water = mix(bgColor.rgb * 0.85, mutedColor.rgb, 0.12);
    vec3 dyeThin = mix(water, accentColor.rgb, 0.30);
    vec3 dyeDeep = mix(accentColor.rgb, bgColor.rgb, 0.18);

    vec3 col = water;
    col = mix(col, dyeThin, smoothstep(0.05, 0.55, ink));
    col = mix(col, dyeDeep, smoothstep(0.62, 0.98, ink) * 0.85);

    // Where the dye is thickest it also darkens toward its own shadow, the
    // way real ink does when it folds back over itself.
    float fold = smoothstep(0.62, 1.0, ink) * smoothstep(0.85, 0.55, grain);
    col = mix(col, mix(accentColor.rgb, bgColor.rgb, 0.55), fold * 0.45);

    // ---- icon ----
    vec2 iconUV = p / ICON_SCALE + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float sdfHere = inIcon ? texture(distSource, iconUV).r : 0.0;

    float edge = 0.0;
    if (inIcon) {
        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        edge = clamp(length(vec2(aR - aL, aD - aU)), 0.0, 1.0);
    }

    // The mark reads as the saturated source of all the dye around it.
    vec3 markColor = mix(accentColor.rgb, bgColor.rgb, 0.68);
    col = mix(col, markColor, mask.a * 0.88);
    col += mix(accentColor.rgb, fgColor.rgb, 0.45) * edge * 0.40 * edgeGlowBrightness;

    col = col / (1.0 + max(col - vec3(0.85), vec3(0.0)));

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
