import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import QtQuick.Effects
import QtQuick.Shapes
import qs.Commons
import qs.Ui

Item {
  id: root

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateHome: home + "/.local/state"
  readonly property string currentBackgroundLink: stateHome + "/omarchy/current/background"
  readonly property string configHome: home + "/.config"
  readonly property string shaderStateDir: stateHome + "/omarchy/wallpaper-shader"
  readonly property string iconDir: configHome + "/omarchy/branding/wallpaper"
  // Where this plugin was installed, whatever its id or checkout location.
  readonly property string pluginDir: decodeURIComponent(String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, ""))
  readonly property string audioConfigPath: pluginDir + "/audio-cava.conf"
  // Tuning lives outside the plugin folder so `omarchy plugin update` (a
  // fast-forward merge) never collides with a user's edits.
  readonly property string shaderConfigPath: configHome + "/omarchy/wallpaper-shader.conf"
  readonly property var shaderNames: ["aurora", "thunder", "embers", "nebula", "ink", "weather"]

  property real cfgAudioLevelScale: 1.0
  property real cfgAudioPeakScale: 1.0
  property real cfgIconWarpScale: 1.0
  property real cfgEdgeGlowWidth: 2.0
  property real cfgEdgeGlowBrightness: 1.0
  property real cfgThunderAmbientMinS: 7.0
  property real cfgThunderAmbientMaxS: 20.0
  property real cfgThunderRain: 0.20
  property real cfgEmberDensity: 1.0
  property real cfgNebulaDrift: 1.0
  property real cfgInkFlow: 1.0
  property real cfgAuroraHueSpread: 60.0
  property real cfgAuroraRays: 1.0
  property real cfgWeatherPreviewCode: -1
  property real cfgWeatherPreviewPhase: -1

  function parseShaderConfig(rawText) {
    var lines = String(rawText || "").split("\n")
    var map = {}
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim()
      if (!line || line.charAt(0) === "#") continue
      var eq = line.indexOf("=")
      if (eq < 0) continue
      var key = line.slice(0, eq).trim()
      var val = parseFloat(line.slice(eq + 1).trim())
      if (!isNaN(val)) map[key] = val
    }
    cfgAudioLevelScale = map.audio_level_scale !== undefined ? map.audio_level_scale : 1.0
    cfgAudioPeakScale = map.audio_peak_scale !== undefined ? map.audio_peak_scale : 1.0
    cfgIconWarpScale = map.icon_warp_scale !== undefined ? map.icon_warp_scale : 1.0
    cfgEdgeGlowWidth = map.edge_glow_width !== undefined ? map.edge_glow_width : 2.0
    cfgEdgeGlowBrightness = map.edge_glow_brightness !== undefined ? map.edge_glow_brightness : 1.0
    cfgThunderAmbientMinS = map.thunder_ambient_min_s !== undefined ? map.thunder_ambient_min_s : 7.0
    cfgThunderAmbientMaxS = map.thunder_ambient_max_s !== undefined ? map.thunder_ambient_max_s : 20.0
    cfgThunderRain = map.thunder_rain !== undefined ? map.thunder_rain : 0.20
    cfgEmberDensity = map.ember_density !== undefined ? map.ember_density : 1.0
    cfgNebulaDrift = map.nebula_drift !== undefined ? map.nebula_drift : 1.0
    cfgInkFlow = map.ink_flow !== undefined ? map.ink_flow : 1.0
    cfgAuroraHueSpread = map.aurora_hue_spread !== undefined ? map.aurora_hue_spread : 60.0
    cfgAuroraRays = map.aurora_rays !== undefined ? map.aurora_rays : 1.0
    cfgWeatherPreviewCode = map.weather_preview_code !== undefined ? map.weather_preview_code : -1
    cfgWeatherPreviewPhase = map.weather_preview_phase !== undefined ? map.weather_preview_phase : -1
    if (typeof recomputeWeather === "function") recomputeWeather()
  }

  property FileView shaderConfigFile: FileView {
    id: shaderConfigFile
    path: root.shaderConfigPath
    watchChanges: true
    printErrors: false
    onLoaded: root.parseShaderConfig(text())
    onFileChanged: reload()
    onLoadFailed: root.parseShaderConfig("")
  }

  property string currentBackground: ""
  property string displayedBackground: ""
  property string incomingBackground: ""
  property string oldBackground: ""
  property bool finishingTransition: false
  property int backgroundVersion: 0
  property int revealStartedVersion: -1
  property int pendingThemeVersion: -1
  property string pendingColorsRaw: ""
  property string pendingShellRaw: ""
  property real revealProgress: 1

  property bool shaderEnabled: false
  property string shaderName: "aurora"
  property real shaderTime: 0
  property int iconVersion: 0

  property bool audioEnabled: true
  // Weather test panel (omarchy-wallpaper-shader --testing): live overrides
  // that sit above the config's preview keys and the real forecast. -1 (and
  // -999 for temperature) means "not overridden".
  property bool testingEnabled: false
  property real testCode: -1
  property real testPhase: -1
  property real testWind: -1
  property real testTemp: -999
  property real testSeason: -1
  // Easter eggs forced on from the test panel (they also happen by themselves).
  property bool eggCampfire: false
  property bool eggHikers: false
  property bool eggAurora: false
  property bool eggBirds: false
  // Fraction of the year (0 = 1 Jan), for seasonal grass and leaves.
  property real wxSeason: 0.5
  property real audioLevel: 0
  property real audioPeak: 0
  property real audioBass: 0
  property real audioMid: 0
  property real audioTreble: 0
  property real audioBaseline: 0
  property real audioRelative: 0
  // Per-band beat pulses: each band against its own rolling baseline, so a
  // kick or a hi-hat snaps the value up and it decays over ~0.2 s. Shaders
  // use these (not the absolute levels) for anything meant to read as
  // "reacting to the music" -- absolute levels sit near their average and
  // mostly just brighten everything uniformly.
  property real audioBassBase: 0
  property real audioTrebleBase: 0
  property real audioBassPulse: 0
  property real audioTreblePulse: 0
  property real flashTime: -10
  property real auroraTime: 0
  property var sparks: []
  property real sparkBudget: 0
  property int sparkCursor: 0

  // ---- weather shader state (live data from omarchy-wallpaper-weather) ----
  property bool wxOk: false
  property real wxCodeLive: -1
  property real wxCloudLive: -1
  property real wxPrecipLive: 0
  property real wxWindLive: 0
  property real wxWindDirLive: 270
  property real wxTempLive: 10
  property real wxSunrise: 0
  property real wxSunset: 0
  property real wxSunriseNext: 0
  // Normalised values the shader reads.
  property real wxSunPhase: 0.5
  property real wxMoonPhase: 0.5
  property real wxCloudN: 0.3
  property real wxRainN: 0
  property real wxSnowN: 0
  property real wxFogN: 0
  property real wxStormN: 0
  property real wxWindN: 0.2
  // Sideways component of the wind as seen on screen, facing north: +1 blows
  // left to right (a westerly), -1 right to left. Kept away from zero so a
  // northerly still visibly moves things.
  property real wxWindDirN: 1
  property real testWindDir: -999
  // Distance the wind has carried the clouds, integrated so a change of
  // speed or direction never makes the sky jump.
  property real windTravel: 0
  property real wxTempN: 10

  function advanceSparks(dt) {
    if (shaderName !== "embers") return
    var energy = audioEnabled ? Math.min(1, audioLevel * cfgAudioLevelScale) : 0
    var beat = audioEnabled ? Math.min(1, audioBassPulse * 0.75 + audioRelative * 0.5) * cfgAudioPeakScale : 0
    var rate = Math.min(13.0, 4.0 + energy * 2.0 + beat * 9.0)
    sparkBudget += dt * rate * Math.max(0, Math.min(2, cfgEmberDensity))
    if (sparkBudget < 1) return
    var next = sparks.slice()
    while (sparkBudget >= 1) {
      next[sparkCursor] = Qt.vector4d(shaderTime, (Math.random() - 0.5) * 1.35,
                                     Math.random(), 1)
      sparkCursor = (sparkCursor + 1) % 64
      sparkBudget -= 1
    }
    sparks = next
  }

  // What a WMO weather code looks like. Cloud is only a fallback: live
  // cloud_cover is more precise when the data has it.
  function wmoProfile(code) {
    var c = Math.round(code)
    var pr = { cloud: 0.3, rain: 0, snow: 0, fog: 0, storm: 0 }
    if (c === 0) pr.cloud = 0.03
    else if (c === 1) pr.cloud = 0.25
    else if (c === 2) pr.cloud = 0.55
    else if (c === 3) pr.cloud = 0.95
    else if (c === 45 || c === 48) { pr.cloud = 0.8; pr.fog = c === 48 ? 0.9 : 0.7 }
    else if (c >= 51 && c <= 57) { pr.cloud = 0.9; pr.rain = c <= 51 ? 0.15 : c <= 53 ? 0.22 : 0.30 }
    else if (c >= 61 && c <= 67) { pr.cloud = 0.95; pr.rain = (c === 61 || c === 66) ? 0.38 : (c === 63) ? 0.58 : 1.0 }
    else if (c >= 71 && c <= 77) { pr.cloud = 0.95; pr.snow = c === 71 ? 0.30 : c === 73 ? 0.55 : c === 75 ? 1.0 : 0.30 }
    else if (c >= 80 && c <= 82) { pr.cloud = 0.8; pr.rain = c === 80 ? 0.40 : c === 81 ? 0.65 : 1.0 }
    else if (c === 85 || c === 86) { pr.cloud = 0.85; pr.snow = c === 85 ? 0.45 : 0.9 }
    else if (c >= 95) { pr.cloud = 1.0; pr.rain = 0.85; pr.storm = c === 95 ? 0.7 : 1.0 }
    return pr
  }

  function recomputeWeather() {
    var previewCode = testCode >= 0 ? testCode : cfgWeatherPreviewCode
    var preview = previewCode >= 0
    var code = preview ? previewCode : (wxOk ? wxCodeLive : 2)
    var pr = wmoProfile(code)
    wxCloudN = (!preview && wxOk && wxCloudLive >= 0) ? Math.max(0, Math.min(1, wxCloudLive / 100)) : pr.cloud
    var fromPrecip = (!preview && wxOk) ? Math.min(1, wxPrecipLive / 4) : 0
    if (pr.snow > 0) { wxSnowN = Math.max(pr.snow, fromPrecip); wxRainN = 0 }
    else { wxRainN = pr.rain > 0 ? Math.max(pr.rain, fromPrecip) : 0; wxSnowN = 0 }
    wxFogN = pr.fog
    wxStormN = pr.storm
    wxWindN = (!preview && wxOk) ? Math.max(0, Math.min(1, wxWindLive / 60)) : (pr.storm > 0 ? 0.6 : 0.25)
    if (testWind >= 0) wxWindN = testWind
    // Meteorological direction is where the wind comes FROM; it blows toward
    // the opposite side, whose east-west part is -sin(from).
    var side = -Math.sin(wxWindDirLive * Math.PI / 180)
    if (preview || !wxOk) side = 1
    if (testWindDir > -900) side = testWindDir
    wxWindDirN = (side >= 0 ? 1 : -1) * Math.max(Math.abs(side), 0.35)
    wxTempN = wxOk ? wxTempLive : 10
    // A snow preview on a warm day would melt as it lands; make it winter.
    if (preview && pr.snow > 0 && wxTempN > 0) wxTempN = -4
    if (testTemp > -900) wxTempN = testTemp
    updateSunPhase()
  }

  // 0..1 across today's daylight, 1..2 across the night. Without data, a
  // plain 06:30-19:30 day from the local clock stands in.
  function updateSunPhase() {
    var now = Date.now() / 1000
    var previewPhase = testPhase >= 0 ? testPhase : cfgWeatherPreviewPhase
    if (previewPhase >= 0) {
      wxSunPhase = Math.min(1.999, previewPhase)
    } else {
      var rise = wxSunrise, set = wxSunset, riseNext = wxSunriseNext
      if (!wxOk || !rise || !set) {
        var d = new Date(); d.setHours(6, 30, 0, 0)
        rise = d.getTime() / 1000; set = rise + 13 * 3600; riseNext = rise + 86400
      }
      if (!riseNext || riseNext <= set) riseNext = rise + 86400
      var ph
      if (now >= rise && now <= set) ph = (now - rise) / (set - rise)
      else if (now > set) ph = 1 + (now - set) / (riseNext - set)
      else { var prevSet = set - 86400; ph = 1 + (now - prevSet) / (rise - prevSet) }
      wxSunPhase = Math.max(0, Math.min(1.999, ph))
    }
    if (testSeason >= 0) {
      wxSeason = testSeason
    } else {
      var d0 = new Date(); var jan1 = new Date(d0.getFullYear(), 0, 1)
      wxSeason = ((d0 - jan1) / 86400000) / 365.25
    }
    // Moon: days since a known new moon, over the synodic month.
    var synodic = 29.530588853 * 86400
    var ph2 = ((now - 947182440) / synodic) % 1
    wxMoonPhase = ph2 < 0 ? ph2 + 1 : ph2
  }

  function setTesting(on) {
    testingEnabled = on
    if (!on) { testCode = -1; testPhase = -1; testWind = -1; testTemp = -999; testSeason = -1; testWindDir = -999
      eggCampfire = false; eggHikers = false; eggAurora = false; eggBirds = false }
    recomputeWeather()
  }

  // The panel's Close button: also clears the persisted flag.
  function closeTesting() {
    setTesting(false)
    Quickshell.execDetached(["bash", "-c", "echo 0 > '" + shaderStateDir + "/testing'"])
  }

  // For the panel: an egg button shows active when its flag is on.
  function eggActive(n) {
    var on = n === 1 ? eggCampfire : n === 2 ? eggHikers : n === 3 ? eggAurora : eggBirds
    return on ? n : -1
  }

  function setTest(kind, value) {
    if (kind === "code") testCode = value
    else if (kind === "phase") testPhase = value
    else if (kind === "wind") testWind = value
    else if (kind === "temp") testTemp = value
    else if (kind === "season") testSeason = value
    else if (kind === "dir") testWindDir = value
    else if (kind === "eggs") {
      if (value === 1) eggCampfire = !eggCampfire
      else if (value === 2) eggHikers = !eggHikers
      else if (value === 3) eggAurora = !eggAurora
      else if (value === 4) eggBirds = !eggBirds
      return
    }
    recomputeWeather()
  }

  function refreshWeather() {
    if (!weatherProc.running) weatherProc.running = true
  }

  function shaderPath(name) {
    return Qt.resolvedUrl("shaders/" + name + ".frag.qsb")
  }

  function setAudioEnabled(enabled) {
    audioEnabled = enabled
    if (!enabled) {
      audioLevel = 0; audioPeak = 0; audioBass = 0; audioMid = 0; audioTreble = 0
      audioBaseline = 0; audioRelative = 0
      audioBassBase = 0; audioTrebleBase = 0; audioBassPulse = 0; audioTreblePulse = 0
    }
    updateAudioProc()
  }

  function updateAudioProc() {
    // Ink deliberately has no music response, so do not keep cava running
    // while it is selected just to feed uniforms the shader never consumes.
    var want = shaderEnabled && audioEnabled && shaderName !== "ink" && shaderName !== "weather"
    if (want && !audioProc.running) audioProc.running = true
    else if (!want && audioProc.running) audioProc.running = false
  }

  function iconUrl(fileName) {
    return root.imageUrl(root.iconDir + "/" + fileName) + "?v=" + root.iconVersion
  }

  function refreshIcon() {
    iconVersion += 1
  }

  function setShaderEnabled(enabled) {
    shaderEnabled = enabled
    updateAudioProc()
  }

  function setShaderName(name) {
    if (shaderNames.indexOf(name) === -1) return
    shaderName = name
    updateAudioProc()
    if (name === "weather") refreshWeather()
  }

  function nextShader() {
    var i = shaderNames.indexOf(shaderName)
    setShaderName(shaderNames[(i + 1) % shaderNames.length])
  }

  function prevShader() {
    var i = shaderNames.indexOf(shaderName)
    setShaderName(shaderNames[(i - 1 + shaderNames.length) % shaderNames.length])
  }

  function imageUrl(path) {
    return Util.fileUrl(path)
  }

  function refreshBackground() {
    if (!readlinkProc.running) readlinkProc.running = true
  }

  function setBackground(path, instant) {
    transitionBackground("", path, path, instant, false)
  }

  function transitionBackground(fromPath, path, finalPath, instant, force) {
    path = String(path || "").trim()
    finalPath = String(finalPath || path).trim()
    fromPath = String(fromPath || "").trim()
    if (!path || (!force && finalPath === currentBackground)) return
    currentBackground = finalPath
    backgroundVersion += 1
    revealStartedVersion = -1

    revealAnimation.stop()
    finishingTransition = false

    if (instant || !displayedBackground) {
      oldBackground = ""
      incomingBackground = ""
      displayedBackground = path
      revealProgress = 1
      return
    }

    oldBackground = fromPath || displayedBackground
    incomingBackground = path
    revealProgress = 0
  }

  function setPendingTheme(colorsB64, shellB64) {
    pendingColorsRaw = Util.decodeBase64(colorsB64)
    pendingShellRaw = Util.decodeBase64(shellB64)
    pendingThemeVersion = backgroundVersion
    pendingThemeFallbackTimer.restart()
  }

  function applyPendingTheme() {
    // Background polling can advance backgroundVersion while a theme switch is
    // pending; the latest theme payload should still apply.
    if (pendingThemeVersion < 0) return
    pendingThemeFallbackTimer.stop()
    Color.loadColors(pendingColorsRaw)
    // Color.loadShell also refreshes Style so the type scale flips with the
    // background reveal instead of waiting for a separate reload path.
    Color.loadShell(pendingShellRaw)
    Style.scheduleRefresh()
    pendingThemeVersion = -1
    pendingColorsRaw = ""
    pendingShellRaw = ""
  }

  function transitionBackgroundWithTheme(fromPath, path, finalPath, colorsB64, shellB64) {
    transitionBackground(fromPath, path, finalPath, false, true)
    setPendingTheme(colorsB64, shellB64)
    if (!incomingBackground || revealProgress >= 1) applyPendingTheme()
  }

  function startReveal(panel) {
    if (!incomingBackground) return
    panel.maskReady = true
    if (revealStartedVersion === backgroundVersion) return
    revealStartedVersion = backgroundVersion
    applyPendingTheme()
    revealAnimation.restart()
  }

  function openSelector() {
    if (!bgSwitchProc.running) bgSwitchProc.running = true
  }

  function openThemeSwitcher() {
    if (!themeSwitchProc.running) themeSwitchProc.running = true
  }

  Process {
    id: bgSwitchProc
    command: ["bash", "-c", "background=$(omarchy-theme-bg-switcher); [[ -n $background ]] && omarchy-theme-bg-set \"$background\""]
    onExited: root.refreshBackground()
  }

  Process {
    id: themeSwitchProc
    command: ["bash", "-c", "theme=$(omarchy-theme-switcher); [[ -n $theme ]] && omarchy-theme-set \"$theme\" >/dev/null 2>&1 &"]
    onExited: root.refreshBackground()
  }

  Process {
    id: readlinkProc
    command: ["readlink", "-f", root.currentBackgroundLink]
    stdout: StdioCollector {
      onStreamFinished: root.setBackground(String(text || "").trim(), false)
    }
  }

  Process {
    id: shaderStateProc
    command: ["bash", "-c",
      "echo \"E=$(cat '" + root.shaderStateDir + "/enabled' 2>/dev/null)\"; " +
      "echo \"N=$(cat '" + root.shaderStateDir + "/shader' 2>/dev/null)\"; " +
      "echo \"A=$(cat '" + root.shaderStateDir + "/audio' 2>/dev/null)\"; " +
      "echo \"T=$(cat '" + root.shaderStateDir + "/testing' 2>/dev/null)\""]
    stdout: StdioCollector {
      onStreamFinished: {
        var lines = String(text || "").split("\n")
        var enabled = "", name = "", audio = "", testing = ""
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]
          if (line.indexOf("E=") === 0) enabled = line.slice(2).trim()
          else if (line.indexOf("N=") === 0) name = line.slice(2).trim()
          else if (line.indexOf("A=") === 0) audio = line.slice(2).trim()
          else if (line.indexOf("T=") === 0) testing = line.slice(2).trim()
        }
        root.shaderEnabled = (enabled === "1")
        if (name) root.setShaderName(name)
        if (audio) root.audioEnabled = (audio === "1")
        root.testingEnabled = (testing === "1")
        root.updateAudioProc()
      }
    }
  }

  // A dedicated low-bar-count cava instance feeds the shader's audio
  // reactivity. Only runs while the shader wallpaper is actually visible, so
  // it costs nothing the rest of the time.
  Process {
    id: audioProc
    command: ["cava", "-p", root.audioConfigPath]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        var parts = String(line || "").split(";").filter(function (s) { return s.length > 0 })
        if (parts.length === 0) return
        var bars = parts.map(function (s) { return parseFloat(s) || 0 })
        var sum = 0
        for (var i = 0; i < bars.length; i++) sum += bars[i]
        var raw = Math.min(1.0, (sum / bars.length) / 100.0)

        // Slow attack/release for a continuous "loudness" level.
        root.audioLevel = root.audioLevel * 0.85 + raw * 0.15

        // Compare this frame with a several-second rolling baseline. This
        // makes "loud" relative to the current song rather than a fixed
        // system-volume threshold, so quiet masters and loud masters behave
        // alike. Keep this signal smooth enough that it shapes a flash rather
        // than making it visibly flicker.
        if (root.audioBaseline <= 0) root.audioBaseline = raw
        var relativeNow = Math.max(0, Math.min(1,
          (raw - root.audioBaseline) / (root.audioBaseline + 0.12) * 1.8))
        root.audioBaseline = root.audioBaseline * 0.992 + raw * 0.008
        root.audioRelative = root.audioRelative * 0.72 + relativeNow * 0.28

        // Fast transient detector: how far above the smoothed level this
        // instant sits, decaying quickly -- good for beat/hit flashes.
        var instant = Math.max(0, raw - root.audioLevel)
        root.audioPeak = Math.max(root.audioPeak * 0.80, instant * 1.6)

        if (root.shaderName === "thunder" && relativeNow > 0.42 && instant > 0.08
            && (root.shaderTime - root.flashTime) > 0.45) {
          root.flashTime = root.shaderTime
        }

        // Rough low/mid/high split of the mono spectrum -- approximate (cava's
        // bar-to-frequency mapping is not laboratory-clean), but real music's
        // kick/vocal/cymbal energy still lands differently across the three
        // groups, which is all a "pulse the big ones with the bass" effect needs.
        var n = bars.length
        var third = Math.max(1, Math.floor(n / 3))
        var bass = 0, mid = 0, treble = 0
        for (var b = 0; b < n; b++) {
          if (b < third) bass += bars[b]
          else if (b < n - third) mid += bars[b]
          else treble += bars[b]
        }
        var rawBass = Math.min(1.0, (bass / third) / 100.0)
        var rawMid = Math.min(1.0, (mid / Math.max(1, n - 2 * third)) / 100.0)
        var rawTreble = Math.min(1.0, (treble / third) / 100.0)
        root.audioBass = root.audioBass * 0.82 + rawBass * 0.18
        root.audioMid = root.audioMid * 0.82 + rawMid * 0.18
        root.audioTreble = root.audioTreble * 0.78 + rawTreble * 0.22

        if (root.audioBassBase <= 0) root.audioBassBase = rawBass
        if (root.audioTrebleBase <= 0) root.audioTrebleBase = rawTreble
        var bassNow = Math.max(0, Math.min(1, (rawBass - root.audioBassBase) / (root.audioBassBase + 0.10) * 2.2))
        var trebleNow = Math.max(0, Math.min(1, (rawTreble - root.audioTrebleBase) / (root.audioTrebleBase + 0.10) * 2.2))
        root.audioBassBase = root.audioBassBase * 0.985 + rawBass * 0.015
        root.audioTrebleBase = root.audioTrebleBase * 0.985 + rawTreble * 0.015
        root.audioBassPulse = Math.max(root.audioBassPulse * 0.86, bassNow)
        root.audioTreblePulse = Math.max(root.audioTreblePulse * 0.82, trebleNow)
      }
    }
    onRunningChanged: {
      if (!running) {
        root.audioLevel = 0; root.audioPeak = 0; root.audioBass = 0
        root.audioMid = 0; root.audioTreble = 0
        root.audioBaseline = 0; root.audioRelative = 0
        root.audioBassBase = 0; root.audioTrebleBase = 0; root.audioBassPulse = 0; root.audioTreblePulse = 0
      }
    }
    onExited: {
      // cava shouldn't exit on its own; if it does (audio server hiccup,
      // config issue), retry shortly rather than leaving audio dead.
      if (root.shaderEnabled && root.audioEnabled && root.shaderName !== "ink")
        audioRestartTimer.restart()
    }
  }

  // A real storm does not wait for music: thunder always strikes on its own
  // randomized cadence. Loud audio (audioProc's transient detector, below)
  // can additionally trigger extra strikes on top -- the two never conflict,
  // they both just set the same flashTime.
  Timer {
    id: ambientLightningTimer
    running: root.shaderEnabled && root.shaderName === "thunder"
    interval: (root.cfgThunderAmbientMinS + Math.random() * (root.cfgThunderAmbientMaxS - root.cfgThunderAmbientMinS)) * 1000
    repeat: false
    onTriggered: {
      root.flashTime = root.shaderTime
      interval = (root.cfgThunderAmbientMinS + Math.random() * (root.cfgThunderAmbientMaxS - root.cfgThunderAmbientMinS)) * 1000
      restart()
    }
  }

  Timer {
    id: audioRestartTimer
    interval: 1000
    repeat: false
    onTriggered: root.updateAudioProc()
  }

  IpcHandler {
    target: "wallpaperShader"

    function enable(): void {
      root.setShaderEnabled(true)
    }

    function disable(): void {
      root.setShaderEnabled(false)
    }

    function toggle(): void {
      root.setShaderEnabled(!root.shaderEnabled)
    }

    function setShader(name: string): void {
      root.setShaderName(name)
    }

    function next(): void {
      root.nextShader()
    }

    function prev(): void {
      root.prevShader()
    }

    function refreshIcon(): void {
      root.refreshIcon()
    }

    function enableAudio(): void {
      root.setAudioEnabled(true)
    }

    function disableAudio(): void {
      root.setAudioEnabled(false)
    }

    function toggleAudio(): void {
      root.setAudioEnabled(!root.audioEnabled)
    }

    function refreshWeather(): void {
      root.refreshWeather()
    }

    function enableTesting(): void {
      root.setTesting(true)
    }

    function disableTesting(): void {
      root.setTesting(false)
    }

    function toggleTesting(): void {
      root.setTesting(!root.testingEnabled)
    }

    function audioStatus(): string {
      function f(v) { return Number(v).toFixed(3) }
      return "running=" + audioProc.running + " level=" + f(root.audioLevel) + " peak=" + f(root.audioPeak)
           + " relative=" + f(root.audioRelative) + " bassPulse=" + f(root.audioBassPulse)
           + " treblePulse=" + f(root.audioTreblePulse)
           + " sparksAlive=" + root.sparks.filter(function (k) { return k && root.shaderTime - k.x < 4.4 }).length
    }
  }

  Timer {
    interval: 16
    running: root.shaderEnabled
    repeat: true
    onTriggered: {
      root.shaderTime += 0.016
      root.advanceSparks(0.016)
      // Aurora keeps its natural pace in silence, then breathes only a few
      // percent faster with the music. Integrating the rate avoids phase
      // jumps when the level changes.
      var tempoLift = root.audioEnabled ? root.audioLevel * 0.10 + root.audioPeak * 0.18 : 0
      root.auroraTime += 0.016 * (1.0 + tempoLift)
      root.windTravel += 0.016 * root.wxWindDirN * (0.004 + Math.pow(root.wxWindN, 1.2) * 0.08)
    }
  }

  // Weather for the weather shader: same location and source as the Omarchy
  // weather widget (see bin/omarchy-wallpaper-weather).
  Process {
    id: weatherProc
    command: [root.pluginDir + "/bin/omarchy-wallpaper-weather"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          var w = JSON.parse(String(text || "").trim())
          if (w && w.ok) {
            root.wxCodeLive = Number(w.code)
            root.wxCloudLive = (w.cloud === null || w.cloud === undefined) ? -1 : Number(w.cloud)
            root.wxPrecipLive = Number(w.precip) || 0
            root.wxWindLive = Number(w.wind) || 0
            root.wxWindDirLive = (w.windDir === null || w.windDir === undefined) ? 270 : Number(w.windDir)
            root.wxTempLive = Number(w.temp) || 0
            root.wxSunrise = Number(w.sunrise) || 0
            root.wxSunset = Number(w.sunset) || 0
            root.wxSunriseNext = Number(w.sunriseNext) || 0
            root.wxOk = true
          }
        } catch (e) {}
        root.recomputeWeather()
      }
    }
  }

  Timer {
    interval: 15 * 60 * 1000
    running: root.shaderEnabled && root.shaderName === "weather"
    repeat: true
    onTriggered: root.refreshWeather()
  }

  Timer {
    interval: 5000
    running: root.shaderEnabled && root.shaderName === "weather"
    repeat: true
    triggeredOnStart: true
    onTriggered: root.updateSunPhase()
  }

  IpcHandler {
    target: "background"

    function refresh(): void {
      root.refreshBackground()
    }

    function set(path: string): void {
      root.setBackground(path, false)
    }

    function setInstant(path: string): void {
      root.setBackground(path, true)
    }

    function transition(fromPath: string, path: string): void {
      root.transitionBackground(fromPath, path, path, false, false)
    }

    function themeTransition(fromPath: string, path: string, finalPath: string, colorsB64: string, shellB64: string): void {
      root.transitionBackgroundWithTheme(fromPath, path, finalPath, colorsB64, shellB64)
    }
  }

  Timer {
    id: pendingThemeFallbackTimer
    interval: 300
    repeat: false
    onTriggered: root.applyPendingTheme()
  }

  NumberAnimation {
    id: revealAnimation
    target: root
    property: "revealProgress"
    from: 0
    to: 1
    duration: 420
    easing.type: Easing.InOutCubic
    onFinished: {
      if (root.incomingBackground) {
        root.displayedBackground = root.currentBackground || root.incomingBackground
        root.finishingTransition = true
      }
      root.revealProgress = 1
    }
  }

  // First run: a plugin installed with `omarchy plugin add` has no install
  // hook, so the service finishes the job itself -- installs cava and the
  // icon renderer's Python packages, then asks for a PNG. Runs in a terminal
  // because installing packages needs a sudo prompt. The script leaves a
  // marker when it completes, so this fires once per install (again after a
  // failed install, until it succeeds).
  Process {
    id: firstRunProc
    command: ["bash", "-c",
      "[[ -e \"$1/setup-done\" ]] || exec omarchy-launch-floating-terminal-with-presentation \"'$2'\"",
      "first-run", root.shaderStateDir, root.pluginDir + "/bin/omarchy-wallpaper-setup"]
  }

  // Let the shell finish starting before a window appears over it.
  Timer {
    id: firstRunTimer
    interval: 4000
    repeat: false
    onTriggered: firstRunProc.running = true
  }

  Component.onCompleted: {
    refreshBackground()
    if (!shaderStateProc.running) shaderStateProc.running = true
    firstRunTimer.start()
  }

  Variants {
    model: Quickshell.screens

    PanelWindow {
      id: panel
      required property var modelData

      screen: modelData
      visible: !remapGuard.remapping
      anchors { top: true; bottom: true; left: true; right: true }

      ScreenMoveRemap {
        id: remapGuard
        window: panel
      }
      color: "transparent"
      // Keep render updates enabled. The background layer has been observed to
      // lose its committed buffer while parked with updatesEnabled=false,
      // leaving a black desktop until omarchy-shell is restarted. The wallpaper
      // itself is static, so this favors correctness over a small render-loop
      // optimization.
      updatesEnabled: true

      property bool maskReady: false

      function maybeStartReveal() {
        if (!root.incomingBackground || root.revealProgress !== 0 || maskReady) return
        if (incomingFrame.status !== Image.Ready) return
        Qt.callLater(function() {
          if (!root.incomingBackground || root.revealProgress !== 0 || maskReady) return
          if (incomingFrame.status !== Image.Ready) return
          root.startReveal(panel)
        })
      }

      WlrLayershell.namespace: "omarchy-background"
      WlrLayershell.layer: WlrLayer.Background
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore

      Image {
        id: base
        anchors.fill: parent
        source: root.imageUrl(root.displayedBackground)
        fillMode: Image.PreserveAspectCrop
        asynchronous: true
        cache: true
        visible: !root.shaderEnabled
        onStatusChanged: {
          if (status === Image.Ready && root.finishingTransition) {
            root.incomingBackground = ""
            root.oldBackground = ""
            root.finishingTransition = false
          }
        }
      }

      Image {
        id: oldFrame
        anchors.fill: parent
        source: root.imageUrl(root.oldBackground)
        fillMode: Image.PreserveAspectCrop
        asynchronous: true
        cache: false
        smooth: true
        mipmap: true
        visible: !root.shaderEnabled && root.oldBackground !== "" && root.revealProgress < 1
        onStatusChanged: panel.maybeStartReveal()
      }

      Image {
        id: maskTexture
        visible: false
        cache: true
        asynchronous: true
        source: root.iconUrl("mask.png")
      }

      Image {
        id: distTexture
        visible: false
        cache: true
        asynchronous: true
        source: root.iconUrl("dist.png")
      }

      // Ink's persistent dye: ink-sim.frag advects last frame's state and
      // writes the next one; the recursive source feeds it back each frame.
      // Half resolution in 16-bit float -- 8-bit would band and the fade
      // would stall on small values.
      ShaderEffectSource {
        id: inkBuffer
        visible: false
        sourceItem: inkSim
        recursive: true
        hideSource: true
        live: root.shaderEnabled && root.shaderName === "ink"
        format: ShaderEffectSource.RGBA16F
        textureSize: Qt.size(Math.max(2, Math.round(parent.width / 2)), Math.max(2, Math.round(parent.height / 2)))
        smooth: true
        wrapMode: ShaderEffectSource.ClampToEdge
      }

      ShaderEffect {
        id: inkSim
        anchors.fill: parent
        visible: root.shaderEnabled && root.shaderName === "ink"
        blending: false

        property real time: root.shaderTime
        property real aspect: width / Math.max(height, 1)
        property real inkFlow: root.cfgInkFlow
        property point inkTexel: Qt.point(1 / Math.max(2, Math.round(width / 2)), 1 / Math.max(2, Math.round(height / 2)))
        property var prevState: inkBuffer
        property var maskSource: maskTexture
        property var distSource: distTexture

        fragmentShader: Qt.resolvedUrl("shaders/ink-sim.frag.qsb")
      }

      ShaderEffect {
        id: shaderLayer
        anchors.fill: parent
        visible: root.shaderEnabled

        property real time: root.shaderTime
        property real aspect: width / Math.max(height, 1)
        property color bgColor: Color.background
        property color fgColor: Color.foreground
        property color accentColor: Color.accent
        property color mutedColor: Color.muted
        property color urgentColor: Color.urgent
        property real audioLevel: root.audioEnabled ? root.audioLevel * root.cfgAudioLevelScale : 0
        property real audioPeak: root.audioEnabled ? root.audioPeak * root.cfgAudioPeakScale : 0
        property real audioBass: root.audioEnabled ? root.audioBass * root.cfgAudioLevelScale : 0
        property real audioMid: root.audioEnabled ? root.audioMid * root.cfgAudioLevelScale : 0
        property real audioTreble: root.audioEnabled ? root.audioTreble * root.cfgAudioLevelScale : 0
        property real audioRelative: root.audioEnabled ? root.audioRelative * root.cfgAudioLevelScale : 0
        property real audioBassPulse: root.audioEnabled ? root.audioBassPulse * root.cfgAudioPeakScale : 0
        property real audioTreblePulse: root.audioEnabled ? root.audioTreblePulse * root.cfgAudioPeakScale : 0
        property real auroraTime: root.auroraTime
        property real auroraHueSpread: root.cfgAuroraHueSpread
        property real auroraRays: root.cfgAuroraRays
        property real sunPhase: root.wxSunPhase
        property real moonPhase: root.wxMoonPhase
        property real wxCloud: root.wxCloudN
        property real wxRain: root.wxRainN
        property real wxSnow: root.wxSnowN
        property real wxFog: root.wxFogN
        property real wxStorm: root.wxStormN
        property real wxWind: root.wxWindN
        property real wxTemp: root.wxTempN
        property real season: root.wxSeason
        property real windSide: root.wxWindDirN
        property real windTravel: root.windTravel
        property real eggCampfire: root.eggCampfire ? 1 : 0
        property real eggHikers: root.eggHikers ? 1 : 0
        property real eggAurora: root.eggAurora ? 1 : 0
        property real eggBirds: root.eggBirds ? 1 : 0
        property real flashTime: root.flashTime
        property real iconWarpScale: root.cfgIconWarpScale
        property real edgeGlowWidth: root.cfgEdgeGlowWidth
        property real edgeGlowBrightness: root.cfgEdgeGlowBrightness
        property real thunderRain: root.cfgThunderRain
        property real emberDensity: root.cfgEmberDensity
        property vector4d spark0: root.sparks[0] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark1: root.sparks[1] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark2: root.sparks[2] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark3: root.sparks[3] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark4: root.sparks[4] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark5: root.sparks[5] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark6: root.sparks[6] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark7: root.sparks[7] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark8: root.sparks[8] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark9: root.sparks[9] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark10: root.sparks[10] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark11: root.sparks[11] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark12: root.sparks[12] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark13: root.sparks[13] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark14: root.sparks[14] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark15: root.sparks[15] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark16: root.sparks[16] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark17: root.sparks[17] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark18: root.sparks[18] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark19: root.sparks[19] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark20: root.sparks[20] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark21: root.sparks[21] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark22: root.sparks[22] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark23: root.sparks[23] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark24: root.sparks[24] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark25: root.sparks[25] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark26: root.sparks[26] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark27: root.sparks[27] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark28: root.sparks[28] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark29: root.sparks[29] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark30: root.sparks[30] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark31: root.sparks[31] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark32: root.sparks[32] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark33: root.sparks[33] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark34: root.sparks[34] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark35: root.sparks[35] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark36: root.sparks[36] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark37: root.sparks[37] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark38: root.sparks[38] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark39: root.sparks[39] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark40: root.sparks[40] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark41: root.sparks[41] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark42: root.sparks[42] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark43: root.sparks[43] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark44: root.sparks[44] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark45: root.sparks[45] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark46: root.sparks[46] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark47: root.sparks[47] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark48: root.sparks[48] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark49: root.sparks[49] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark50: root.sparks[50] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark51: root.sparks[51] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark52: root.sparks[52] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark53: root.sparks[53] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark54: root.sparks[54] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark55: root.sparks[55] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark56: root.sparks[56] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark57: root.sparks[57] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark58: root.sparks[58] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark59: root.sparks[59] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark60: root.sparks[60] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark61: root.sparks[61] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark62: root.sparks[62] || Qt.vector4d(-100, 0, 0, 0)
        property vector4d spark63: root.sparks[63] || Qt.vector4d(-100, 0, 0, 0)
        property real nebulaDrift: root.cfgNebulaDrift
        property real inkFlow: root.cfgInkFlow
        property point inkTexel: inkSim.inkTexel
        property var inkState: inkBuffer
        property var maskSource: maskTexture
        property var distSource: distTexture

        fragmentShader: root.shaderPath(root.shaderName)
      }

      Item {
        id: incomingLayer
        anchors.fill: parent
        visible: !root.shaderEnabled && root.incomingBackground !== "" && incomingFrame.status === Image.Ready && (root.revealProgress >= 1 || panel.maskReady)
        layer.enabled: root.incomingBackground !== "" && root.revealProgress < 1
        layer.smooth: true
        layer.effect: MultiEffect {
          maskEnabled: true
          maskSource: revealMask
          maskThresholdMin: 0.5
          maskSpreadAtMin: 0.02
        }

        Image {
          id: incomingFrame
          anchors.fill: parent
          source: root.imageUrl(root.incomingBackground)
          fillMode: Image.PreserveAspectCrop
          asynchronous: true
          cache: false
          smooth: true
          mipmap: true
          onStatusChanged: panel.maybeStartReveal()
        }
      }

      Item {
        id: revealMask
        anchors.fill: parent
        visible: false
        layer.enabled: true

        readonly property real slant: -0.18
        readonly property real centerTop: width / 2 - slant * height / 2
        readonly property real centerBottom: width / 2 + slant * height / 2
        readonly property real reach: width / 2 + Math.abs(slant) * height / 2 + 4
        readonly property real spread: reach * root.revealProgress

        Shape {
          anchors.fill: parent
          antialiasing: true
          preferredRendererType: Shape.CurveRenderer
          ShapePath {
            fillColor: "white"
            strokeColor: "transparent"
            startX: revealMask.centerTop - revealMask.spread; startY: 0
            PathLine { x: revealMask.centerTop + revealMask.spread; y: 0 }
            PathLine { x: revealMask.centerBottom + revealMask.spread; y: revealMask.height }
            PathLine { x: revealMask.centerBottom - revealMask.spread; y: revealMask.height }
            PathLine { x: revealMask.centerTop - revealMask.spread; y: 0 }
          }
        }
      }

      Connections {
        target: root
        function onIncomingBackgroundChanged() {
          panel.maskReady = false
          panel.maybeStartReveal()
        }
      }

      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        onDoubleClicked: function(mouse) {
          if (mouse.button === Qt.RightButton) root.openThemeSwitcher()
          else root.openSelector()
          mouse.accepted = true
        }
      }

      // Weather test panel: only with --testing, only on the weather style.
      Rectangle {
        id: testPanel
        visible: root.testingEnabled && root.shaderEnabled && root.shaderName === "weather"
        anchors { right: parent.right; bottom: parent.bottom; rightMargin: 24; bottomMargin: 24 }
        width: testColumn.implicitWidth + 20
        height: testColumn.implicitHeight + 20
        radius: 8
        color: Qt.rgba(Color.background.r, Color.background.g, Color.background.b, 0.82)
        border.width: 1
        border.color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.5)

        // Swallow clicks so they never reach the desktop's double-click.
        MouseArea { anchors.fill: parent }

        Column {
          id: testColumn
          anchors.centerIn: parent
          spacing: 6

          Row {
            spacing: 8
            Text {
              text: "weather test"
              color: Color.accent
              font.pixelSize: 12
              font.bold: true
            }
            Text {
              function f(v) { return Number(v).toFixed(2) }
              text: "sun " + f(root.wxSunPhase) + "  cloud " + f(root.wxCloudN) + "  rain " + f(root.wxRainN)
                  + "  snow " + f(root.wxSnowN) + "  wind " + f(root.wxWindN) + "  " + Math.round(root.wxTempN) + "°"
                  + "  season " + f(root.wxSeason)
              color: Color.foreground
              opacity: 0.7
              font.pixelSize: 11
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          Repeater {
            model: [
              { kind: "code", items: [["Live", -1], ["Clear", 0], ["Partly", 2], ["Overcast", 3], ["Fog", 45], ["Drizzle", 53],
                                      ["Rain", 63], ["Downpour", 65], ["Snow", 73], ["Blizzard", 75], ["Storm", 95]] },
              { kind: "phase", items: [["Live", -1], ["Sunrise", 0.03], ["Morning", 0.2], ["Noon", 0.5], ["Afternoon", 0.75],
                                       ["Sunset", 0.97], ["Dusk", 1.04], ["Night", 1.5], ["Pre-dawn", 1.95]] },
              { kind: "wind", items: [["Live", -1], ["Calm", 0.0], ["Breeze", 0.25], ["Windy", 0.55], ["Gale", 0.95]] },
              { kind: "dir", items: [["Live", -999], ["→ from west", 1], ["← from east", -1], ["↘ from NW", 0.5]] },
              { kind: "temp", items: [["Live", -999], ["-15°", -15], ["-3°", -3], ["5°", 5], ["14°", 14], ["24°", 24]] },
              { kind: "season", items: [["Live", -1], ["Spring", 0.36], ["Summer", 0.56], ["Autumn", 0.75], ["Late autumn", 0.86], ["Winter", 0.04]] },
              { kind: "eggs", items: [["Campfire", 1], ["Hikers", 2], ["Aurora", 3], ["Birds", 4]] }
            ]

            Row {
              id: testRow
              required property var modelData
              spacing: 4

              Text {
                text: modelData.kind
                width: 42
                color: Color.foreground
                opacity: 0.55
                font.pixelSize: 11
                anchors.verticalCenter: parent.verticalCenter
              }

              Repeater {
                model: modelData.items

                Rectangle {
                  required property var modelData
                  property string kind: testRow.modelData.kind
                  property real current: kind === "code" ? root.testCode : kind === "phase" ? root.testPhase
                                       : kind === "wind" ? root.testWind : kind === "season" ? root.testSeason
                                       : kind === "dir" ? root.testWindDir
                                       : kind === "eggs" ? root.eggActive(modelData[1]) : root.testTemp
                  property bool active: Math.abs(current - modelData[1]) < 0.001
                  width: label.implicitWidth + 14
                  height: 22
                  radius: 5
                  color: active ? Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.35)
                                : (hover.containsMouse ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.10) : "transparent")
                  border.width: 1
                  border.color: active ? Color.accent : Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.18)

                  Text {
                    id: label
                    anchors.centerIn: parent
                    text: modelData[0]
                    color: Color.foreground
                    font.pixelSize: 11
                  }

                  MouseArea {
                    id: hover
                    anchors.fill: parent
                    hoverEnabled: true
                    onClicked: root.setTest(parent.kind, modelData[1])
                  }
                }
              }
            }
          }

          Row {
            spacing: 4
            Text { text: "time"; width: 42; color: Color.foreground; opacity: 0.55; font.pixelSize: 11; anchors.verticalCenter: parent.verticalCenter }
            Repeater {
              // Skip ahead on the shader clock -- aurora nights, bird flights and
              // shooting stars run on their own slow clocks.
              model: [["+1 min", 60], ["+5 min", 300], ["+30 min", 1800]]
              Rectangle {
                required property var modelData
                width: skipLabel.implicitWidth + 14
                height: 22
                radius: 5
                color: skipHover.containsMouse ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.10) : "transparent"
                border.width: 1
                border.color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.18)
                Text { id: skipLabel; anchors.centerIn: parent; text: modelData[0]; color: Color.foreground; font.pixelSize: 11 }
                MouseArea {
                  id: skipHover
                  anchors.fill: parent
                  hoverEnabled: true
                  onClicked: root.shaderTime += modelData[1]
                }
              }
            }
            Item { width: 12; height: 1 }
            Rectangle {
              width: closeLabel.implicitWidth + 14
              height: 22
              radius: 5
              color: closeHover.containsMouse ? Qt.rgba(Color.urgent.r, Color.urgent.g, Color.urgent.b, 0.25) : "transparent"
              border.width: 1
              border.color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.18)
              Text { id: closeLabel; anchors.centerIn: parent; text: "Close"; color: Color.foreground; font.pixelSize: 11 }
              MouseArea {
                id: closeHover
                anchors.fill: parent
                hoverEnabled: true
                onClicked: root.closeTesting()
              }
            }
          }
        }
      }
    }
  }
}
