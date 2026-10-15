#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
preview_sdk="${MELD_ANDROID_SDK:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}}"
preview_avd_default="$(python3 - "$repo_root" <<'PYTHON'
import hashlib,os,sys,tempfile
print(os.path.join(tempfile.gettempdir(),'meld-browser-emulator-'+hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12],'avd'))
PYTHON
)"
preview_avd_home="${MELD_EMULATOR_AVD_HOME:-$preview_avd_default}"
preview_avd_name="${MELD_EMULATOR_AVD:-MeldBrowserPreview}"
preview_image="${MELD_EMULATOR_IMAGE:-system-images;android-33;google_apis_playstore;x86_64}"
if [[ -z "$preview_sdk" || ! -x "$preview_sdk/cmdline-tools/latest/bin/avdmanager" ]]; then
  echo 'Set MELD_ANDROID_SDK to an Android SDK with avdmanager, emulator and an installed system image.' >&2
  exit 1
fi
mkdir -p "$preview_avd_home"
export ANDROID_AVD_HOME="$preview_avd_home"
if [[ ! -f "$preview_avd_home/$preview_avd_name.ini" ]]; then
  printf 'no\n' | "$preview_sdk/cmdline-tools/latest/bin/avdmanager" create avd --name "$preview_avd_name" --package "$preview_image" --path "$preview_avd_home/$preview_avd_name.avd" --force
fi
python3 - "$preview_avd_home/$preview_avd_name.avd/config.ini" "${MELD_EMULATOR_IMAGE_DIR:-}" <<'PY'
import pathlib,sys
file=pathlib.Path(sys.argv[1]); values={}
for line in file.read_text().splitlines():
 if '=' in line:
  key,value=line.split('=',1); values[key]=value
values.update({'hw.ramSize':'2048','hw.lcd.width':'480','hw.lcd.height':'960','hw.lcd.density':'240','disk.dataPartition.size':'2G','hw.keyboard':'yes','hw.camera.back':'none','hw.camera.front':'none','showDeviceFrame':'no','fastboot.forceColdBoot':'yes'})
if sys.argv[2]: values['image.sysdir.1']=str(pathlib.Path(sys.argv[2]).resolve())+'/'
file.write_text('\n'.join(f'{key}={value}' for key,value in values.items())+'\n')
PY
printf 'Browser preview AVD ready: %s\n' "$preview_avd_home/$preview_avd_name.ini"
