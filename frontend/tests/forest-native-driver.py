#!/usr/bin/env python3
"""Real-device helpers for the sequential Forest acceptance cases. No mocks."""
import hashlib
import json
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time
import xml.etree.ElementTree as ET


class Device:
    def __init__(self, case_id, preview_apk=None):
        self.root = Path(__file__).resolve().parent.parent / "qa-screenshots/forest-cases"
        self.out = self.root / case_id
        registry = json.loads((self.root / "cases.json").read_text())
        self.case = next(c for c in registry["cases"] if c["id"] == case_id)
        self.apk = Path(preview_apk) if preview_apk else self.out / "app.apk"
        self.sha = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        self.delivered = preview_apk is None
        if self.delivered:
            assert self.sha == self.case["apkSha256"], "Test the exact delivered APK"
        self.project = self.case["projectId"]
        self.package = "com.meld.apps.p" + self.project.replace("project-", "").replace("-", "")[-24:]
        assert re.fullmatch(r"com\.meld\.apps\.p[a-f0-9]+", self.package)
        self.adb_path = os.environ.get("MELD_ANDROID_ADB") or shutil.which("adb") or str(Path.home() / "Library/Android/sdk/platform-tools/adb")
        self.serial = os.environ.get("MELD_ANDROID_SERIAL", "emulator-5580")
        self.checks = []
        self.report_file = "runtime-report.json"

    def adb(self, *args, binary=False):
        result = subprocess.run([self.adb_path, "-s", self.serial, *map(str, args)], capture_output=True, check=True, timeout=45)
        return result.stdout if binary else result.stdout.decode()

    def install(self, clear=False):
        self.adb("install", "-r", self.apk)
        self.assert_installed()
        if clear:
            self.adb("shell", "pm", "clear", self.package)
        self.adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        self.adb("shell", "wm", "dismiss-keyguard")
        self.adb("shell", "settings", "put", "system", "screen_off_timeout", "1800000")
        self.rotate(0)
        self.restart()

    def rotate(self, rotation):
        assert rotation in (0, 1)
        self.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0")
        self.adb("shell", "wm", "user-rotation", "lock", str(rotation))
        time.sleep(2)

    def assert_installed(self):
        paths = self.adb("shell", "pm", "path", self.package).splitlines()
        assert len(paths) == 1 and paths[0].startswith("package:"), "Expected this single generated APK to be installed"
        installed = paths[0].removeprefix("package:")
        assert self.adb("shell", "sha256sum", installed).split()[0] == self.sha, "Installed APK differs from the delivered artifact"

    def restart(self):
        self.adb("shell", "am", "force-stop", self.package)
        self.launch()

    def launch(self):
        self.adb("shell", "am", "start", "-n", self.package + "/generated.MainActivity")
        time.sleep(1)

    def nodes(self):
        for attempt in range(3):
            output = self.adb("shell", "uiautomator", "dump", "/data/local/tmp/forest-window.xml")
            if "dumped to" in output:
                break
            time.sleep(1)
        else:
            raise AssertionError("UI dump failed; wake the device before testing")
        xml = self.adb("shell", "cat", "/data/local/tmp/forest-window.xml")
        self.xml = xml
        return list(ET.fromstring(xml).iter("node"))

    def labels(self):
        return [{k: n.get(k) for k in ("text", "content-desc", "class", "enabled", "bounds")} for n in self.nodes() if n.get("text") or n.get("content-desc")]

    def tap_node(self, node):
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
        assert x2 > x1 and y2 > y1, "Control is offscreen"
        self.adb("shell", "input", "tap", (x1+x2)//2, (y1+y2)//2)
        time.sleep(.35)

    def click(self, text, occurrence=0, description=False):
        key = "content-desc" if description else "text"
        for attempt in range(5):
            nodes = self.nodes()
            matches = [n for n in nodes if n.get(key) == text and n.get("enabled") == "true" and n.get("bounds") != "[0,0][0,0]"]
            if matches and len(matches) > occurrence:
                self.tap_node(matches[occurrence])
                return
            self.scroll(nodes=nodes)
        raise AssertionError(f"Control not found: {text}; {self.labels()}")

    def scroll(self, upward=False, nodes=None):
        nodes = nodes if nodes is not None else self.nodes()
        containers = [node for node in nodes if node.get("scrollable") == "true"
                      and node.get("bounds") != "[0,0][0,0]"]
        container = containers[0] if containers else nodes[0]
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", container.get("bounds")))
        upper, lower = y1 + (y2-y1)//4, y1 + (y2-y1)*3//4
        self.adb("shell", "input", "swipe", (x1+x2)//2, upper if upward else lower, (x1+x2)//2, lower if upward else upper, "300")
        time.sleep(.25)

    def edit(self, value, index=0, label=None, upward=True, capture=None):
        for attempt in range(4):
            nodes = self.nodes()
            fields = [n for n in nodes if n.get("class") == "android.widget.EditText" and n.get("enabled") == "true" and n.get("bounds") != "[0,0][0,0]"]
            if label:
                # Compose sometimes exposes a field's semantic label as a
                # sibling with the same bounds as its native EditText.
                def labelled(field):
                    related = list(field.iter("node")) + [peer for peer in nodes if peer.get("bounds") == field.get("bounds")]
                    return any(label.lower() in ((child.get("text") or "") + " " + (child.get("content-desc") or "")).lower() for child in related)
                fields = [n for n in fields if labelled(n)]
            if len(fields) > index:
                break
            self.scroll(upward=upward, nodes=nodes)
        assert len(fields) > index, "Editable field not found"
        assert not value or re.fullmatch(r"[A-Za-z0-9 ._-]+", value), "Use shell-safe test text"
        self.tap_node(fields[index])
        for attempt in range(2):
            # Wait for the native field and its input connection after the IME
            # has resized the window. Sending keys immediately can lose input.
            focused = []
            for focus_attempt in range(10):
                nodes = self.nodes()
                focused = [n for n in nodes if n.get("class") == "android.widget.EditText"
                           and n.get("package") == self.package and n.get("focused") == "true"]
                if len(focused) == 1 and (not label or labelled(focused[0])):
                    break
                # Reopening the keyboard can leave an already focused field
                # below the resized viewport. Scroll it into view as a user
                # would before typing; never send text to an invisible field.
                targets = [n for n in nodes if n.get("class") == "android.widget.EditText"
                           and n.get("enabled") == "true" and n.get("bounds") != "[0,0][0,0]"
                           and (not label or labelled(n))]
                if label and targets:
                    self.tap_node(targets[0])
                else:
                    self.scroll(upward=focus_attempt >= 6, nodes=nodes)
            assert len(focused) == 1, "The intended app field did not receive visible focus after the keyboard opened"
            if label:
                assert labelled(focused[0]), "A different field received focus"
            self.adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
            self.adb("shell", "input", "keyevent", *(["KEYCODE_DEL"] * (len(focused[0].get("text", "")) + 5)))
            if value:
                self.adb("shell", "input", "text", value.replace(" ", "%s"))
            entered = [n.get("text", "") for n in self.nodes() if n.get("class") == "android.widget.EditText"
                       and n.get("package") == self.package and n.get("focused") == "true"]
            if entered == [value]:
                break
        else:
            raise AssertionError(f"Test input was not entered into {label or 'the field'}: expected {value!r}, got {entered!r}")
        if capture:
            self.screenshot(capture)
        self.adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(.2)

    def screenshot(self, name):
        self.nodes()
        (self.out / (name + ".xml")).write_text(self.xml)
        (self.out / (name + ".png")).write_bytes(self.adb("exec-out", "screencap", "-p", binary=True))

    def database(self, name):
        target = self.out / (name + "-db")
        if target.exists():
            shutil.rmtree(target)
        target.mkdir()
        names = self.adb("shell", "run-as", self.package, "ls", "databases").splitlines()
        for filename in names:
            assert re.fullmatch(r"[A-Za-z0-9_.-]+", filename)
            if filename.endswith("-shm"):
                continue
            (target / filename).write_bytes(self.adb("exec-out", "run-as", self.package, "cat", "databases/" + filename, binary=True))
        base = next(p for p in target.iterdir() if not p.name.endswith(("-wal", "-shm", "-journal")))
        db = sqlite3.connect(base)
        db.row_factory = sqlite3.Row
        tables = [row[0] for row in db.execute("select name from sqlite_master where type='table'")]
        result = {}
        for table in tables:
            assert re.fullmatch(r"[A-Za-z0-9_]+", table)
            result[table] = [dict(row) for row in db.execute('select * from "' + table + '"')]
        db.close()
        return result

    def passed(self, label):
        self.checks.append({"case": label, "passed": True})
        print(label + ": passed", flush=True)

    def report(self, passed, error=None):
        assert not passed or self.delivered, "A preview build cannot pass the release gate"
        if passed:
            self.assert_installed()
        value = {"passed": passed, "projectId": self.project, "apkSha256": self.sha, "packageId": self.package,
                 "recordedAt": datetime.now(timezone.utc).isoformat(),
                 "device": {"serial": self.serial, "api": self.adb("shell", "getprop", "ro.build.version.sdk").strip(),
                            "abi": self.adb("shell", "getprop", "ro.product.cpu.abi").strip(),
                            "display": self.adb("shell", "wm", "size").strip()},
                 "cases": self.checks, "error": error,
                 "scope": "Real UI interactions and local database snapshots on Android 36. Core Forest loop and requested additions; no claim of full latest Forest parity or physical-device coverage."}
        (self.out / self.report_file).write_text(json.dumps(value, indent=2))
        return value

    def inherit_core_checks(self):
        self.assert_installed()
        report = json.loads((self.out / "core-runtime-report.json").read_text())
        assert report["passed"] is True and report["projectId"] == self.project and report["apkSha256"] == self.sha, "Complete the core checks on this exact APK first"
        self.checks.extend(report["cases"])


if __name__ == "__main__":
    import sys
    device = Device(sys.argv[1] if len(sys.argv) > 1 else "forest-core")
    print(json.dumps(device.labels(), indent=2))
