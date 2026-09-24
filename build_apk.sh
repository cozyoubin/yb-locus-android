#!/usr/bin/env bash
set -e
if ! command -v gradle >/dev/null 2>&1; then
  echo "Gradle 9.6이 필요합니다. Android Studio에서 프로젝트를 열고 Build > Build APK(s)를 사용하세요."
  exit 1
fi
gradle :app:assembleDebug
printf '\nAPK: app/build/outputs/apk/debug/app-debug.apk\n'
