#version 440

// Fire below the screen launches individual embers into an updraft. Drag
// slows their initial burst and wind gradually carries them sideways. Music
// controls births (bursts on the beat) and makes the fire bed flare on kicks;
// particles keep their own age, path and cooling.
// Smoke expands and disperses above the fire, behind the warm-lit mark.

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
    float audioBassPulse;
    float iconWarpScale;
    float edgeGlowWidth;
    float edgeGlowBrightness;
    float emberDensity;
    vec4 spark0;
    vec4 spark1;
    vec4 spark2;
    vec4 spark3;
    vec4 spark4;
    vec4 spark5;
    vec4 spark6;
    vec4 spark7;
    vec4 spark8;
    vec4 spark9;
    vec4 spark10;
    vec4 spark11;
    vec4 spark12;
    vec4 spark13;
    vec4 spark14;
    vec4 spark15;
    vec4 spark16;
    vec4 spark17;
    vec4 spark18;
    vec4 spark19;
    vec4 spark20;
    vec4 spark21;
    vec4 spark22;
    vec4 spark23;
    vec4 spark24;
    vec4 spark25;
    vec4 spark26;
    vec4 spark27;
    vec4 spark28;
    vec4 spark29;
    vec4 spark30;
    vec4 spark31;
    vec4 spark32;
    vec4 spark33;
    vec4 spark34;
    vec4 spark35;
    vec4 spark36;
    vec4 spark37;
    vec4 spark38;
    vec4 spark39;
    vec4 spark40;
    vec4 spark41;
    vec4 spark42;
    vec4 spark43;
    vec4 spark44;
    vec4 spark45;
    vec4 spark46;
    vec4 spark47;
    vec4 spark48;
    vec4 spark49;
    vec4 spark50;
    vec4 spark51;
    vec4 spark52;
    vec4 spark53;
    vec4 spark54;
    vec4 spark55;
    vec4 spark56;
    vec4 spark57;
    vec4 spark58;
    vec4 spark59;
    vec4 spark60;
    vec4 spark61;
    vec4 spark62;
    vec4 spark63;
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
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
}

float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.52; }
    return v;
}

// ------------------------------------------------------------------ heat ---

// Rising air over the fire bends everything seen through it. Strongest just
// above the bottom edge and along the centre, gone by the top of the screen.
float heatAmount(vec2 p) {
    float vertical = smoothstep(-0.30, 0.50, p.y);
    float lateral = smoothstep(1.30, 0.15, abs(p.x));
    return vertical * lateral;
}

vec2 heatOffset(vec2 p, float strength) {
    float n1 = fbm3(vec2(p.x * 8.0, p.y * 4.5 - time * 1.15));
    float n2 = fbm3(vec2(p.x * 6.5 + 31.7, p.y * 3.8 - time * 0.9));
    return vec2(n1 - 0.5, (n2 - 0.5) * 0.45) * strength * heatAmount(p);
}

// Individual airborne particles: launch velocity relaxes toward an updraft
// under drag. Small lateral gusts deflect the trajectory without bending the
// particle shape. Birth data is retained by the host, independent of audio.
float airborneSpark(vec2 p, vec4 birth) {
    float age = time - birth.x;
    if (birth.w < 0.5 || age < 0.0 || age > 4.4) return 0.0;
    float seed = birth.z;
    float drag = 1.6 + seed;
    float relax = (1.0 - exp(-drag * age)) / drag;
    float rise = (0.19 + seed * 0.035) * age + (0.14 + seed * 0.08) * relax;
    float wind = 0.028 * sin(birth.x * 0.31 + seed * 6.28);
    float lateral = wind * age + (seed - 0.5) * 0.13 * relax;
    // Two gentle gust scales round off the path while upward momentum stays dominant.
    lateral += 0.014 * (sin(age * 2.6 + seed * 19.0) - sin(seed * 19.0));
    lateral += 0.006 * (sin(age * 4.1 + seed * 7.0) - sin(seed * 7.0));
    // Births span the same fraction of every monitor. Radius and drift remain
    // in height units, so ultrawide displays never stretch the particles.
    vec2 pos = vec2(birth.y * aspect / (16.0 / 9.0) + lateral, 0.55 - rise);
    vec2 velocity = vec2(wind + (seed - 0.5) * 0.13 * exp(-drag * age)
                        + 0.0364 * cos(age * 2.6 + seed * 19.0)
                        + 0.0246 * cos(age * 4.1 + seed * 7.0),
                        -(0.19 + seed * 0.035) - (0.14 + seed * 0.08) * exp(-drag * age));
    vec2 d = p - pos;
    float radius = mix(0.0008, 0.00165, seed);
    if (abs(d.x) > 0.015 || abs(d.y) > 0.025) return 0.0;
    vec2 tail = -velocity * 0.020;
    float along = clamp(dot(d, tail) / max(dot(tail, tail), 1e-7), 0.0, 1.0);
    float distanceToTrail = length(d - tail * along);
    float aa = max(fwidth(distanceToTrail), 0.0003);
    float core = 1.0 - smoothstep(radius, radius + aa, distanceToTrail);
    float glow = exp(-length(d) / (radius * 2.2)) * 0.18;
    float cooling = (1.0 - smoothstep(1.6, 4.4, age)) * smoothstep(0.0, 0.12, age);
    // A tiny irregular glimmer suggests a tumbling ember catching the light.
    float glimmer = 0.94 + 0.06 * sin(age * (7.0 + seed * 5.0) + seed * 31.0);
    return (core * (1.0 - along * 0.7) + glow) * cooling * glimmer;
}

// Smoke rises from a broad source below the screen, expands, and disperses.
// Upward advection and a slow prevailing wind replace the shared curl warp.
float smokePlume(vec2 p) {
    p.x /= max(0.6, aspect / (16.0 / 9.0));
    float height = max(0.0, 0.55 - p.y);
    float center = 0.08 * sin(time * 0.22 - height * 2.6) + height * 0.09;
    float width = 0.20 + height * 0.40;
    vec2 q = vec2((p.x - center) * 3.8, p.y * 3.3 + time * 0.44);
    float billow = fbm5(q + vec2(fbm3(q * 0.7 + 8.1) * 0.65, 0.0));
    float body = exp(-pow((p.x - center) / width, 2.0));
    float disperse = 1.0 - smoothstep(0.45, 1.15, height);
    return smoothstep(0.28, 0.72, billow) * body * disperse;
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;
    p.x *= aspect;

    // Everything in the scene is viewed through the rising heat.
    // Shimmer is confined to the mark; sparks remain rigid particles.

    // ---- background: night air, warmer toward the fire below ----
    float glowUp = smoothstep(-0.25, 0.62, p.y);
    vec3 warm = mix(accentColor.rgb, urgentColor.rgb, 0.45);
    vec3 col = mix(bgColor.rgb * 0.75, bgColor.rgb, 0.5);
    col += warm * glowUp * glowUp * 0.10;

    // A smouldering bed just below frame lights the spark origins. Screen-
    // relative width matches their spawn range on wide monitors.
    float bedX = p.x / max(aspect, 0.001);
    float bedHeight = max(0.0, 0.5 - p.y);
    float bedSpread = 1.0 - smoothstep(0.30, 0.49, abs(bedX));
    float coal = fbm3(vec2(bedX * 24.0, time * 0.20));
    // The bed flares a little on each kick, so the fire keeps the beat.
    float smoulder = (0.78 + coal * 0.35) * (1.0 + audioBassPulse * 0.55);
    vec3 coalColor = mix(warm, vec3(1.0, 0.30, 0.065), 0.60);
    float bedGlow = exp(-bedHeight * 24.0) * 0.20
                  + exp(-bedHeight * 65.0) * coal * 0.16;
    col += coalColor * bedGlow * bedSpread * smoulder;

    float smoke = smokePlume(p);
    vec3 smokeTint = mix(bgColor.rgb, mutedColor.rgb, 0.40);
    col = mix(col, smokeTint, smoke * 0.40);

    // ---- icon ----
    // The mark is seen through the same shimmer, but at a fraction of the
    // strength -- a logo that wobbles as hard as the open air reads as broken
    // rather than hot.
    vec2 pIcon = p + heatOffset(p, 0.004);
    float iconScale = 0.6;
    vec2 iconUV = pIcon / iconScale + 0.5;
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

    // ---- the tree, before the near ember layers ----
    // Lit from below: the roots catch the fire, the canopy stays dark.
    float low = inIcon ? smoothstep(0.30, 1.0, iconUV.y) : 0.0;
    vec3 treeDark = mix(bgColor.rgb * 0.30, mutedColor.rgb, 0.22);
    col = mix(col, treeDark, mask.a * 0.95);
    col += warm * mask.a * low * 0.34;

    col += mix(warm, fgColor.rgb, 0.25) * edge
         * (0.28 + low * 0.85 + audioPeak * 0.05) * edgeGlowBrightness;

    // Music controls only births. Existing embers rise and cool independently.
    vec3 hotColor = mix(warm, fgColor.rgb, 0.45);
    float e = 0.0;
    e += airborneSpark(p, spark0);
    e += airborneSpark(p, spark1);
    e += airborneSpark(p, spark2);
    e += airborneSpark(p, spark3);
    e += airborneSpark(p, spark4);
    e += airborneSpark(p, spark5);
    e += airborneSpark(p, spark6);
    e += airborneSpark(p, spark7);
    e += airborneSpark(p, spark8);
    e += airborneSpark(p, spark9);
    e += airborneSpark(p, spark10);
    e += airborneSpark(p, spark11);
    e += airborneSpark(p, spark12);
    e += airborneSpark(p, spark13);
    e += airborneSpark(p, spark14);
    e += airborneSpark(p, spark15);
    e += airborneSpark(p, spark16);
    e += airborneSpark(p, spark17);
    e += airborneSpark(p, spark18);
    e += airborneSpark(p, spark19);
    e += airborneSpark(p, spark20);
    e += airborneSpark(p, spark21);
    e += airborneSpark(p, spark22);
    e += airborneSpark(p, spark23);
    e += airborneSpark(p, spark24);
    e += airborneSpark(p, spark25);
    e += airborneSpark(p, spark26);
    e += airborneSpark(p, spark27);
    e += airborneSpark(p, spark28);
    e += airborneSpark(p, spark29);
    e += airborneSpark(p, spark30);
    e += airborneSpark(p, spark31);
    e += airborneSpark(p, spark32);
    e += airborneSpark(p, spark33);
    e += airborneSpark(p, spark34);
    e += airborneSpark(p, spark35);
    e += airborneSpark(p, spark36);
    e += airborneSpark(p, spark37);
    e += airborneSpark(p, spark38);
    e += airborneSpark(p, spark39);
    e += airborneSpark(p, spark40);
    e += airborneSpark(p, spark41);
    e += airborneSpark(p, spark42);
    e += airborneSpark(p, spark43);
    e += airborneSpark(p, spark44);
    e += airborneSpark(p, spark45);
    e += airborneSpark(p, spark46);
    e += airborneSpark(p, spark47);
    e += airborneSpark(p, spark48);
    e += airborneSpark(p, spark49);
    e += airborneSpark(p, spark50);
    e += airborneSpark(p, spark51);
    e += airborneSpark(p, spark52);
    e += airborneSpark(p, spark53);
    e += airborneSpark(p, spark54);
    e += airborneSpark(p, spark55);
    e += airborneSpark(p, spark56);
    e += airborneSpark(p, spark57);
    e += airborneSpark(p, spark58);
    e += airborneSpark(p, spark59);
    e += airborneSpark(p, spark60);
    e += airborneSpark(p, spark61);
    e += airborneSpark(p, spark62);
    e += airborneSpark(p, spark63);
    col += hotColor * e * 0.80;

    // Smoke drifts in front of the nearest embers as well as behind them.
    col = mix(col, smokeTint, smoke * 0.16);

    // Soft highlight rolloff so a cluster of flares never clips flat.
    col = col / (1.0 + max(col - vec3(0.8), vec3(0.0)));

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
