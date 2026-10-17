#!/usr/bin/env python3
"""Early upgrade and new-form keyboard checks; never passes the full case gate."""
import runpy
from pathlib import Path

h = runpy.run_path(str(Path(__file__).with_name("forest-features-native.py")))
d, click, seek = h["d"], h["click"], h["seek"]
assert d.case["id"] == "forest-five"
d.report_file = "upgrade-form-probe.json"

try:
    before = d.database("probe-before-upgrade")
    d.install(clear=False)
    after = d.database("probe-after-upgrade")
    for table, rows in before.items():
        if table in ("room_master_table", "android_metadata", "sqlite_sequence"):
            continue
        assert table in after and len(after[table]) == len(rows), "Lost records in " + table
        for row in rows:
            assert any(all(saved.get(k) == v for k, v in row.items()) for saved in after[table]), "Changed prior values in " + table
    d.passed("Upgrade retains every old record and field value while adding the new schema")
    click("Timer")
    d.tap_node(seek(lambda n: n.get("content-desc", "").startswith("Today: ")))
    d.rotate(1)
    d.edit("60", label="Daily goal minutes", capture="probe-goal-landscape-keyboard")
    click("Cancel")
    d.passed("Daily goal can be typed and cancelled in landscape with the real keyboard")
    d.tap_node(seek(lambda n: n.get("content-desc", "").startswith("Choose preset")))
    d.edit("Landscape preset", label="Preset name", capture="probe-preset-name-keyboard")
    d.edit("1", label="Preset duration", capture="probe-preset-duration-keyboard")
    click("Back to Timer", description=True)
    d.passed("Both preset fields remain reachable while typing in landscape")
    d.report(True)
except BaseException as error:
    d.report(False, str(error))
    d.screenshot("probe-failure")
    raise
finally:
    d.rotate(0)
