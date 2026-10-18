#!/usr/bin/env python3
"""Real keyboard/viewport regression before the longer Forest acceptance run."""
import runpy
from pathlib import Path

helpers = runpy.run_path(str(Path(__file__).with_name("forest-features-native.py")))
d = helpers["d"]
d.report_file = "keyboard-runtime-report.json"

try:
    d.install()
    before = d.database("keyboard-before")
    assert not any(s["status"] == "RUNNING" for s in before["sessions"]), "Finish the current session first"
    for text in ("First keyboard task", "Second keyboard task", "Third keyboard task"):
        helpers["add_task"](text)
    d.screenshot("keyboard-three-draft-tasks")
    d.passed("Repeated task input remains focused and accepts verified text with the real keyboard")
    d.rotate(1)
    helpers["hide_keyboard"]()
    helpers["add_task"]("Landscape keyboard task")
    d.screenshot("keyboard-landscape-task")
    d.rotate(0)
    helpers["hide_keyboard"]()
    for text in ("First keyboard task", "Second keyboard task", "Third keyboard task", "Landscape keyboard task"):
        helpers["seek"](lambda n: n.get("text") == text)
    d.passed("All four draft tasks remain reachable after landscape keyboard input and rotation")
    d.restart()
    after = d.database("keyboard-after")
    for table in ("sessions", "trees", "task_items"):
        assert after[table] == before[table], f"Draft keyboard input changed saved {table}"
    d.report(True)
except BaseException as error:
    d.report(False, str(error))
    try:
        d.screenshot("keyboard-failure")
    except Exception:
        pass
    raise
finally:
    d.rotate(0)
