#!/usr/bin/env bash
set -euo pipefail
if [[ "${MELD_EMULATOR_ENABLED:-true}" == "false" ]]; then exit 0; fi
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
preview_sdk="${MELD_ANDROID_SDK:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}}"
if [[ -z "$preview_sdk" && -d "$HOME/Library/Android/sdk" ]]; then preview_sdk="$HOME/Library/Android/sdk"; fi
if [[ -z "${JAVA_HOME:-}" ]]; then
  for preview_java in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home /usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; do
    if [[ -x "$preview_java/bin/java" ]]; then export JAVA_HOME="$preview_java"; break; fi
  done
fi
preview_avd_default="$(python3 - "$repo_root" <<'PYTHON'
import hashlib,os,sys,tempfile
print(os.path.join(tempfile.gettempdir(),'meld-browser-emulator-'+hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12],'avd'))
PYTHON
)"
preview_avd_home="${MELD_EMULATOR_AVD_HOME:-$preview_avd_default}"
preview_avd_name="${MELD_EMULATOR_AVD:-MeldBrowserPreview}"
preview_image="${MELD_EMULATOR_IMAGE:-}"
if [[ -z "$preview_image" ]]; then
  preview_image="$(python3 - "$preview_sdk" "$(uname -m)" <<'PYTHON'
import pathlib,platform,sys,subprocess
apple_arm = platform.system() == 'Darwin' and subprocess.run(['/usr/sbin/sysctl','-n','hw.optional.arm64'],capture_output=True,text=True).stdout.strip() == '1'
sdk=pathlib.Path(sys.argv[1]); abi='arm64-v8a' if apple_arm or sys.argv[2] in ('arm64','aarch64') else 'x86_64'
images=sorted(sdk.glob('system-images/android-*/*/'+abi+'/package.xml'),key=lambda p:tuple(int(part) for part in p.parts[-4].removeprefix('android-').split('.')),reverse=True)
print(';'.join(images[0].parent.relative_to(sdk).parts) if images else '')
PYTHON
)"
fi
if [[ -z "$preview_image" ]]; then
  echo 'Install an Android system image for this computer, or set MELD_EMULATOR_IMAGE.' >&2
  exit 1
fi
if [[ -z "$preview_sdk" || ! -x "$preview_sdk/cmdline-tools/latest/bin/avdmanager" ]]; then
  echo 'Set MELD_ANDROID_SDK to an Android SDK with avdmanager, emulator and an installed system image.' >&2
  exit 1
fi
mkdir -p "$preview_avd_home"
export ANDROID_AVD_HOME="$preview_avd_home"
if [[ ! -f "$preview_avd_home/$preview_avd_name.ini" ]]; then
  printf 'no\n' | "$preview_sdk/cmdline-tools/latest/bin/avdmanager" create avd --name "$preview_avd_name" --device pixel_6 --package "$preview_image" --path "$preview_avd_home/$preview_avd_name.avd" --force
fi
python3 - "$preview_avd_home/$preview_avd_name.avd/config.ini" "${MELD_EMULATOR_IMAGE_DIR:-}" "$preview_sdk" <<'PY'
import pathlib,sys
file=pathlib.Path(sys.argv[1]); values={}
for line in file.read_text().splitlines():
 if '=' in line:
  key,value=line.split('=',1); values[key.strip()]=value.strip()
values.update({'hw.ramSize':'2048','vm.heapSize':'256M','hw.cpu.ncore':'4','hw.lcd.width':'480','hw.lcd.height':'960','hw.lcd.density':'240','disk.dataPartition.size':'2G','hw.keyboard':'yes','hw.camera.back':'none','hw.camera.front':'none','showDeviceFrame':'no','fastboot.forceColdBoot':'yes'})
if sys.argv[2]: values['image.sysdir.1']=str(pathlib.Path(sys.argv[2]).resolve())+'/'
# Older avdmanager versions turn dotted API levels (36.1) into android-0,
# which prevents the emulator from enabling hardware acceleration.
image_dir=pathlib.Path(values['image.sysdir.1'])
if not image_dir.is_absolute(): image_dir=pathlib.Path(sys.argv[3])/image_dir
properties=dict(line.split('=',1) for line in (image_dir/'source.properties').read_text().splitlines() if '=' in line)
api=properties['AndroidVersion.ApiLevel'].split('.')[0]
if not api.isdigit() or int(api)<1: raise ValueError('Invalid system image API level')
avd_ini=file.parent.with_suffix('.ini')
ini=[line for line in avd_ini.read_text().splitlines() if not line.startswith('target=')]
avd_ini.write_text('\n'.join([*ini,'target=android-'+api])+'\n')
file.write_text('\n'.join(f'{key}={value}' for key,value in values.items())+'\n')
PY
printf 'Browser preview AVD ready: %s\n' "$preview_avd_home/$preview_avd_name.ini"
