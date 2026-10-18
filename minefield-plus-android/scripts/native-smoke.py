#!/usr/bin/env python3
"""Real Android UI + saved-file checks. Clears only com.meld.minefield test data.

Usage: MELD_ANDROID_ADB=/path/to/adb MELD_ANDROID_SERIAL=emulator-5580 \
  python3 scripts/native-smoke.py app/build/outputs/apk/debug/app-debug.apk artifacts/native
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

ADB = os.environ.get("MELD_ANDROID_ADB") or shutil.which("adb")
SERIAL = os.environ.get("MELD_ANDROID_SERIAL", "emulator-5580")
PKG = "com.meld.minefield"
APK = pathlib.Path(sys.argv[1]).resolve()
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "artifacts/native").resolve()
OUT.mkdir(parents=True, exist_ok=True)
INPUT_APK = OUT / "input.apk"
shutil.copyfile(APK, INPUT_APK)
APK_SHA = hashlib.sha256(INPUT_APK.read_bytes()).hexdigest()
CHECKS = []
if not ADB:
  raise SystemExit("Set MELD_ANDROID_ADB to adb")


def adb(*args, binary=False):
  value = subprocess.run([ADB, "-s", SERIAL, *args], capture_output=True, check=True, timeout=45).stdout
  return value if binary else value.decode()


def nodes():
  adb("shell", "uiautomator", "dump", "/data/local/tmp/minefield-window.xml")
  return list(ET.fromstring(adb("shell", "cat", "/data/local/tmp/minefield-window.xml")).iter("node"))


def labels():
  return [(n.get("text"), n.get("content-desc"), n.get("enabled"), n.get("bounds")) for n in nodes() if n.get("text") or n.get("content-desc")]


def scroll(direction):
  width, height = map(int, re.findall(r"(\d+)x(\d+)", adb("shell", "wm", "size"))[-1])
  y1, y2 = (int(height * .76), int(height * .32)) if direction == "down" else (int(height * .30), int(height * .77))
  adb("shell", "input", "swipe", str(width // 2), str(y1), str(width // 2), str(y2), "200")
  time.sleep(.25)


def click(label, description=False, attempts=5):
  field = "content-desc" if description else "text"
  for attempt in range(attempts):
    matches = [n for n in nodes() if n.get(field) == label and n.get("enabled") == "true"]
    for n in matches:
      left, top, right, bottom = map(int, re.findall(r"\d+", n.get("bounds")))
      if right > left and bottom > top:
        adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
        time.sleep(.4)
        return
    if attempt < attempts - 1:
      scroll("down" if attempt < 2 else "up")
  raise AssertionError("Enabled control missing: " + label + "; " + str(labels()))


def top():
  for _ in range(3):
    scroll("up")


def cell(index):
  prefix = f"Row {index // 9 + 1}, column {index % 9 + 1}, "
  for attempt in range(2):
    found = next((n for n in nodes() if n.get("content-desc", "").startswith(prefix) and n.get("enabled") == "true"), None)
    if found is not None:
      left, y1, right, y2 = map(int, re.findall(r"\d+", found.get("bounds")))
      if right > left and y2 > y1:
        adb("shell", "input", "tap", str((left + right) // 2), str((y1 + y2) // 2))
        time.sleep(.4)
        return
    top()
  raise AssertionError((prefix, labels()))


def saved(name=None):
  time.sleep(.25)
  data = json.loads(adb("exec-out", "run-as", PKG, "cat", "files/session.json"))
  if name:
    (OUT / (name + ".json")).write_text(json.dumps(data, indent=2))
  return data


def restart():
  adb("shell", "am", "force-stop", PKG)
  adb("shell", "am", "start", "-n", PKG + "/.MainActivity")
  time.sleep(1.5)


def overwrite_save(content, filename="session.json"):
  assert filename in ("session.json", "session.json.new")
  subprocess.run([ADB, "-s", SERIAL, "shell", "-T", "run-as", PKG, "tee", "files/" + filename],
    input=content.encode(), capture_output=True, check=True, timeout=20)


def screenshot(name):
  (OUT / (name + ".png")).write_bytes(adb("exec-out", "screencap", "-p", binary=True))
  (OUT / (name + ".xml")).write_text(adb("shell", "cat", "/data/local/tmp/minefield-window.xml"))


def passed(case):
  CHECKS.append({"case": case, "passed": True})
  print(case + ": passed", flush=True)


def new_game():
  click("New game")
  click("New game")
  time.sleep(.3)


def run():
  adb("install", "-r", str(INPUT_APK))
  adb("shell", "pm", "clear", PKG)
  restart()
  before = saved("initial")
  assert before["board"]["phase"] == "READY"
  assert len(before["board"]["cells"]) == 81
  nodes(); screenshot("01-game")
  click("Mark selected cell", description=True)
  click("Mark 3", description=True)
  marked = saved()
  assert marked["board"]["cells"][40]["mark"] == 3
  click("Flag selected cell", description=True)
  flagged = saved()
  assert flagged["board"]["cells"][40]["flagged"] and flagged["board"]["cells"][40]["mark"] == 0
  click("Undo")
  assert saved()["board"] == marked["board"]
  assert saved()["undo"] is None
  passed("Pencil picker, flag, exact one-step undo and mark restoration")

  click("Reveal selected cell", description=True)
  first = saved("first-reveal")
  board = first["board"]
  assert not board["cells"][40]["mine"] and board["cells"][40]["revealed"]
  assert sum(c["mine"] for c in board["cells"]) == 10
  assert board["cells"][40]["mark"] == 0
  click("Undo")
  assert saved()["board"] == marked["board"]
  click("Reveal selected cell", description=True)
  assert saved()["board"]["cells"] == board["cells"]
  passed("Safe first reveal, ten mines, deterministic re-reveal and first-move undo")

  click("Pause")
  paused = saved("paused")
  time.sleep(2)
  assert saved()["board"] == paused["board"]
  assert not any(n.get("content-desc", "").startswith("Row ") for n in nodes())
  restart()
  assert saved()["board"] == paused["board"]
  click("Resume")
  resumed = saved()
  assert not resumed["board"]["paused"]
  assert resumed["board"]["cells"] == paused["board"]["cells"]
  passed("Pause hides the board, freezes time and survives force-stop")

  click("New game")
  click("Cancel")
  assert saved()["board"]["id"] == resumed["board"]["id"]
  assert saved()["board"]["cells"] == resumed["board"]["cells"]
  click("Statistics")
  assert any(n.get("text", "").startswith("No completed games yet") for n in nodes())
  at_stats = saved()["board"]["seconds"]
  time.sleep(2)
  assert saved()["board"]["seconds"] == at_stats
  click("Game")
  passed("Restart cancellation, empty statistics and off-board clock pause")

  b = saved()["board"]
  mine = next(i for i, c in enumerate(b["cells"]) if c["mine"] and not c["flagged"])
  cell(mine)
  lost = saved("loss")
  assert lost["board"]["phase"] == "LOST" and len(lost["outcomes"]) == 1
  nodes(); screenshot("02-loss")
  click("Undo")
  assert saved()["board"]["phase"] == "PLAYING" and not saved()["outcomes"]
  cell(mine)
  restart()
  assert len(saved()["outcomes"]) == 1
  click("Statistics")
  nodes(); screenshot("03-statistics")
  click("Game")
  passed("Loss, undo of terminal result and exactly-once durable statistics")

  new_game()
  assert saved()["board"]["phase"] == "READY" and saved()["undo"] is None
  cell(40)
  while saved()["board"]["phase"] == "PLAYING":
    b = saved()["board"]
    # Pick empty cells first so this exercises flood-reveal through the real UI.
    choices = [i for i, c in enumerate(b["cells"]) if not c["mine"] and not c["revealed"]]
    def around(i):
      return sum(c["mine"] for j, c in enumerate(b["cells"]) if j != i and abs(j // 9 - i // 9) <= 1 and abs(j % 9 - i % 9) <= 1)
    cell(min(choices, key=around))
  won = saved("win")
  assert won["board"]["phase"] == "WON"
  assert sum(c["revealed"] for c in won["board"]["cells"]) == 71
  assert len(won["outcomes"]) == 2 and sum(r["won"] for r in won["outcomes"]) == 1
  nodes(); screenshot("04-win")
  click("Statistics")
  assert any(n.get("text") == "50%" for n in nodes())
  restart()
  assert saved()["outcomes"] == won["outcomes"]
  passed("Complete real-UI win, flood reveal, win rate, best time and durable outcomes")

  click("Settings")
  click("Dark")
  assert saved()["preferences"]["appearance"] == "DARK"
  nodes(); screenshot("05-settings-dark")
  click("Start new games in Flag mode", description=True)
  assert saved()["preferences"]["defaultFlag"]
  restart()
  assert saved()["preferences"] == {"appearance": "DARK", "defaultFlag": True}
  click("Settings"); nodes(); screenshot("06-dark-relaunch")
  click("Light")
  click("Game")
  new_game()
  assert saved()["board"]["mode"] == "FLAG"
  passed("Light/dark preference, default flag mode and durable settings")

  old_scale = adb("shell", "settings", "get", "system", "font_scale").strip()
  try:
    adb("shell", "settings", "put", "system", "font_scale", "2.0")
    time.sleep(1)
    click("Settings")
    click("Dark")
    assert saved()["preferences"]["appearance"] == "DARK"
    nodes(); screenshot("07-large-font")
  finally:
    adb("shell", "settings", "put", "system", "font_scale", old_scale if old_scale != "null" else "1.0")
  passed("200 percent font scale navigation and settings interaction")

  click("Game")
  old = saved()
  permissions = adb("shell", "run-as", PKG, "stat", "-c", "%a", "files").strip()
  try:
    adb("shell", "run-as", PKG, "chmod", "500", "files")
    click("Flag selected cell", description=True)
    assert saved()["board"] == old["board"]
    assert any("Progress isn't saved yet" in n.get("text", "") for n in nodes())
    nodes(); screenshot("08-save-error")
  finally:
    adb("shell", "run-as", PKG, "chmod", permissions, "files")
  click("Retry save")
  committed = saved("retried-save")
  assert committed["board"]["cells"][40]["flagged"]
  restart()
  assert saved() == committed
  passed("Actual write failure keeps committed file intact and retries pending move")

  adb("shell", "am", "force-stop", PKG)
  overwrite_save('{"version":1,"board":', filename="session.json.new")
  restart()
  assert saved() == committed
  assert "session.json.new" not in adb("shell", "run-as", PKG, "ls", "files").splitlines()
  adb("shell", "am", "force-stop", PKG)
  adb("shell", "run-as", PKG, "cp", "files/session.json", "files/session.json.bak")
  overwrite_save('{"version":999}')
  restart()
  assert saved() == committed
  passed("Interrupted new-file and legacy-backup recovery preserve the complete accepted session")

  adb("shell", "am", "force-stop", PKG)
  overwrite_save('{"version":999}')
  restart()
  assert any("Your saved game couldn't be opened" in n.get("text", "") for n in nodes())
  click("Start fresh")
  click("Cancel")
  assert json.loads(adb("exec-out", "run-as", PKG, "cat", "files/session.json")) == {"version":999}
  click("Start fresh")
  click("Preserve and start")
  fresh = saved("recovered-new-game")
  assert fresh["board"]["phase"] == "READY" and not fresh["outcomes"]
  assert "session.json.failed-" in adb("shell", "run-as", PKG, "ls", "files")
  nodes(); screenshot("09-recovered")
  passed("Unreadable save is preserved; recovery cancellation and explicit fresh start")


try:
  run()
  report = {
    "passed": True, "apkSha256": APK_SHA, "packageId": PKG,
    "device": {"serial": SERIAL, "api": adb("shell", "getprop", "ro.build.version.sdk").strip(),
      "abi": adb("shell", "getprop", "ro.product.cpu.abi").strip(), "display": adb("shell", "wm", "size").strip()},
    "cases": CHECKS,
    "scope": "Real UI, durable files, forced write failure, interrupted-write backup recovery and corrupt-save handling on one Android emulator. Separate JVM tests cover rules and storage invariants. Source APKs were not runtime tested. No physical device or complete Android-version coverage."
  }
  (OUT / "runtime-report.json").write_text(json.dumps(report, indent=2))
  print(json.dumps({"passed": True, "cases": len(CHECKS), "sha256": report["apkSha256"]}), flush=True)
except Exception as error:
  try:
    nodes(); screenshot("failure")
  except Exception:
    pass
  (OUT / "failure.json").write_text(json.dumps({"passed": False, "error": str(error), "completedCases": CHECKS}, indent=2))
  raise
