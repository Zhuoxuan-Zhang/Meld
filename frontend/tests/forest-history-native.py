#!/usr/bin/env python3
"""Targeted regression for an existing four-task session's note editor.

Run after downloading the delivered APK. Uses saved UI-created fixture data.
It never clears the app or changes generated source.
"""
import runpy
from pathlib import Path

helpers = runpy.run_path(str(Path(__file__).with_name("forest-features-native.py")))
d = helpers["d"]
click, seek, hide_keyboard, database = [helpers[key] for key in ("click", "seek", "hide_keyboard", "db")]
d.report_file = "history-layout-runtime-report.json"

try:
    d.install(clear=False)
    d.adb("logcat", "-c")
    before = database("layout-before")
    click("History")
    card = seek(lambda node: node.get("content-desc", "").endswith(", 4 tasks"))
    d.tap_node(card)
    hide_keyboard()
    labels = ["Plan next focus", "Review next focus", "Recall key point", "Summarize next focus"]
    for text in labels:
        seek(lambda node: node.get("text") == text)
    d.screenshot("four-archived-tasks-portrait")
    d.passed("All four archived tasks are reachable in portrait")
    d.rotate(1)
    hide_keyboard()
    assert any(node.get("package") == d.package for node in d.nodes()), "App crashed while rotating the note editor"
    for text in labels:
        seek(lambda node: node.get("text") == text)
    d.edit("Landscape draft", label="Reflection note", upward=False)
    d.screenshot("four-archived-tasks-landscape")
    d.rotate(0)
    hide_keyboard()
    seek(lambda node: node.get("class") == "android.widget.EditText" and node.get("text") == "Landscape draft")
    click("Cancel")
    after = database("layout-after")
    for table in ("sessions", "trees", "task_items"):
        assert before[table] == after[table], f"Rotation/Cancel changed saved {table} data"
    d.passed("All four tasks remain reachable in landscape; an unsaved note survives rotation and Cancel leaves data unchanged")
    d.report(True)
except BaseException as error:
    d.report(False, str(error))
    try:
        d.screenshot("history-layout-failure")
    except Exception:
        pass
    raise
finally:
    (d.out / "history-landscape-crash.log").write_text(d.adb("logcat", "-d", "-s", "AndroidRuntime:E"))
    d.rotate(0)
