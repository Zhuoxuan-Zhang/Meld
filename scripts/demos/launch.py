#!/usr/bin/env python3
"""Launch pinned, tested APKs in separate persistent Android emulators."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import time


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PACKAGE = "com.meld.apps.p7e9d47e0a1ebf086bbaca3ea"
PROJECT = "project-ac17dfda-7e9d-47e0-a1eb-f086bbaca3ea"


def say(message):
    print(message, flush=True)


def run(command, *, env=None, timeout=30, required=True):
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
    if required and result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip() or f"Command failed: {command[0]}")
    return result.stdout.strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare_apk(demo):
    # Freeze each passing build locally. Never pick the project's latest APK.
    target = HERE / "artifacts" / demo["case"]
    source = ROOT / "frontend/qa-screenshots/forest-cases" / demo["case"]
    available = target if (target / "app.apk").is_file() else source
    apk = available / "app.apk"
    report_path = available / "runtime-report.json"
    if not apk.is_file() or not report_path.is_file():
        raise RuntimeError(f"The tested APK and runtime-report.json are needed in {target} or {source}.")
    if digest(apk) != demo["sha256"]:
        raise RuntimeError(f"APK checksum does not match the pinned {demo['title']} build: {apk}")
    report = json.loads(report_path.read_text())
    if (report.get("passed") is not True or report.get("apkSha256") != demo["sha256"]
            or report.get("packageId") != PACKAGE or report.get("projectId") != PROJECT):
        raise RuntimeError(f"No passing device report for this exact APK: {report_path}")
    if available != target:
        target.mkdir(parents=True, exist_ok=True)
        for name in ("runtime-report.json", "source-provenance.json"):
            if (source / name).is_file():
                shutil.copy2(source / name, target / name)
        temporary = target / "app.apk.tmp"
        shutil.copy2(apk, temporary)
        if digest(temporary) != demo["sha256"]:
            temporary.unlink()
            raise RuntimeError("The APK changed during copying. No demo was installed.")
        temporary.replace(target / "app.apk")
    return target / "app.apk"


def find_sdk():
    candidates = [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
                  str(Path.home() / "Library/Android/sdk"), str(Path.home() / "Android/Sdk")]
    for candidate in candidates:
        if candidate and (Path(candidate) / "platform-tools/adb").is_file() and (Path(candidate) / "emulator/emulator").is_file():
            return Path(candidate).resolve()
    raise RuntimeError("Android SDK not found. Set ANDROID_HOME to the SDK with platform-tools and emulator installed.")


def system_image(sdk):
    arm = platform.machine().lower() in ("arm64", "aarch64")
    if sys.platform == "darwin":
        # Intel Python can run through Rosetta on an Apple Silicon Mac.
        arm = arm or run(["/usr/sbin/sysctl", "-n", "hw.optional.arm64"], required=False) == "1"
    abi = "arm64-v8a" if arm else "x86_64"
    image = sdk / "system-images/android-36/google_apis_playstore" / abi
    if not (image / "system.img").is_file():
        raise RuntimeError(f"Install this Android SDK system image first: system-images;android-36;google_apis_playstore;{abi}")
    return image, abi


def prepare_avd(sdk, avd_home, demo):
    image, abi = system_image(sdk)
    folder = avd_home / (demo["avd"] + ".avd")
    folder.mkdir(parents=True, exist_ok=True)
    config = folder / "config.ini"
    if not config.exists():
        values = {
            "AvdId": demo["avd"], "avd.ini.displayname": demo["title"], "avd.ini.encoding": "UTF-8",
            "image.sysdir.1": str(image) + "/", "target": "android-36", "abi.type": abi,
            "tag.id": "google_apis_playstore", "tag.display": "Google Play", "PlayStore.enabled": "yes",
            "hw.cpu.arch": "arm64" if abi == "arm64-v8a" else "x86_64", "hw.cpu.ncore": "4",
            "hw.ramSize": "2048", "vm.heapSize": "256", "hw.lcd.width": "480", "hw.lcd.height": "960",
            "hw.lcd.density": "200", "hw.keyboard": "yes", "hw.mainKeys": "no", "hw.battery": "yes",
            "hw.gpu.enabled": "yes", "hw.gpu.mode": "auto", "hw.initialOrientation": "portrait",
            "hw.camera.back": "none", "hw.camera.front": "none", "disk.dataPartition.size": "2G",
            "showDeviceFrame": "no", "fastboot.forceColdBoot": "yes", "fastboot.forceFastBoot": "no",
        }
        config.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
    (avd_home / (demo["avd"] + ".ini")).write_text(f"avd.ini.encoding=UTF-8\npath={folder}\ntarget=android-36\n")


def main():
    demos = json.loads((HERE / "builds.json").read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("demo", choices=demos)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="verify the APK, passing report and SDK without launching")
    action.add_argument("--stop", action="store_true", help="close only this demo emulator; retain its saved data")
    args = parser.parse_args()
    demo = demos[args.demo]
    state = HERE / ".state"
    state.mkdir(parents=True, exist_ok=True)
    with (state / (args.demo + ".lock")).open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("This demo launcher is already running. Wait for it to finish.")
        sdk = find_sdk()
        avd_home = state / "avd"
        env = {**os.environ, "ANDROID_HOME": str(sdk), "ANDROID_SDK_ROOT": str(sdk), "ANDROID_AVD_HOME": str(avd_home)}
        serial = f"emulator-{demo['port']}"

        def adb(*parts, **kwargs):
            return run([str(sdk / "platform-tools/adb"), "-s", serial, *map(str, parts)], env=env, **kwargs)

        # Check ownership before installing, launching, or stopping anything.
        existing = adb("emu", "avd", "name", timeout=10, required=False).splitlines()
        if existing and existing[0] != demo["avd"]:
            raise RuntimeError(f"Port {demo['port']} belongs to {existing[0]}; this script will not touch it.")
        if args.stop:
            if existing:
                adb("emu", "kill")
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if serial not in run([str(sdk / "platform-tools/adb"), "devices"], env=env):
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError("Android is still closing. Wait before reopening this demo.")
                say(f"Closed {demo['title']}. Its saved data is kept.")
            else:
                say(f"{demo['title']} is already closed.")
            return
        apk = prepare_apk(demo)
        say(f"{demo['title']} — verified build {demo['buildId']}")
        say(f"APK: {apk}")
        if args.check:
            system_image(sdk)
            say("Checksum, passing device report, Android SDK and system image verified.")
            return
        log_path = state / (args.demo + ".log")
        child = None
        if not existing:
            for port in (demo["port"], demo["port"] + 1):
                with socket.socket() as probe:
                    # A just-closed emulator can leave TCP connections in TIME_WAIT.
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    try:
                        probe.bind(("127.0.0.1", port))
                    except OSError:
                        raise RuntimeError(f"Port {port} is busy. No emulator was replaced.")
            prepare_avd(sdk, avd_home, demo)
            say("Opening its own Android window. First boot can take a minute or two…")
            with log_path.open("a") as log:
                child = subprocess.Popen([
                    str(sdk / "emulator/emulator"), "-avd", demo["avd"], "-port", str(demo["port"]),
                    "-no-snapshot", "-no-boot-anim", "-no-audio", "-gpu", "auto", "-memory", "2048", "-cores", "4",
                ], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 240
        last_notice = time.monotonic()
        while time.monotonic() < deadline:
            if child and child.poll() is not None:
                raise RuntimeError(f"Android exited during startup. See {log_path}")
            try:
                booted = adb("shell", "getprop", "sys.boot_completed", timeout=10, required=False) == "1"
            except subprocess.TimeoutExpired:
                booted = False
            if booted:
                break
            if time.monotonic() - last_notice >= 15:
                say("Android is still starting…")
                last_notice = time.monotonic()
            time.sleep(2)
        else:
            raise RuntimeError(f"Android did not finish booting. See {log_path}; run the script again to retry.")
        paths = adb("shell", "pm", "path", PACKAGE, required=False).splitlines()
        installed_sha = ""
        if len(paths) == 1 and paths[0].startswith("package:"):
            installed_sha = adb("shell", "sha256sum", paths[0][8:], required=False).split(" ")[0]
        if installed_sha != demo["sha256"]:
            say("Installing the tested APK…")
            result = adb("install", "-r", apk, timeout=120)
            if "Success" not in result:
                raise RuntimeError(f"APK installation failed: {result}")
        paths = adb("shell", "pm", "path", PACKAGE).splitlines()
        if len(paths) != 1 or not paths[0].startswith("package:") or adb("shell", "sha256sum", paths[0][8:]).split()[0] != demo["sha256"]:
            raise RuntimeError("Installed APK does not match the tested build.")
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
        adb("shell", "settings", "put", "system", "screen_off_timeout", "1800000")
        result = adb("shell", "am", "start", "-W", "-n", PACKAGE + "/generated.MainActivity")
        if "Error:" in result or "Exception" in result or "Status: ok" not in result:
            raise RuntimeError(f"App did not launch: {result}")
        say(f"Ready: {demo['title']} ({serial}). You can open the other demo too.")
        say("Close its Android window when finished. Run this script again to reopen it with your saved data.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Demo could not start: {error}", file=sys.stderr)
        sys.exit(1)
