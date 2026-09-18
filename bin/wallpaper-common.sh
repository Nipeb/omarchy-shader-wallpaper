# Shared by the omarchy-wallpaper-* scripts (sourced, not run).

ASSET_DIR="$HOME/.config/omarchy/branding/wallpaper"
STATE_DIR="$HOME/.local/state/omarchy/wallpaper-shader"
CONFIG_FILE="$HOME/.config/omarchy/wallpaper-shader.conf"

# The icon renderer needs numpy and Pillow. Prefer the system interpreter, but
# accept any python3 on PATH that has both (mise, pyenv, ...). Prints the
# interpreter, or nothing (and fails) if none qualifies.
pick_python() {
  local py
  for py in /usr/bin/python3 "$(command -v python3 2>/dev/null)"; do
    [[ -x $py ]] || continue
    if "$py" -c 'import numpy, PIL' >/dev/null 2>&1; then
      echo "$py"
      return 0
    fi
  done
  return 1
}
