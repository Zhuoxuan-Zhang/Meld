#!/usr/bin/env python3
"""UI acceptance of checklist and notes on the exact delivered Forest APK.

Run core acceptance first. This script never writes app data or app source.
"""
import runpy
import re
import sys
import time
from pathlib import Path

Device = runpy.run_path(str(Path(__file__).with_name("forest-native-driver.py")))["Device"]
d = Device(sys.argv[1] if len(sys.argv) > 1 else "forest-two")


def seek(predicate):
    def eligible(node):
        bounds = list(map(int, re.findall(r"\d+", node.get("bounds", ""))))
        return len(bounds) == 4 and bounds[2] > bounds[0] and bounds[3] > bounds[1] and node.get("enabled") == "true" and predicate(node)
    nodes = d.nodes()
    # Search the remaining content first, then return toward the top. Stop at
    # a repeated viewport instead of performing empty swipes at a boundary.
    for upward in (False, True):
        seen = set()
        for _ in range(16):
            matches = [n for n in nodes if eligible(n)]
            if matches:
                return matches[0]
            viewport = tuple((n.get("class"), n.get("text"), n.get("content-desc"), n.get("bounds")) for n in nodes)
            if viewport in seen:
                break
            seen.add(viewport)
            d.scroll(upward=upward, nodes=nodes)
            nodes = d.nodes()
    raise AssertionError(f"Control missing: {d.labels()}")


def click(text, description=False):
    key = "content-desc" if description else "text"
    d.tap_node(seek(lambda n: n.get(key) == text))


def hide_keyboard():
    # Back only dismisses the IME; never send it to the running app by accident.
    window = d.adb("shell", "dumpsys", "input_method")
    if "mInputShown=true" in window:
        d.adb("shell", "input", "keyevent", "KEYCODE_BACK")


def db(label):
    return d.database("features-" + label)


def tasks(label, session_id):
    return sorted((t for t in db(label)["task_items"] if t["sessionId"] == session_id), key=lambda t: t["text"])


def session(label, session_id):
    return next(s for s in db(label)["sessions"] if s["id"] == session_id)


def add_task(text):
    seek(lambda n: n.get("class") == "android.widget.EditText" and any("Add a task" in (c.get("text", "") + c.get("content-desc", "")) for c in n.iter("node")))
    d.edit(text, label="Add a task", upward=False)
    click("Add task", description=True)
    hide_keyboard()


def toggle(text):
    row = seek(lambda n: n.get("content-desc") in ("Checked: " + text, "Unchecked: " + text))
    checkbox = next((n for n in row.iter("node") if n.get("checkable") == "true"), None)
    assert checkbox is not None, "Checklist row must expose a checkbox"
    d.tap_node(checkbox)


def edit_task(old, new, blank_first=False, cancel=False):
    click("Edit task " + old, description=True)
    if blank_first:
        d.edit("", label="Edit task text")
        # Either disabled Save or a visible validation error is acceptable.
        save = next(n for n in d.nodes() if n.get("content-desc") == "Save task edit")
        if save.get("enabled") == "true":
            d.tap_node(save)
        assert any(n.get("content-desc") == "Edit task text" for n in d.nodes()), "Blank edit closed the editor"
    d.edit(new, label="Edit task text")
    click("Cancel task edit" if cancel else "Save task edit", description=True)
    hide_keyboard()


def start(minutes):
    d.edit(str(minutes), label="Duration")
    click("Start")
    value = db("start")
    row = max(value["sessions"], key=lambda s: s["startedAt"])
    assert row["status"] == "RUNNING", "Task selection must not complete a session"
    return row


def open_history(minutes, status):
    click("History")
    node = seek(lambda n: n.get("content-desc", "").startswith(f"{minutes} minute session, {status},"))
    d.tap_node(node)
    hide_keyboard()


def write_note(text, cancel=False):
    d.edit(text, label="Reflection note")
    click("Cancel" if cancel else "Save")



def run():
    try:
        d.inherit_core_checks()
        d.report(False, "Feature acceptance checks in progress")
        d.restart()
        click("Timer")
        initial = db("initial")
        add_task("")
        assert db("blank")["task_items"] == initial["task_items"], "Blank task was saved"
        assert any("cannot be empty" in n.get("text", "").lower() for n in d.nodes()), "Blank task must show a validation message"
        add_task("Read first chapter")
        add_task("Write three points")
        add_task("Remove this task")
        toggle("Read first chapter")
        edit_task("Read first chapter", "Read second chapter", blank_first=True)
        click("Delete task Remove this task", description=True)
        d.screenshot("features-upcoming-checklist")
        failed = start(120)
        first_tasks = tasks("started-checklist", failed["id"])
        assert [(t["text"], bool(t["isChecked"])) for t in first_tasks] == [("Read second chapter", True), ("Write three points", False)]
        first_id = first_tasks[0]["id"]
        add_task("")
        assert tasks("blank-active-task", failed["id"]) == first_tasks
        edit_task("Read second chapter", "Read final chapter")
        assert next(t for t in tasks("edit-active", failed["id"]) if t["id"] == first_id)["text"] == "Read final chapter"
        edit_task("Read final chapter", "Discarded task edit", cancel=True)
        assert next(t for t in tasks("cancel-active-edit", failed["id"]) if t["id"] == first_id)["text"] == "Read final chapter"
        toggle("Write three points")
        add_task("Temporary active task")
        click("Delete task Temporary active task", description=True)
        assert session("active-after-crud", failed["id"])["status"] == "RUNNING"
        active_tasks = tasks("active-before-restart", failed["id"])
        assert all(bool(t["isChecked"]) for t in active_tasks) and len(active_tasks) == 2
        d.restart()
        assert tasks("active-after-restart", failed["id"]) == active_tasks
        assert session("active-recovered", failed["id"])["status"] == "RUNNING"
        d.passed("Task create/edit/check/delete and cancelled edits work; blank tasks/edits rejected; active checklist survives restart")
        click("Give up")
        d.click("Give up", occurrence=-1)
        assert session("abandoned", failed["id"])["status"] == "FAILED"
        assert not any(t["sessionId"] == failed["id"] for t in db("failed-no-tree")["trees"])
        archived = tasks("archived-failure", failed["id"])

        add_task("Plan next focus")
        add_task("Review next focus")
        add_task("Recall key point")
        add_task("Summarize next focus")
        toggle("Plan next focus")
        assert tasks("next-draft-leaves-archive", failed["id"]) == archived
        completed = start(1)
        assert completed["id"] != failed["id"]
        upcoming = tasks("next-started", completed["id"])
        assert [(t["text"], bool(t["isChecked"])) for t in upcoming] == [("Plan next focus", True), ("Recall key point", False), ("Review next focus", False), ("Summarize next focus", False)]
        assert tasks("previous-session-unchanged", failed["id"]) == archived
        deadline = completed["startedAt"] / 1000 + 62
        while time.time() < deadline:
            time.sleep(min(10, max(.1, deadline - time.time())))
        assert session("success", completed["id"])["status"] == "COMPLETED"
        assert tasks("success-tasks", completed["id"]) == upcoming
        assert sum(t["sessionId"] == completed["id"] for t in db("success-one-tree")["trees"]) == 1
        d.passed("Upcoming checklist is separate from archived tasks; success and failure retain their own checklist and correct tree outcome")

        open_history(1, "Completed")
        assert not any((n.get("content-desc", "").startswith("Edit task ") or n.get("content-desc", "").startswith("Delete task ")) and n.get("enabled") == "true" for n in d.nodes()), "Archived tasks must be read-only"
        for task in upcoming:
            seek(lambda n: n.get("text") == task["text"])
        d.screenshot("features-completed-reflection")
        d.rotate(1)
        hide_keyboard()
        for task in upcoming:
            seek(lambda n: n.get("text") == task["text"])
        d.edit("Landscape draft", label="Reflection note", upward=False)
        d.screenshot("features-landscape-reflection")
        d.rotate(0)
        hide_keyboard()
        seek(lambda n: n.get("class") == "android.widget.EditText" and n.get("text") == "Landscape draft")
        d.passed("Four archived tasks remain reachable in portrait and landscape; an unsaved reflection survives rotation")
        write_note("Completed quiet reading")
        assert session("note-completed", completed["id"])["note"] == "Completed quiet reading"
        open_history(120, "Failed")
        write_note("Interrupted by doorbell")
        assert session("note-failed", failed["id"])["note"] == "Interrupted by doorbell"
        open_history(1, "Completed")
        write_note("This edit is cancelled", cancel=True)
        assert session("note-cancelled", completed["id"])["note"] == "Completed quiet reading"
        open_history(1, "Completed")
        write_note("Finished reading chapter")
        assert session("note-edited", completed["id"])["note"] == "Finished reading chapter"
        open_history(1, "Completed")
        write_note("")
        assert session("note-cleared", completed["id"])["note"] in (None, "")
        assert session("other-note-retained", failed["id"])["note"] == "Interrupted by doorbell"
        d.passed("Completed and failed reflections support add/edit/cancel/clear without changing another session; archived checklists are read-only")
        before = db("final-before-restart")
        d.restart()
        after = db("final-after-restart")
        for table in ("sessions", "trees", "task_items"):
            assert after[table] == before[table], f"Restart changed {table}"
        click("History")
        d.screenshot("features-final-history")
        d.passed("All task states, outcomes and reflection notes persist with the correct session after process restart")
        if d.case["id"] == "forest-five":
            d.report_file = "checklist-notes-runtime-report.json"
        d.report(True)
        print("Checklist and note acceptance passed", flush=True)
    except BaseException as error:
        d.report(False, str(error))
        try:
            d.screenshot("features-failure")
        except Exception:
            pass
        raise
    finally:
        d.rotate(0)


if __name__ == "__main__":
    run()
