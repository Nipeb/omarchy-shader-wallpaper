#version 440

// Ink simulation step -- one frame of dye transport, fed back into itself
// through a recursive ShaderEffectSource (see inkSim/inkBuffer in
// Background.qml). The state texture holds four dyes, one per channel:
//   r, g, b -- three dyes dropped into the water, in colours ink.frag picks
//   a       -- the dye the tree itself bleeds from its outline
//
// The water's velocity is analytic but divergence-free: it is the
// perpendicular gradient of a stream function, so the dye is never created
// or destroyed by the flow itself, only folded and stretched. That stream
// function is:
//   - two scales of drifting curl noise plus a small fast one that stretches
//     dye into filaments,
//   - a slow uniform sinking (dense ink falls),
//   - a descending vortex pair under each fresh drop. That pair is what makes
//     a drop roll up into a mushroom cap with two curling tails,
//   - all multiplied by a ramp that is zero on the tree. That makes the mark
//     a solid obstacle the current has to go round, not through.
//
// Transport is semi-Lagrangian: trace the velocity back one step, read the
// previous frame there with a Catmull-Rom filter (bilinear blurs thin
// filaments away within seconds), then fade slightly and add the sources.

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    float time;
    float aspect;
    float inkFlow;
    vec2 inkTexel;
};

layout(binding = 1) uniform sampler2D prevState;
layout(binding = 2) uniform sampler2D maskSource;
layout(binding = 3) uniform sampler2D distSource;

const float ICON_SCALE = 0.6;
const float DT = 0.016;

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

// ----------------------------------------------------------------- drops ---
// Shared with ink.frag -- keep the two copies identical. Three independent
// slots, each dropping once per period at a new random place.

// xy = where the drop entered, z = age in seconds, w = random seed.
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

// The vortex pair under a drop: sinks, slows, widens and weakens.
vec2 dropCenter(vec4 dr) {
    return dr.xy + vec2(0.0, 0.34 * (1.0 - exp(-dr.z / 2.6)));
}

float dropStream(vec2 p, vec4 dr) {
    float age = dr.z;
    vec2 c = dropCenter(dr);
    float w = 0.042 + 0.060 * (1.0 - exp(-age / 1.8));
    float g = 0.0060 * exp(-age / 3.6) * smoothstep(0.0, 0.25, age);
    vec2 dR = p - (c + vec2(w, 0.0));
    vec2 dL = p - (c - vec2(w, 0.0));
    float a2 = 0.0006;
    return g * 0.5 * (log(dot(dR, dR) + a2) - log(dot(dL, dL) + a2));
}

// ------------------------------------------------------------------ flow ---

float sdfAt(vec2 q) {
    vec2 uv = q / ICON_SCALE + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture(distSource, uv).r;
}

float treeAt(vec2 q) {
    vec2 uv = q / ICON_SCALE + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture(maskSource, uv).a;
}

float stream(vec2 p, vec4 d0, vec4 d1, vec4 d2) {
    float t = time * inkFlow;
    // Centred on zero: the obstacle ramp multiplies this, and a constant
    // offset would turn into a steady whirl round the whole tree.
    float psi = (fbm3(p * 1.15 + vec2(0.0, t * 0.035)) - 0.44) * 0.050
              + (fbm3(p * 2.45 + vec2(-t * 0.028, 4.3)) - 0.44) * 0.022
              + (fbm3(p * 6.5 + vec2(t * 0.09, -t * 0.05)) - 0.44) * 0.0045;
    psi += -0.010 * p.x;                        // slow sinking
    psi += dropStream(p, d0) + dropStream(p, d1) + dropStream(p, d2);
    // Zero on and inside the tree, full strength ~15 px (icon) outside it.
    float ramp = smoothstep(0.515, 0.43, sdfAt(p));
    return psi * ramp;
}

vec2 velocity(vec2 p, vec4 d0, vec4 d1, vec4 d2) {
    const float e = 0.0025;
    float dx = stream(p + vec2(e, 0.0), d0, d1, d2) - stream(p - vec2(e, 0.0), d0, d1, d2);
    float dy = stream(p + vec2(0.0, e), d0, d1, d2) - stream(p - vec2(0.0, e), d0, d1, d2);
    return vec2(dy, -dx) / (2.0 * e);
}

// --------------------------------------------------------------- sampling ---

// Catmull-Rom from 9 bilinear taps (the standard trick): sharp enough that
// filaments survive thousands of frames of re-sampling.
vec4 sampleCR(vec2 uv) {
    vec2 texSize = 1.0 / inkTexel;
    vec2 sp = uv * texSize;
    vec2 tc = floor(sp - 0.5) + 0.5;
    vec2 f = sp - tc;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 o12 = w2 / w12;
    vec2 t0 = (tc - 1.0) * inkTexel;
    vec2 t3 = (tc + 2.0) * inkTexel;
    vec2 t12 = (tc + o12) * inkTexel;
    vec4 r = texture(prevState, vec2(t0.x, t0.y)) * w0.x * w0.y
           + texture(prevState, vec2(t12.x, t0.y)) * w12.x * w0.y
           + texture(prevState, vec2(t3.x, t0.y)) * w3.x * w0.y
           + texture(prevState, vec2(t0.x, t12.y)) * w0.x * w12.y
           + texture(prevState, vec2(t12.x, t12.y)) * w12.x * w12.y
           + texture(prevState, vec2(t3.x, t12.y)) * w3.x * w12.y
           + texture(prevState, vec2(t0.x, t3.y)) * w0.x * w3.y
           + texture(prevState, vec2(t12.x, t3.y)) * w12.x * w3.y
           + texture(prevState, vec2(t3.x, t3.y)) * w3.x * w3.y;
    return max(r, vec4(0.0));
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 uv = qt_TexCoord0;
    vec2 p = uv - 0.5;
    p.x *= aspect;

    vec4 d0 = dropSlot(0.0);
    vec4 d1 = dropSlot(1.0);
    vec4 d2 = dropSlot(2.0);

    // ---- transport ----
    vec2 v = velocity(p, d0, d1, d2);
    float dt = DT * inkFlow;
    // Midpoint back-trace: follows curved streamlines instead of cutting
    // across them, which keeps vortex cores tight.
    vec2 mid = p - v * dt * 0.5;
    vec2 v2 = velocity(mid, d0, d1, d2);
    vec2 back = p - v2 * dt;
    vec2 backUV = vec2(back.x / aspect, back.y) + 0.5;

    vec4 s = sampleCR(backUV);
    // Nothing flows in from outside the frame.
    vec2 inside = step(vec2(0.0), backUV) * step(backUV, vec2(1.0));
    s *= inside.x * inside.y;

    // Slow fade, so the water clears between drops instead of saturating.
    // The tree's own dye fades faster; it is replenished continuously.
    s *= vec4(0.99935, 0.99935, 0.99935, 0.9975);

    // ---- sources ----
    // A fresh drop: a dense bead that punches in over its first half second.
    vec4 add = vec4(0.0);
    for (int i = 0; i < 3; i++) {
        vec4 dr = i == 0 ? d0 : (i == 1 ? d1 : d2);
        float inject = smoothstep(0.0, 0.08, dr.z) * smoothstep(0.65, 0.25, dr.z);
        vec2 c = dropCenter(dr);
        float bead = exp(-dot(p - c, p - c) / (0.036 * 0.036));
        // Pick the dye: mostly one colour, sometimes a blend of two.
        float h = dr.w;
        vec3 pick = h < 0.30 ? vec3(1.0, 0.0, 0.0)
                  : h < 0.55 ? vec3(0.0, 1.0, 0.0)
                  : h < 0.80 ? vec3(0.0, 0.0, 1.0)
                  : h < 0.90 ? vec3(0.6, 0.0, 0.5) : vec3(0.0, 0.55, 0.6);
        add.rgb += pick * bead * inject * 0.30;
    }

    // Two slow seeps that wander the lower corners, trailing threads.
    float t = time * inkFlow;
    vec2 seepA = vec2(-aspect * 0.36 + sin(t * 0.071) * 0.25, 0.30 + sin(t * 0.053) * 0.08);
    vec2 seepB = vec2(aspect * 0.34 + sin(t * 0.063 + 2.0) * 0.25, 0.26 + cos(t * 0.047) * 0.10);
    add.g += exp(-dot(p - seepA, p - seepA) / 0.00012) * 0.030;
    add.b += exp(-dot(p - seepB, p - seepB) / 0.00012) * 0.030;

    // The tree bleeds from its outline, patchily, so the current carries
    // separate wisps off it rather than a uniform halo.
    float sdf = sdfAt(p);
    float rim = smoothstep(0.40, 0.49, sdf) * smoothstep(0.56, 0.50, sdf);
    float patchy = smoothstep(0.45, 0.80, fbm3(p * 9.0 + vec2(t * 0.11, -t * 0.07)));
    add.a += rim * patchy * 0.045;

    s += add;

    // Solid tree: dye cannot sit inside it.
    s *= 1.0 - treeAt(p);

    fragColor = clamp(s, 0.0, 4.0);
}
