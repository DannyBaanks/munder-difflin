#!/bin/bash
# Capturas locales en un emulador ya corriendo: lo mismo que el job
# `screenshots` de .github/workflows/android.yml pero en tu máquina.
#
#   1. Arranca un emulador (Android Studio o: emulator -avd Pixel_6_API_34 &)
#   2. ./scripts/shots.sh [ruta/al/apk]
#      sin arg: usa app/build/outputs/apk/debug/app-debug.apk
#
# Deja 13 PNG en android/MunderMobile/shots/, los mismos 13 que el CI:
# pair-light + office/questions/board/link/panel/locked en light y dark.
# `set -eu` como en el CI (sh, sin pipefail) para que ambos corran igual.
set -eu
cd "$(dirname "$0")/.."

PKG=mx.isyco.munder.mobile.debug
APK=${1:-app/build/outputs/apk/debug/app-debug.apk}
test -f "$APK" || { echo "no hay APK en $APK (¿./gradlew :app:assembleDebug?)"; exit 1; }

adb wait-for-device
adb install -r "$APK"
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true
mkdir -p shots

shoot() {
  local name=$1; shift || true
  adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  adb shell am start -n "$PKG/.MainActivity" "$@" >/dev/null
  sleep 5
  adb exec-out screencap -p > "shots/$name.png"
  echo "shots/$name.png"
}

adb shell cmd uimode night no
sleep 2
shoot pair-light
for mode in light dark; do
  if [ "$mode" = "dark" ]; then adb shell cmd uimode night yes; else adb shell cmd uimode night no; fi
  sleep 3
  shoot "office-$mode" --ez MunderDemo true --ei MunderTab 0
  shoot "questions-$mode" --ez MunderDemo true --ei MunderTab 1
  shoot "board-$mode" --ez MunderDemo true --ei MunderTab 2
  shoot "link-$mode" --ez MunderDemo true --ei MunderTab 3
  shoot "panel-$mode" --ez MunderDemo true --ei MunderTab 4
  shoot "locked-$mode" --ez MunderDemo true --ez MunderDemoLocked true
done
ls -la shots
