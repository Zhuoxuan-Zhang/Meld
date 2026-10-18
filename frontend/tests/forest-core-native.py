#!/usr/bin/env python3
"""Opt-in acceptance of the delivered Forest core APK on a real emulator."""
import runpy
import json
import sys
import time
from pathlib import Path

Device = runpy.run_path(str(Path(__file__).with_name("forest-native-driver.py")))["Device"]
case_id = sys.argv[1] if len(sys.argv) > 1 else "forest-core"
d = Device(case_id)
if case_id != "forest-core":
    d.report_file = "core-runtime-report.json"


def snapshot(label):
    data = d.database(label)
    return data["sessions"], data["trees"]


def current(label):
    rows, _ = snapshot(label)
    return max(rows, key=lambda row: row["startedAt"])


def texts():
    return [n.get("text") for n in d.nodes() if n.get("text")]


def start(minutes=1):
    d.edit(str(minutes), label="Duration")
    d.click("Start")
    row = current("active")
    assert row["status"] == "RUNNING"
    return row


def wait_for_completion(row, check_now=True):
    deadline = row["startedAt"] / 1000 + row["durationMinutes"] * 60
    while time.time() < deadline + 2:
        time.sleep(min(10, max(.1, deadline + 2 - time.time())))
    if check_now:
        assert current("completed")["status"] == "COMPLETED"


def choose(options, last=False):
    available = texts()
    label = next((text for text in options if text in available), None)
    assert label is not None, f"Expected one of {options}, found {available}"
    d.click(label, occurrence=-1 if last else 0)


try:
    if "--recovery-only" in sys.argv:
        # Preserve the already recorded first six groups only for this exact
        # installed APK. Rerun the failed asynchronous recovery check via UI.
        previous = json.loads((d.out / d.report_file).read_text())
        d.assert_installed()
        assert previous["apkSha256"] == d.sha and previous["projectId"] == d.project
        assert len(previous["cases"]) == 6 and all(c["passed"] for c in previous["cases"])
        assert previous["cases"][-1]["case"].startswith("Screen-off completion")
        d.checks = previous["cases"]
        d.restart()
        before = snapshot("recovery-repeat-initial")
        assert not any(row["status"] == "RUNNING" for row in before[0])
    else:
        upgrading = case_id != "forest-core"
        previous_database = d.database("before-upgrade") if upgrading else None
        d.install(clear=not upgrading)
        d.report(False, "Acceptance checks in progress")
        if previous_database:
            migrated = d.database("after-upgrade")
            for table, old_rows in previous_database.items():
                if table in ("room_master_table", "android_metadata", "sqlite_sequence"):
                    continue
                assert table in migrated, f"Upgrade removed the existing {table} table"
                new_rows = migrated[table]
                assert len(old_rows) == len(new_rows), "Upgrade must preserve every existing record"
                for row in old_rows:
                    assert any(all(saved.get(key) == value for key, value in row.items()) for saved in new_rows), f"Upgrade changed saved {table} data"
            d.passed("Upgrade preserves all existing session, tree and feature records")
        else:
            d.click("Garden")
            assert any("No trees" in t for t in texts())
            d.click("History")
            assert any("No sessions" in t for t in texts())
            d.passed("Empty garden/history and working navigation")
        d.click("Timer")
        d.screenshot("empty-timer")
        initial_rows, initial_trees = snapshot("initial-records")

        for value in ("", "0", "121", "abc"):
            d.edit(value, label="Duration")
            d.click("Start")
            assert snapshot("invalid-" + (value or "blank"))[0] == initial_rows
            assert any("1" in t and "120" in t for t in texts())
        d.passed("Blank, zero, out-of-range and nonnumeric durations create no session")

        first = start()
        start_labels = texts()
        if "Resume" in start_labels:
            d.click("Resume")
            d.click("Resume")
        assert len(snapshot("duplicate-start")[0]) == len(initial_rows) + 1
        d.screenshot("timer-growing-early")
        d.click("Garden")
        d.click("History")
        d.click("Timer")
        assert current("internal-navigation")["id"] == first["id"]
        assert current("internal-navigation-state")["status"] == "RUNNING"
        time.sleep(8)
        d.screenshot("timer-growing-later")
        assert texts() != start_labels, "Visible timer must change"
        wait_for_completion(first)
        assert any("grown" in t.lower() or "complete" in t.lower() for t in texts()), "Keep the completion result visible"
        rows, trees = snapshot("first-success")
        assert len(rows) == len(initial_rows) + 1 and len(trees) == len(initial_trees) + 1
        assert sum(tree["sessionId"] == first["id"] for tree in trees) == 1
        d.screenshot("completed-tree")
        d.click("Garden")
        d.screenshot("garden-one-tree")
        d.click("History")
        d.screenshot("history-one-session")
        d.restart()
        assert snapshot("success-restart") == (rows, trees)
        d.passed("Real one-minute timer, growth, internal navigation, exactly one tree and durable history")

        second = start(5)
        d.rotate(1)
        assert current("landscape")["status"] == "RUNNING", "Rotation must not abandon the timer"
        d.screenshot("landscape-active")
        d.click("Give up")
        choose(["Keep focusing", "Keep Focusing", "Cancel"])
        assert current("landscape-actions")["status"] == "RUNNING", "Landscape actions must be reachable without abandoning focus"
        d.rotate(0)
        d.adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(1)
        assert current("system-back")["status"] == "RUNNING", "Back must not silently abandon focus"
        assert any(node.get("package") == d.package for node in d.nodes()), "Back should keep the active app in the foreground"
        d.adb("shell", "input", "keyevent", "KEYCODE_SLEEP")
        time.sleep(4)
        assert current("screen-asleep")["status"] == "RUNNING", "Screen sleep must continue focus"
        d.adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        d.adb("shell", "wm", "dismiss-keyguard")
        time.sleep(1)
        assert current("screen-awake")["status"] == "RUNNING"
        d.adb("shell", "input", "keyevent", "KEYCODE_HOME")
        time.sleep(3)
        d.launch()
        assert current("external-app")["status"] == "FAILED", "Leaving after unlocking must fail the session"
        assert len(snapshot("failed-no-tree")[1]) == len(initial_trees) + 1
        assert any("fail" in t.lower() or "wither" in t.lower() for t in texts())
        d.screenshot("withered-tree")
        d.passed("Rotation and screen lock preserve focus; external app switch after unlock fails it")

        third = start(120)
        d.restart()
        recovered = current("active-process-restart")
        assert recovered["id"] == third["id"] and recovered["status"] == "RUNNING"
        assert len(snapshot("restart-no-duplicates")[0]) == len(initial_rows) + 3
        choose(["Give up", "Give Up"])
        choose(["Keep focusing", "Keep Focusing", "Cancel"])
        assert current("give-up-cancel")["status"] == "RUNNING"
        choose(["Give up", "Give Up"])
        choose(["Give up", "Give Up", "Confirm", "Yes"], last=True)
        assert current("recovered-abandon")["status"] == "FAILED"
        d.passed("Process restart resumes the same timer; cancel and confirm Give up preserve correct outcomes")

        fourth = start()
        d.adb("shell", "input", "keyevent", "KEYCODE_SLEEP")
        print("Waiting for a real one-minute session with the screen off", flush=True)
        wait_for_completion(fourth, check_now=False)
        d.adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        d.adb("shell", "wm", "dismiss-keyguard")
        time.sleep(2)
        assert current("locked-completed")["status"] == "COMPLETED"
        d.screenshot("locked-session-completed")
        before = snapshot("all-results")
        assert len(before[0]) == len(initial_rows) + 4 and len(before[1]) == len(initial_trees) + 2
        assert len({tree["sessionId"] for tree in before[1]}) == len(before[1])
        outcomes = {row["id"]: row["status"] for row in before[0]}
        assert [outcomes[row["id"]] for row in (first, second, third, fourth)] == ["COMPLETED", "FAILED", "FAILED", "COMPLETED"]
        d.restart()
        d.click("Garden")
        d.screenshot("final-garden")
        d.click("History")
        d.screenshot("final-history")
        assert snapshot("final-restart") == before
        d.passed("Screen-off completion and repeated reload preserve two successes, two failures and two earned trees")

    d.click("Timer")
    interrupted = start()
    d.adb("shell", "am", "force-stop", d.package)
    assert current("stopped-process")["status"] == "RUNNING"
    print("Waiting past the deadline with the process stopped", flush=True)
    wait_for_completion(interrupted, check_now=False)
    d.launch()
    recovery_deadline = time.monotonic() + 10
    while True:
        recovered = current("overdue-process-recovery")
        if recovered["status"] != "RUNNING" or time.monotonic() >= recovery_deadline:
            break
        time.sleep(.3)
    # Case +5's approved recovery flow explicitly completes elapsed sessions.
    # Earlier case reports retain their tested legacy failure policy; do not
    # infer the expected result from whatever the installed app happens to do.
    expected_recovery = d.case.get("overdueRecoveryExpected", "FAILED")
    assert expected_recovery in ("COMPLETED", "FAILED")
    assert recovered["id"] == interrupted["id"] and recovered["status"] == expected_recovery, f"Unexpected recovered session: {recovered}"
    after_recovery = snapshot("overdue-outcome")
    assert len(after_recovery[0]) == len(before[0]) + 1
    if expected_recovery == "COMPLETED":
        assert any("grown" in t.lower() or "complete" in t.lower() for t in texts()), "Recovered completion must stay visible"
        assert len(after_recovery[1]) == len(before[1]) + 1
        assert sum(tree["sessionId"] == interrupted["id"] for tree in after_recovery[1]) == 1
        assert all(tree in after_recovery[1] for tree in before[1]), "Recovery changed earlier trees"
        result_label = "one completed session with a visible result and exactly one earned tree"
    else:
        assert any("fail" in t.lower() or "wither" in t.lower() for t in texts()), "Recovered failure must be visible on Timer"
        assert any("withered" in n.get("content-desc", "").lower() for n in d.nodes()), "Recovered failure must show the withered tree"
        assert after_recovery[1] == before[1]
        result_label = "one failed session with a visible withered tree"
    d.screenshot("overdue-recovery-outcome")
    d.restart()
    assert snapshot("overdue-repeated-recovery") == after_recovery
    d.passed("An overdue killed process recovers " + result_label + "; restarting creates no duplicate result")
    d.report(True)
    print(f"{case_id} core acceptance passed", flush=True)
except BaseException as error:
    d.report(False, str(error))
    raise
finally:
    d.rotate(0)
    d.adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    d.adb("shell", "wm", "dismiss-keyguard")
