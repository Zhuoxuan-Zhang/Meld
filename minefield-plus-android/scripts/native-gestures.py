#!/usr/bin/env python3
"""Supplement a passed native run with real long-press/mode checks on its exact APK.

Starts a new board in the installed test app; does not clear app data.
Usage: MELD_ANDROID_ADB=/path/to/adb python3 scripts/native-gestures.py artifacts/native
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

OUT = pathlib.Path(sys.argv[1]).resolve()
REPORT = json.loads((OUT / "runtime-report.json").read_text())
assert REPORT["passed"]
PKG = "com.meld.minefield"
assert REPORT["packageId"] == PKG
ADB = os.environ.get("MELD_ANDROID_ADB") or shutil.which("adb")
SERIAL = os.environ.get("MELD_ANDROID_SERIAL", REPORT["device"]["serial"])


def adb(*args, binary=False):
  result = subprocess.run([ADB, "-s", SERIAL, *args], check=True, capture_output=True, timeout=45).stdout
  return result if binary else result.decode()


def nodes():
  adb("shell", "uiautomator", "dump", "/data/local/tmp/minefield-gesture.xml")
  return list(ET.fromstring(adb("shell", "cat", "/data/local/tmp/minefield-gesture.xml")).iter("node"))


def point(node):
  x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
  assert x2 > x1 and y2 > y1
  return str((x1 + x2) // 2), str((y1 + y2) // 2)


def click(text):
  for attempt in range(5):
    found = next((n for n in nodes() if n.get("text") == text and n.get("enabled") == "true"), None)
    if found is not None:
      adb("shell", "input", "tap", *point(found)); time.sleep(.4); return
    adb("shell", "input", "swipe", "540", "1400" if attempt < 2 else "600", "540", "600" if attempt < 2 else "1400", "200")
  raise AssertionError("Missing control: " + text)


def cell(index, long=False):
  prefix = f"Row {index // 9 + 1}, column {index % 9 + 1}, "
  node = next(n for n in nodes() if n.get("content-desc", "").startswith(prefix))
  x, y = point(node)
  if long:
    adb("shell", "input", "swipe", x, y, x, y, "800")
  else:
    adb("shell", "input", "tap", x, y)
  time.sleep(.4)


def saved():
  return json.loads(adb("exec-out", "run-as", PKG, "cat", "files/session.json"))


apk_path = adb("shell", "pm", "path", PKG).strip().removeprefix("package:")
assert hashlib.sha256(adb("exec-out", "cat", apk_path, binary=True)).hexdigest() == REPORT["apkSha256"]
click("New game"); click("New game")
cell(40, long=True)
assert saved()["board"]["cells"][40]["flagged"] and saved()["board"]["phase"] == "READY"
cell(40, long=True)
assert not saved()["board"]["cells"][40]["flagged"] and saved()["board"]["phase"] == "READY"
click("Flag"); cell(40)
assert saved()["board"]["cells"][40]["flagged"] and saved()["board"]["phase"] == "READY"
click("Reveal"); cell(40)
assert saved()["board"]["cells"][40]["flagged"] and saved()["board"]["phase"] == "READY"
cell(40, long=True); cell(40)
board = saved()["board"]
assert board["cells"][40]["revealed"] and not board["cells"][40]["mine"]
zero = next((i for i, c in enumerate(board["cells"]) if not c["mine"] and not c["revealed"] and
  not any(other["mine"] for j, other in enumerate(board["cells"]) if j != i and abs(j // 9 - i // 9) <= 1 and abs(j % 9 - i % 9) <= 1)), None)
if zero is not None:
  cell(zero)
nodes()
(OUT / "10-playing.png").write_bytes(adb("exec-out", "screencap", "-p", binary=True))
(OUT / "10-playing.xml").write_text(adb("shell", "cat", "/data/local/tmp/minefield-gesture.xml"))
result = {"passed": True, "apkSha256": REPORT["apkSha256"], "packageId": PKG, "serial": SERIAL,
  "case": "Actual long-press flag/unflag, flag-mode tap, flagged-cell reveal protection and safe reveal",
  "scope": "Supplemental real gesture check on the exact installed test APK; creates a new board and preserves completed statistics."}
(OUT / "gesture-report.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result), flush=True)
