#!/usr/bin/env python3
"""Real UI acceptance of goals, presets and search on the delivered +5 APK.

Run core and checklist/notes acceptance first. No app-source or database writes.
"""
import json
import re
import runpy
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

h = runpy.run_path(str(Path(__file__).with_name("forest-features-native.py")))
d = h["d"]
click, seek, hide_keyboard, add_task = [h[key] for key in ("click", "seek", "hide_keyboard", "add_task")]
assert d.case["id"] == "forest-five"


def db(label):
    return d.database("five-" + label)


def goal(data):
    rows = data.get("daily_goal", [])
    assert len(rows) <= 1, "Daily goal must have one stored setting"
    return rows[0]["targetMinutes"] if rows else 60


def today_minutes(data):
    zone = ZoneInfo(d.adb("shell", "getprop", "persist.sys.timezone").strip() or "UTC")
    now = float(d.adb("shell", "date", "+%s").strip())
    today = datetime.fromtimestamp(now, zone).date()
    return sum(row["durationMinutes"] for row in data["sessions"]
               if row["status"] == "COMPLETED" and row["completedAt"] is not None
               and datetime.fromtimestamp(row["completedAt"] / 1000, zone).date() == today)


def progress(data):
    expected = (today_minutes(data), goal(data))
    node = seek(lambda n: n.get("content-desc", "").startswith("Today: "))
    match = re.fullmatch(r"Today: (\d+) of (\d+) minutes", node.get("content-desc"))
    assert match and tuple(map(int, match.groups())) == expected, (node.get("content-desc"), expected)
    return expected


def open_goal():
    d.tap_node(seek(lambda n: n.get("content-desc", "").startswith("Today: ")))


def save_goal(value):
    open_goal()
    d.edit(str(value), label="Daily goal minutes")
    click("Save")
    data = db("goal-" + str(value))
    assert goal(data) == value
    progress(data)


def presets():
    d.tap_node(seek(lambda n: n.get("content-desc", "").startswith("Choose preset")))


def preset_form(name, duration, capture=None):
    seek(lambda n: n.get("content-desc") == "Preset name")
    d.edit(name, label="Preset name")
    d.edit(str(duration), label="Preset duration", capture=capture)
    click("Save preset")


def preset_rows(data):
    return {row["id"]: row for row in data["presets"]}


def session_row(data, session_id):
    return next(row for row in data["sessions"] if row["id"] == session_id)


def search(query):
    seek(lambda n: n.get("content-desc") == "Search session notes and tasks")
    d.edit(query, label="Search session notes and tasks")


try:
    d.assert_installed()
    prior = json.loads((d.out / "checklist-notes-runtime-report.json").read_text())
    assert prior["passed"] and prior["projectId"] == d.project and prior["apkSha256"] == d.sha
    d.checks = prior["cases"]
    d.report(False, "Goal, preset and search acceptance in progress")
    d.restart()
    click("Timer")
    initial = db("initial")
    assert not any(row["status"] == "RUNNING" for row in initial["sessions"])
    progress(initial)
    save_goal(1)
    save_goal(480)
    valid = db("valid-goal")
    for invalid in ("", "0", "481", "abc"):
        open_goal()
        d.edit(invalid, label="Daily goal minutes")
        click("Save")
        assert db("invalid-goal-" + (invalid or "blank"))["daily_goal"] == valid["daily_goal"]
        seek(lambda n: n.get("content-desc") == "Daily goal minutes, 1 to 480")
        click("Cancel")
    open_goal()
    d.rotate(1)
    d.edit("60", label="Daily goal minutes", capture="goal-landscape-keyboard")
    d.screenshot("goal-landscape-draft")
    d.rotate(0)
    hide_keyboard()
    seek(lambda n: n.get("class") == "android.widget.EditText" and n.get("text") == "60")
    click("Cancel")
    assert goal(db("cancel-goal")) == 480
    save_goal(60)
    d.restart()
    assert goal(db("goal-restart")) == 60
    progress(db("goal-progress-restart"))
    d.passed("Daily goal accepts 1 and 480, rejects invalid values, supports landscape input/cancel and persists after restart")

    stamp = str(int(time.time()))
    short_name, renamed, long_name = "Quick " + stamp, "Quiet " + stamp, "Long " + stamp
    presets()
    old_presets = preset_rows(db("presets-initial"))
    for name, duration in [("", "1"), (short_name, ""), (short_name, "0"), (short_name, "121"), (short_name, "abc")]:
        preset_form(name, duration)
        assert preset_rows(db("preset-invalid")) == old_presets
    preset_form(short_name, 1)
    one = next(row for row in db("preset-one")["presets"] if row["name"] == short_name)
    assert one["durationMinutes"] == 1
    d.rotate(1)
    preset_form(long_name, 120, capture="preset-landscape-keyboard")
    d.screenshot("preset-landscape-input")
    d.rotate(0)
    hide_keyboard()
    saved = preset_rows(db("preset-boundaries"))
    assert len(saved) == len(old_presets) + 2
    preset_form(short_name.upper(), 5)
    assert preset_rows(db("preset-duplicate")) == saved
    click("Rename " + short_name, description=True)
    d.edit("", label="Rename preset " + short_name)
    click("Save")
    assert preset_rows(db("preset-blank-rename")) == saved
    d.edit(renamed, label="Rename preset " + short_name)
    click("Save")
    updated = preset_rows(db("preset-renamed"))
    assert updated[one["id"]] == {**one, "name": renamed}
    click("Rename " + renamed, description=True)
    d.edit("Discarded name", label="Rename preset " + renamed)
    click("Cancel")
    assert preset_rows(db("preset-rename-cancel")) == updated
    click("Delete " + long_name, description=True)
    click("Cancel")
    assert preset_rows(db("preset-delete-cancel")) == updated
    click("Delete " + long_name, description=True)
    click("Delete")
    assert len(preset_rows(db("preset-deleted"))) == len(old_presets) + 1
    d.restart()
    presets()
    click("Select " + renamed + ", 1 minutes", description=True)
    after_select = db("preset-selected")
    assert after_select["sessions"] == initial["sessions"], "Selecting or editing presets must not start/change a session"
    field = seek(lambda n: n.get("content-desc") == "Duration in minutes, 1 to 120")
    assert any(n.get("text") == "1" for n in field.iter("node")) or any(n.get("text") == "1" and n.get("bounds") == field.get("bounds") for n in d.nodes())
    d.passed("Presets validate name/duration, accept 1 and 120, reject duplicates, rename/cancel/delete correctly and survive restart without starting a session")

    task_text, note_text = "CedarTask " + stamp, "WillowNote " + stamp
    add_task(task_text)
    before_start = db("before-combined")
    before_minutes = progress(before_start)[0]
    click("Start")
    running = max(db("combined-running")["sessions"], key=lambda row: row["startedAt"])
    assert running["status"] == "RUNNING" and running["durationMinutes"] == 1 and running["presetId"] == one["id"]
    assert progress(db("active-goal"))[0] == before_minutes
    assert not any(n.get("content-desc", "").startswith("Choose preset") and n.get("enabled") == "true" for n in d.nodes())
    deadline = running["startedAt"] / 1000 + 62
    while time.time() < deadline:
        time.sleep(min(10, max(.1, deadline - time.time())))
    completed = db("combined-completed")
    assert session_row(completed, running["id"])["status"] == "COMPLETED"
    assert sum(tree["sessionId"] == running["id"] for tree in completed["trees"]) == 1
    assert progress(completed)[0] == before_minutes + 1
    d.restart()
    assert progress(db("combined-restart"))[0] == before_minutes + 1
    d.passed("A preset-driven session keeps its own task and earns exactly one tree and one minute of daily progress; restart never counts it twice")

    failed = h["start"](120)
    assert progress(db("long-running-goal"))[0] == before_minutes + 1
    click("Give up")
    d.click("Give up", occurrence=-1)
    failed_data = db("failed-goal")
    assert session_row(failed_data, failed["id"])["status"] == "FAILED"
    assert progress(failed_data)[0] == before_minutes + 1
    d.passed("Active and abandoned sessions contribute zero daily focus minutes")

    click("History")
    search(task_text.upper())
    card = seek(lambda n: n.get("content-desc", "").startswith("1 minute session, Completed,"))
    d.tap_node(card)
    seek(lambda n: n.get("text") == task_text)
    h["write_note"](note_text)
    assert session_row(db("search-note-saved"), running["id"])["note"] == note_text
    before_search = db("search-before")
    for query in (task_text.upper(), task_text.lower(), note_text.upper(), note_text.lower()):
        search(query)
        cards = [n for n in d.nodes() if re.match(r"\d+ minute session,", n.get("content-desc", ""))]
        assert len(cards) == 1, "Each unique task/note query must match only its one session"
        d.tap_node(cards[0])
        seek(lambda n: n.get("text") == task_text)
        seek(lambda n: n.get("class") == "android.widget.EditText" and n.get("text") == note_text)
        click("Cancel")
    search("NoSuchCedarWillow " + stamp)
    seek(lambda n: n.get("text") == "No matching sessions.")
    assert not any(re.match(r"\d+ minute session,", n.get("content-desc", "")) for n in d.nodes())
    d.screenshot("search-no-matches")
    click("Clear search", description=True)
    seek(lambda n: n.get("content-desc", "").startswith("120 minute session, Failed,"))
    d.screenshot("search-cleared")
    after_search = db("search-after")
    for table in ("sessions", "trees", "task_items", "presets", "daily_goal"):
        assert after_search[table] == before_search[table], "Search changed " + table
    d.passed("History search finds the same session by task and note in either case, shows no matches, clears correctly and never changes saved data")

    click("Timer")
    presets()
    click("Delete " + renamed, description=True)
    click("Delete")
    after_delete = db("used-preset-deleted")
    assert one["id"] not in preset_rows(after_delete)
    for table in ("sessions", "trees", "task_items"):
        assert after_delete[table] == after_search[table], "Deleting a used preset changed " + table
    d.restart()
    final = db("final-restart")
    for table in ("sessions", "trees", "task_items", "presets", "daily_goal"):
        assert final[table] == after_delete[table], "Restart changed " + table
    progress(final)
    d.screenshot("five-final-timer")
    d.passed("Deleting a used preset preserves its session, tasks, note and tree; all five features persist together after restart")
    d.report(True)
    print("Forest +5 full acceptance passed", flush=True)
except BaseException as error:
    d.report(False, str(error))
    try:
        d.screenshot("five-failure")
    except Exception:
        pass
    raise
finally:
    d.rotate(0)
