#!/usr/bin/env python3
"""Opt-in UI acceptance for the skill-enabled, five-reference Forest example.

Installs and clears only the supplied isolated Meld candidate. No app-source,
clock or database writes are used to manufacture outcomes.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys
import time
import traceback

BaseDevice = runpy.run_path(str(Path(__file__).with_name("forest-native-driver.py")))["Device"]


class HarnessSelectorError(Exception):
    pass


class CandidateDevice(BaseDevice):
    def __init__(self, apk, package):
        self.apk = Path(apk).resolve()
        self.package = package
        if not re.fullmatch(r"com\.meld\.apps\.p[a-f0-9]+", package):
            raise ValueError("Test only an isolated generated package")
        self.sha = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        self.adb_path = os.environ["MELD_ANDROID_ADB"]
        self.serial = os.environ.get("MELD_ANDROID_SERIAL", "emulator-5580")
        self.out = Path(os.environ["MELD_NATIVE_QA_OUTPUT"])
        self.out.mkdir(parents=True, exist_ok=True)
        self.checks = []

    def seek(self, labels, scroll=True):
        if isinstance(labels, str):
            labels = [labels]
        for attempt in range(5 if scroll else 1):
            nodes = self.nodes()
            for label in labels:
                matches = [n for n in nodes if label.lower() in [(n.get("text") or "").lower(), (n.get("content-desc") or "").lower()]
                           and n.get("enabled") == "true" and n.get("bounds") != "[0,0][0,0]"]
                if matches:
                    return matches[-1]
            if scroll:
                self.scroll(nodes=nodes)
        self.screenshot("missing-control")
        raise HarnessSelectorError("UI control not found: " + repr(labels) + "; " + repr(self.labels()))

    def tap(self, labels, scroll=True):
        self.tap_node(self.seek(labels, scroll))

    def edit(self, *args, **kwargs):
        try:
            return super().edit(*args, **kwargs)
        except AssertionError as error:
            if any(message in str(error) for message in ("Editable field not found", "did not receive visible focus", "Test input was not entered", "A different field received focus")):
                raise HarnessSelectorError(str(error)) from error
            raise

    def texts(self):
        return " | ".join((n.get("text") or n.get("content-desc") or "") for n in self.nodes())

    def passed(self, label):
        super().passed(label)
        (self.out / "runtime-progress.json").write_text(json.dumps({"apkSha256": self.sha, "cases": self.checks}, indent=2))

    def report(self, passed, error=None):
        self.assert_installed()
        report = {"passed": passed, "apkSha256": self.sha, "packageId": self.package,
                  "device": {"serial": self.serial, "api": self.adb("shell", "getprop", "ro.build.version.sdk").strip(),
                             "abi": self.adb("shell", "getprop", "ro.product.cpu.abi").strip(), "display": self.adb("shell", "wm", "size").strip()},
                  "cases": self.checks, "error": error,
                  "scope": "Actual candidate APK and UI interactions on one Android emulator. Does not establish original Forest runtime equivalence, physical-device behavior or release-performance benchmarks."}
        (self.out / "runtime-report.json").write_text(json.dumps(report, indent=2))
        return report


def run(device):
    # Interaction cases are kept separate from the reusable driver. They use
    # the current approved app's actual accessible controls, not pixel taps.
    cases = runpy.run_path(str(Path(__file__).with_name("forest-skills-cases.py")))
    cases["run_cases"](device)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: forest-native.py APK GENERATED_PACKAGE_ID")
    d = CandidateDevice(sys.argv[1], sys.argv[2])
    try:
        d.install(clear=True)
        run(d)
        print(json.dumps(d.report(True)), flush=True)
    except Exception as error:
        try:
            d.screenshot("failure")
            d.report(False, str(error))
        finally:
            traceback.print_exc()
        raise SystemExit(1)
    finally:
        d.rotate(0)
