#version 440

// Thunder -- a storm sky. A cloud deck fills the top of the screen with a
// ragged, billowing underside. Most strikes never leave the cloud: they light
// it from the inside, and what you see is the cloud mass glowing with all its
// internal structure picked out, shadowed by whatever cloud sits between the
// strike and your eye. Now and then one drops out of the cloud base as a real
// bolt, always near the middle of the screen. Rain hangs below, mostly
// invisible until a flash lights it up.

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
    float audioRelative;
    float audioBassPulse;
    float flashTime;
    float iconWarpScale;
    float edgeGlowWidth;
    float edgeGlowBrightness;
    float thunderRain;
};

layout(binding = 1) uniform sampler2D maskSource;
layout(binding = 2) uniform sampler2D distSource;

// The deck: solid from the top of the screen down to CLOUD_SOLID, then a
// ragged billowing underside that finally clears around CLOUD_BASE.
const float CLOUD_BASE = -0.13;
const float CLOUD_SOLID = -0.42;
const float OCEAN_HORIZON = 0.19;

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
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
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

// Linear-interpolated value noise: the lack of smoothing is the point, it
// leaves sharp kinks at the lattice, which is what makes a bolt read as
// forked lightning rather than a wavy ribbon.
float jagged(float x, float seed) {
    float i = floor(x);
    float f = fract(x);
    return mix(hash1(i + seed), hash1(i + 1.0 + seed), f);
}

// ---------------------------------------------------------------- cloud ---

// Cloud sampling space: stretched horizontally and squashed vertically so the
// billows lie flat like a real deck, and drifting slowly downwind.
vec2 cloudSpace(vec2 p) {
    return vec2(p.x * 0.85 + time * 0.011, p.y * 2.1 + time * 0.002);
}

// Full-detail density, with a domain warp for the cauliflower billowing.
float cloudDensity(vec2 p) {
    vec2 q = cloudSpace(p);
    vec2 w = vec2(fbm3(q * 0.7 + vec2(0.0, time * 0.006)),
                  fbm3(q * 0.7 + vec2(5.2, -time * 0.005)));
    float structure = smoothstep(0.20, 0.78, fbm5(q + w * 0.85));

    // Ragged underside: the boundary itself rides on the billow field, so the
    // deck sags and lifts instead of ending on a straight line.
    float base = CLOUD_BASE + (structure - 0.5) * 0.20;
    float cover = 1.0 - smoothstep(CLOUD_SOLID, base, p.y);

    // A thin uniform haze keeps the deck continuous, while `structure` keeps
    // its full contrast -- that contrast is what a strike has to reveal, so
    // flattening it here would light the cloud as a smooth blob.
    return (0.30 + structure * 0.85) * cover;
}

// Cheap version for the in-cloud light march -- only the coarse mass matters
// for how far light gets, and this runs several times per pixel.
float cloudDensityLite(vec2 p) {
    vec2 q = cloudSpace(p);
    float structure = smoothstep(0.20, 0.78, fbm3(q));
    float cover = 1.0 - smoothstep(CLOUD_SOLID, CLOUD_BASE, p.y);
    return (0.30 + structure * 0.85) * cover;
}

// How much of a strike's light survives the cloud between `p` and the strike.
// This is what makes an in-cloud flash look volumetric: cloud in the way goes
// dark, cloud in the open lights up, and the boundary between them shows the
// billow structure in silhouette.
float transmittance(vec2 p, vec2 lightPos) {
    vec2 delta = lightPos - p;
    float dist = length(delta);
    vec2 stepV = delta / 6.0;
    float acc = 0.0;
    vec2 s = p;
    for (int i = 0; i < 6; i++) {
        s += stepV;
        acc += cloudDensityLite(s);
    }
    acc *= dist / 6.0;
    return exp(-acc * 12.0);
}

// ---------------------------------------------------------------- strike ---

// Horizontal position of a bolt channel at height y.
float boltX(float y, float seed, float baseX, float spread) {
    float x = baseX;
    float amp = spread;
    float freq = 9.0;
    for (int i = 0; i < 4; i++) {
        x += (jagged(y * freq, seed + float(i) * 37.0) - 0.5) * amp;
        amp *= 0.5;
        freq *= 2.4;
    }
    return x;
}

// One lightning channel from yTop down to yTip. Returns core + halo energy.
float boltChannel(vec2 p, float seed, float baseX, float yTop, float yTip, float spread) {
    if (p.y < yTop || p.y > yTip) return 0.0;
    float x = boltX(p.y, seed, baseX, spread);
    float d = abs(p.x - x);

    // Taper: full width where it leaves the cloud, needle-thin at the tip.
    float along = (p.y - yTop) / max(yTip - yTop, 1e-3);
    float taper = 1.0 - along * 0.75;

    float core = smoothstep(0.0045 * taper, 0.0, d);
    float halo = exp(-d * 42.0) * 0.45 * taper;
    float fade = 1.0 - smoothstep(0.82, 1.0, along);
    return (core + halo) * fade;
}

// ------------------------------------------------------------------ rain ---

// One sheet of rain at a given depth. Far sheets are finer, denser and
// slower; near ones are sparser and fall faster.
float rainSheet(vec2 p, float xScale, float yScale, float speed, float slant,
                float thickness, float seedOff) {
    vec2 q = vec2(p.x * xScale + p.y * slant, p.y * yScale - time * speed);
    vec2 id = floor(q);
    vec2 f = fract(q);
    if (hash21(id + seedOff) < 0.83) return 0.0;
    // Jitter each streak inside its cell so the sheet does not read as a grid.
    float jitter = (hash21(id.yx + seedOff * 1.7) - 0.5) * 0.7;
    float across = smoothstep(thickness, 0.0, abs(f.x - 0.5 - jitter));
    float along = smoothstep(0.0, 0.14, f.y) * (1.0 - smoothstep(0.52, 0.95, f.y));
    return across * along;
}

// The streak pattern itself, with no banding applied -- shared by the veil
// below the deck and the graze that reaches the near water.
float rainSheetsRaw(vec2 p) {
    return rainSheet(p, 230.0, 26.0, 7.0, 7.0, 0.05, 0.0) * 0.62
         + rainSheet(p, 150.0, 17.0, 10.5, 9.0, 0.07, 41.0) * 0.9;
}

// Thin slanted streaks falling below the deck. Deliberately almost invisible
// on its own -- it exists so a flash has something to catch.
float rainVeil(vec2 p) {
    float acc = rainSheetsRaw(p);
    // Only below the deck, thinning out toward the bottom of the screen.
    float band = smoothstep(CLOUD_BASE - 0.06, CLOUD_BASE + 0.22, p.y) *
                 (1.0 - smoothstep(OCEAN_HORIZON - 0.06, OCEAN_HORIZON + 0.02, p.y));
    return acc * band;
}

// A last graze of the same streaks right where the rain would be hitting the
// water, just past the horizon. Fades out quickly with depth so it reads as
// the near shoreline, not a pattern painted across the whole sea.
float rainOnWater(vec2 p) {
    float shoreBand = 1.0 - smoothstep(OCEAN_HORIZON - 0.01, OCEAN_HORIZON + 0.09, p.y);
    return rainSheetsRaw(p) * shoreBand;
}

// ----------------------------------------------------------------- ocean ---

// World-space waves and their analytic slope. Distant short waves fade out
// before they become subpixel stripes. The sea has a level distant horizon.
vec3 seaHeightSlope(vec2 q, float distance) {
    vec3 sum = vec3(0.0);
    float frequency = 0.72;
    float amplitude = 0.115;
    for (int i = 0; i < 6; i++) {
        float fi = float(i);
        vec2 direction = normalize(vec2(sin(fi * 2.399 + 0.4), cos(fi * 2.399 + 0.4)));
        float phase = dot(q, direction) * frequency
                    - time * sqrt(frequency * 1.8) + fi * 4.17;
        float fade = 1.0 / (1.0 + distance * frequency * 0.035);
        sum.x += sin(phase) * amplitude * fade;
        sum.yz += cos(phase) * amplitude * frequency * direction * fade;
        frequency *= 1.91;
        // Higher octaves keep more of their energy than a calm sea would --
        // that's what turns smooth swells into a choppier, wind-driven surface.
        amplitude *= 0.53;
    }
    return sum;
}

vec3 renderOcean(vec2 p, vec3 flashColor, float env, float flashX) {
    vec3 eye = vec3(0.0, 1.2, 0.0);
    vec3 ray = normalize(vec3(p.x, -(p.y - OCEAN_HORIZON), 0.85));
    float travel = min(160.0, -eye.y / min(ray.y, -0.001));
    for (int i = 0; i < 4; i++) {
        vec3 at = eye + ray * travel;
        float h = seaHeightSlope(at.xz, travel).x;
        travel = mix(travel, min(160.0, (h - eye.y) / min(ray.y, -0.001)), 0.65);
    }
    vec3 at = eye + ray * travel;
    vec3 wave = seaHeightSlope(at.xz, travel);
    vec3 normal = normalize(vec3(-wave.y, 1.0, -wave.z));
    float fresnel = pow(1.0 - max(dot(normal, -ray), 0.0), 4.0);
    vec3 reflected = reflect(ray, normal);
    float skyLight = smoothstep(-0.12, 0.75, reflected.y);
    vec3 deep = bgColor.rgb * 0.32;
    vec3 reflectedSky = mix(bgColor.rgb * 0.5, mutedColor.rgb * 0.43, skyLight);
    vec3 water = mix(deep, reflectedSky, 0.22 + fresnel * 0.66);
    // Crests reveal shape through soft shading, without painted foam lines.
    water += mix(accentColor.rgb, mutedColor.rgb, 0.65)
           * max(0.0, wave.x + 0.035) * 0.36;
    vec3 lightDirection = normalize(vec3(flashX * 1.8, 0.40, 1.8));
    float glint = pow(max(dot(reflected, lightDirection), 0.0), 58.0);
    water += flashColor * env * (glint * 0.48 + fresnel * 0.025);
    float mist = 1.0 - exp(-travel * 0.035);
    return mix(water, mix(bgColor.rgb, mutedColor.rgb, 0.18), mist * 0.72);
}

// ------------------------------------------------------------------ main ---

void main() {
    vec2 p = qt_TexCoord0 - 0.5;
    p.x *= aspect;

    // ---- icon lookup ----
    float iconScale = 0.6;
    vec2 iconUV = p / iconScale + 0.5;
    bool inIcon = (iconUV.x >= 0.0 && iconUV.x <= 1.0 && iconUV.y >= 0.0 && iconUV.y <= 1.0);
    vec4 mask = inIcon ? texture(maskSource, iconUV) : vec4(0.0);
    float sdfHere = inIcon ? texture(distSource, iconUV).r : 0.0;

    float edge = 0.0;
    vec2 alphaGrad = vec2(0.0);
    if (inIcon) {

        float et = edgeGlowWidth / 1024.0;
        float aL = texture(maskSource, clamp(iconUV - vec2(et, 0.0), 0.0, 1.0)).a;
        float aR = texture(maskSource, clamp(iconUV + vec2(et, 0.0), 0.0, 1.0)).a;
        float aU = texture(maskSource, clamp(iconUV - vec2(0.0, et), 0.0, 1.0)).a;
        float aD = texture(maskSource, clamp(iconUV + vec2(0.0, et), 0.0, 1.0)).a;
        alphaGrad = vec2(aR - aL, aD - aU);
        edge = clamp(length(alphaGrad), 0.0, 1.0);
    }
    // The storm is not bent around the tree any more -- the mark is a solid
    // object standing in the weather, not something dissolved into it.
    vec2 pw = p;

    // ---- this strike's identity ----
    // Everything about a strike is derived from when it happened, so one
    // uniform carries position, kind and channel shape all at once.
    float strikeId = floor(flashTime * 10.0) + 1.0;
    float h1 = hash1(strikeId * 1.7);
    float h2 = hash1(strikeId * 3.1 + 11.0);
    float h3 = hash1(strikeId * 5.9 + 23.0);
    float h4 = hash1(strikeId * 7.3 + 37.0);

    bool isBolt = h3 > 0.62;
    // In-cloud flashes wander across the deck. Bolts stay in the middle of
    // the screen but step clear of the tree, which owns the centre -- a
    // channel drawn straight down through the mark just buries it.
    float side = h1 < 0.5 ? -1.0 : 1.0;
    float flashX = isBolt ? side * mix(0.40, 0.88, h4) : mix(-1.05, 1.05, h1);
    float flashY = mix(CLOUD_BASE - 0.30, CLOUD_BASE - 0.06, h2);
    vec2 flashPos = vec2(flashX, flashY);

    // ---- strike envelope ----
    // Real lightning is a burst of strokes a few tens of ms apart, then a
    // slow glow as the channel and the cloud cool.
    float t = time - flashTime;

    // The return strokes: a handful of pulses a few tens of milliseconds
    // apart, which is what gives a single strike its stutter.
    float strokes = exp(-t * 24.0)
                  + 0.62 * exp(-max(t - 0.085, 0.0) * 28.0)
                  + 0.38 * exp(-max(t - 0.165, 0.0) * 26.0)
                  + 0.22 * exp(-max(t - 0.30, 0.0) * 22.0) * step(0.5, h4);

    // Some cells do not fire once and stop -- they flicker, throwing a train
    // of separate flashes over the next second or two, each weaker than the
    // last as the cell discharges.
    if (h2 > 0.42) {
        float count = 2.0 + floor(h4 * 3.0);
        for (int i = 1; i <= 4; i++) {
            float fi = float(i);
            if (fi > count) break;
            float delay = fi * mix(0.26, 0.72, hash1(strikeId + fi * 3.1));
            float amp = pow(0.60, fi) * mix(0.65, 1.0, hash1(strikeId + fi * 7.7));
            float decay = mix(13.0, 24.0, hash1(strikeId + fi * 11.3));
            strokes += amp * exp(-max(t - delay, 0.0) * decay) * step(delay, t);
        }
    }

    float afterglow = 0.30 * exp(-t * 2.6);
    float env = max(strokes + afterglow, 0.0) * step(0.0, t);

    // Loudness here is relative to the current song's rolling baseline, not
    // the system volume. It only gives an existing strike a restrained lift;
    // the host's relative-loudness detector decides when music creates one.
    env *= 1.0 + audioRelative * 0.24;
    env = min(env, 1.9);

    // ---- sky ----
    // Night gradient, a touch lighter toward the horizon where light leaks in
    // under the deck.
    vec3 night = mix(bgColor.rgb * 0.55, bgColor.rgb * 0.30, smoothstep(0.5, -0.5, p.y));
    float horizon = smoothstep(0.1, 0.55, p.y) * 0.10;
    vec3 col = night + mutedColor.rgb * horizon;

    // ---- cloud deck ----
    float dens = cloudDensity(pw);

    // Body tone: a storm deck still reads lighter than the night behind it.
    vec3 cloudBody = mix(bgColor.rgb * 0.9, mutedColor.rgb, 0.62)
                   + accentColor.rgb * 0.05;
    col = mix(col, cloudBody, clamp(dens * 1.15, 0.0, 1.0));

    // Standing relief: sample a little higher up -- where the cloud above is
    // thinner, more ambient skylight reaches this billow, so its top face
    // lifts out of the mass and the deck has form even between strikes.
    float above = cloudDensityLite(pw + vec2(0.0, -0.07));
    float relief = clamp(dens - above, 0.0, 1.0);
    col += mix(mutedColor.rgb, accentColor.rgb, 0.40) * relief * 0.50;

    // ...and the underside of the deck falls away into its own shadow.
    float underside = smoothstep(0.05, 0.4, dens) *
                      smoothstep(CLOUD_SOLID + 0.10, CLOUD_BASE, pw.y);
    col = mix(col, col * 0.52, underside * 0.65);

    vec3 flashColor = mix(accentColor.rgb, fgColor.rgb, 0.30);

    // Distant sheet lightning on the beat: a patch of the deck, wandering
    // slowly, glows from inside on each kick. Faint, but it keeps time.
    float patchN = vnoise(vec2(pw.x * 1.3 - time * 0.07, 3.0));
    float flickerPatch = smoothstep(0.45, 0.85, patchN);
    col += flashColor * pow(dens, 1.5) * flickerPatch * audioBassPulse * 0.20;

    // Rain is always falling. Unlit it is only just above the noise floor --
    // enough that it never appears out of nowhere when a strike lands, but a
    // real subtle streak against the night, not zero.
    float rainAmount = rainVeil(pw) * thunderRain;
    col += mix(mutedColor.rgb, accentColor.rgb, 0.35) * rainAmount * 0.42;

    if (env > 0.004) {
        float distToFlash = length(pw - flashPos);

        // Light inside the deck: how much cloud is here to scatter, times how
        // much light got here through the cloud in between.
        float trans = transmittance(pw, flashPos);
        float falloff = 1.0 / (1.0 + distToFlash * distToFlash * 9.0);
        float inCloud = pow(dens, 1.5) * trans * falloff;

        // The strike's own core blooms through whatever is in front of it --
        // but only where there is cloud to light, so it never reads as a bare
        // hot dot hanging in clear air below the deck.
        float coreBloom = exp(-distToFlash * 11.0) * trans * smoothstep(0.05, 0.35, dens);

        col += flashColor * env * (inCloud * 1.9 + coreBloom * 0.30);

        // Light spilling out of the cloud base into the air below.
        float belowDeck = smoothstep(CLOUD_BASE - 0.05, CLOUD_BASE + 0.25, p.y);
        float spill = belowDeck * (1.0 / (1.0 + distToFlash * distToFlash * 3.0));
        col += flashColor * env * spill * 0.30;

        // A strike lights the falling rain from the side.
        col += flashColor * rainAmount * env * 0.30;

        // ---- the visible bolt ----
        if (isBolt) {
            float yTop = flashY + 0.02;
            float yTip = mix(0.18, 0.44, h4);
            float b = boltChannel(pw, strikeId, flashX, yTop, yTip, 0.085);

            // Two forks branching off the main channel, each starting where
            // the parent actually is at that height so they stay connected.
            float forkY1 = mix(yTop + 0.06, yTip * 0.55, h1);
            float forkBase1 = boltX(forkY1, strikeId, flashX, 0.085);
            b += 0.55 * boltChannel(pw, strikeId + 61.0, forkBase1, forkY1,
                                    forkY1 + mix(0.07, 0.17, h2), 0.075);

            float forkY2 = mix(yTop + 0.10, yTip * 0.75, h2);
            float forkBase2 = boltX(forkY2, strikeId, flashX, 0.085);
            b += 0.40 * boltChannel(pw, strikeId + 127.0, forkBase2, forkY2,
                                    forkY2 + mix(0.05, 0.13, h3), 0.065);

            // The channel itself only shines during the strokes, not the
            // afterglow -- the cloud keeps glowing after the channel is gone.
            float channelEnv = min(strokes, 2.0) * step(0.0, t);
            col += flashColor * b * channelEnv * 1.7;
        }
    }

    // Composite water after sky lighting: bolts stop at the water, whose
    // reflections come from the same moving surface normals as its shading.
    if (p.y > OCEAN_HORIZON) {
        float seaMask = smoothstep(OCEAN_HORIZON, OCEAN_HORIZON + 0.006, p.y);
        col = mix(col, renderOcean(p, flashColor, env, flashX), seaMask);

        // Rain grazing the near water, on top of its reflections.
        float graze = rainOnWater(pw) * thunderRain * seaMask;
        col += mix(mutedColor.rgb, accentColor.rgb, 0.35) * graze * 0.35;
        col += flashColor * graze * env * 0.30;
    }

    // How much of the current strike reaches the tree, and from where.
    vec2 toFlash = flashPos - p;
    float reach = env / (1.0 + dot(toFlash, toFlash) * 1.3);

    // ---- its reflection ----
    // The tree stands in the water, so it is mirrored about its own base,
    // broken up by the chop and fading with depth. Dark on the water, and a
    // strike lights the reflected rim just as it lights the real one.
    const float TREE_BASE = 0.30;
    if (p.y > TREE_BASE) {
        float depth = p.y - TREE_BASE;
        vec2 rp = vec2(p.x, TREE_BASE - depth);
        rp.x += (vnoise(vec2(p.x * 6.0, p.y * 60.0 - time * 1.4)) - 0.5) * (0.003 + depth * 0.09);
        vec2 ruv = rp / iconScale + 0.5;
        if (ruv.x >= 0.0 && ruv.x <= 1.0 && ruv.y >= 0.0 && ruv.y <= 1.0) {
            float ra = texture(maskSource, ruv).a;
            float fade = exp(-depth * 6.5);
            col = mix(col, col * 0.30, ra * fade * 0.85);
            col += flashColor * ra * reach * fade * 0.08;
        }
    }

    // ---- the tree ----
    // A solid object in the storm: near-black, darker than any sky, so every
    // strike throws it into relief instead of washing it into the cloud.
    vec3 behind = col;
    col = mix(col, bgColor.rgb * 0.08, mask.a);

    // Light wrap: whatever is lit behind the tree bleeds around its outline.
    col += behind * edge * 0.45;

    // Strike light is directional: only the edges that face the strike catch
    // it, so a strike on the right lights the tree's right side.
    vec2 outward = -alphaGrad / max(length(alphaGrad), 1e-4);
    float facing = max(dot(outward, normalize(toFlash + vec2(1e-4))), 0.0);
    col += flashColor * edge * facing * reach * 2.0 * edgeGlowBrightness;

    // At rest just a faint cool outline, enough to find it in the dark.
    col += mix(mutedColor.rgb, accentColor.rgb, 0.3) * edge * 0.19 * edgeGlowBrightness;

    // Rain falls in front of it as well as behind.
    col += mix(mutedColor.rgb, accentColor.rgb, 0.35) * rainAmount * 0.30 * mask.a;
    col += flashColor * rainAmount * env * 0.25 * mask.a;

    // Soft-knee highlight rolloff. The dark scene passes through untouched,
    // but a strike compresses instead of clipping, so the lit cloud keeps its
    // billow structure rather than burning out to a flat white disc.
    col = col / (1.0 + max(col - vec3(0.58), vec3(0.0)));

    fragColor = vec4(col, 1.0) * qt_Opacity;
}
