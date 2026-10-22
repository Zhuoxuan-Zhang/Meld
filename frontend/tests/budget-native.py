#!/usr/bin/env python3
"""Opt-in real-device acceptance for Pocket Ledger. Only visible UI writes data."""
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time
import traceback

ForestHarness = runpy.run_path(str(Path(__file__).with_name("forest-native.py")))
CandidateDevice = ForestHarness["CandidateDevice"]
SourceHarnessSelectorError = ForestHarness["HarnessSelectorError"]


class HarnessSelectorError(Exception):
    pass


class BudgetDevice(CandidateDevice):
    # Keep driver/selector failures recognizable to the build worker. Imported
    # runpy exceptions otherwise print a module prefix that obscures their type.
    def seek(self, *args, **kwargs):
        try:
            return super().seek(*args, **kwargs)
        except SourceHarnessSelectorError as error:
            raise HarnessSelectorError(str(error)) from None

    def edit(self, *args, **kwargs):
        try:
            return super().edit(*args, **kwargs)
        except SourceHarnessSelectorError as error:
            raise HarnessSelectorError(str(error)) from None

    def report(self, passed, error=None):
        report = super().report(passed, error)
        report["scope"] = "Actual Pocket Ledger APK and UI interactions on one Android emulator. Ledger snapshots are read-only copies. No original-app visual/runtime equivalence, physical-device or release-performance claim."
        (self.out / "runtime-report.json").write_text(json.dumps(report, indent=2))
        return report

    def transaction_rows(self, name):
        return self.database(name)["transactions"]

    def category(self, name):
        for _ in range(6):
            nodes = self.nodes()
            matches = [node for node in nodes if (node.get("content-desc") or "").startswith(name + ",")
                       and "Edit monthly limit" in (node.get("content-desc") or "")
                       and node.get("bounds") != "[0,0][0,0]"]
            if matches:
                self.tap_node(matches[0])
                return
            self.scroll(nodes=nodes)
        raise HarnessSelectorError("Category budget row not found: " + name)


def dismiss_changes(d):
    d.tap("Back")
    if "Discard unsaved changes?" in d.texts():
        d.tap("Discard")


def top(d):
    d.tap("Home", scroll=False)
    for _ in range(3):
        d.scroll(upward=True)


def show_text(d, fragment):
    for _ in range(6):
        if fragment.casefold() in d.texts().casefold():
            return
        d.scroll()
    raise AssertionError("Expected visible product text: " + fragment)


def set_limit(d, category, amount):
    d.tap("Insights", scroll=False)
    d.category(category)
    d.edit(amount)
    d.tap(["Save limit", "Save budget", "Save"])
    snapshot = d.database("budget-" + category.lower())
    row = next(row for row in snapshot["categories"] if row["name"] == category)
    assert row["monthlyLimitCents"] == int(amount) * 100, "Budget edit must persist the exact amount"


def add_transaction(d, title, amount, category="Food", income=False):
    top(d)
    d.tap("Add transaction", scroll=False)
    d.edit(title, label="Title")
    d.edit(amount, label="Amount")
    d.tap(category)
    if income:
        d.tap("Income")
    d.tap(["Save transaction", "Save"])
    rows = d.transaction_rows("saved-" + title.lower())
    assert sum(row["title"] == title for row in rows) == 1, "A save must create exactly one transaction"


def sandbox(d, title, amount):
    top(d)
    d.tap("Try a purchase", scroll=False)
    d.edit(title, label="Title")
    d.edit(amount, label="Amount")
    d.tap("Shopping")


def cases(d):
    assert "Pocket Ledger" in d.texts(), "The real app must load"
    assert not d.transaction_rows("initial"), "A fresh install must not invent transactions"
    assert "Try a purchase" in d.texts(), "Primary purchase-preview action must be initially visible"
    d.screenshot("z-home-empty")
    d.passed("Fresh install: no invented history and primary preview action visible")

    set_limit(d, "Food", "200")
    set_limit(d, "Shopping", "50")
    d.screenshot("a-budget-breakdown")
    d.passed("Category limits persist as exact integer cents")

    add_transaction(d, "Lunch", "12.50")
    add_transaction(d, "Salary", "1000", "Food", income=True)
    rows = d.transaction_rows("income-and-expense")
    assert len(rows) == 2
    assert next(row for row in rows if row["title"] == "Lunch")["amountCents"] == 1250
    assert next(row for row in rows if row["title"] == "Salary")["type"] == "INCOME"
    top(d)
    assert "$12.50" in d.texts(), "Monthly spending must exclude income"
    d.screenshot("home-ready")
    d.passed("Income and expense save; monthly spending excludes income")

    original = d.transaction_rows("before-preview")
    sandbox(d, "Shoes", "60")
    show_text(d, "over budget")
    assert "10.00" in d.texts() and "over" in d.texts().lower(), "Preview must explain the category deficit"
    d.screenshot("b-purchase-overbudget")
    assert d.transaction_rows("during-preview") == original, "Preview must not mutate ledger transactions"
    dismiss_changes(d)
    assert d.transaction_rows("cancelled-preview") == original, "Cancelling must leave the ledger unchanged"
    d.passed("Over-budget comparison is visible; preview and cancel do not write transactions")

    sandbox(d, "Shoes", "12.345")
    assert d.transaction_rows("invalid-preview") == original
    candidates = []
    for _ in range(6):
        candidates = [node for node in d.nodes() if node.get("clickable") == "true"
                      and any((child.get("text") or "") in ("Record purchase", "Record") for child in node.iter("node"))]
        if candidates:
            break
        d.scroll()
    assert candidates and all(node.get("enabled") == "false" for node in candidates), "Fractional-cent input must not be recordable"
    d.screenshot("z-invalid-precision")
    dismiss_changes(d)
    d.passed("Fractional cents are rejected without changing the ledger")

    sandbox(d, "Shoes", "20")
    show_text(d, "$30.00")
    assert "$30.00" in d.texts(), "Preview must show the exact projected category balance"
    d.rotate(1)
    for _ in range(3):
        d.scroll(upward=True)
    assert "Shoes" in d.texts() and "20" in d.texts(), "Rotation must preserve the hypothetical purchase"
    d.rotate(0)
    show_text(d, "$30.00")
    d.screenshot("purchase-affordable")
    d.passed("Purchase draft and comparison survive rotation")

    remote = "/sdcard/meld-pocket-ledger-record.mp4"
    recording = subprocess.Popen([d.adb_path, "-s", d.serial, "shell", "screenrecord", "--bit-rate", "2500000", "--time-limit", "40", remote], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(3)
        node = d.seek(["Record purchase", "Record"])
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", node.get("bounds")))
        for _ in range(2):
            d.adb("shell", "input", "tap", (x1 + x2) // 2, (y1 + y2) // 2)
        time.sleep(2)
        recorded = d.transaction_rows("recorded-purchase")
        assert len(recorded) == 3 and sum(row["title"] == "Shoes" for row in recorded) == 1, "Repeated confirmation must create exactly one purchase"
        assert next(row for row in recorded if row["title"] == "Shoes")["amountCents"] == 2000
        top(d)
        assert "$32.50" in d.texts(), "Recording must update actual monthly spending"
        d.screenshot("c-purchase-recorded")
        time.sleep(3)
    finally:
        subprocess.run([d.adb_path, "-s", d.serial, "shell", "pkill", "-2", "screenrecord"], capture_output=True, check=False)
        recording.wait(timeout=10)
        d.adb("pull", remote, str(d.out / "purchase-record-actual.mp4"))
    d.restart()
    assert d.transaction_rows("restarted") == recorded, "Restart must preserve records and not replay a confirmed purchase"
    d.passed("Explicit repeated record creates one expense, updates totals and survives restart")

    # Calendar drill-down, edit and delete are exercised through the actual UI.
    d.tap("Calendar", scroll=False)
    date = d.adb("shell", "date", "+%F").strip()
    matches = [node for node in d.nodes() if (node.get("content-desc") or "").startswith(date + ",")
               and node.get("bounds") != "[0,0][0,0]"]
    if not matches:
        raise HarnessSelectorError("Today's accessible calendar cell not found: " + date)
    d.tap_node(matches[0])
    assert "Lunch" in d.texts() and "Shoes" in d.texts()
    d.screenshot("z-calendar-day")
    d.tap("Lunch")
    d.edit("15", label="Amount")
    d.tap(["Save transaction", "Save"])
    edited = d.transaction_rows("edited-lunch")
    assert next(row for row in edited if row["title"] == "Lunch")["amountCents"] == 1500
    d.tap("Delete Lunch")
    d.tap("Cancel")
    assert len(d.transaction_rows("cancel-delete")) == 3
    d.tap("Delete Lunch")
    d.tap("Delete")
    final = d.transaction_rows("deleted-lunch")
    assert len(final) == 2 and not any(row["title"] == "Lunch" for row in final)
    d.restart()
    assert d.transaction_rows("final-restarted") == final
    d.passed("Calendar drill-down, edit and confirmed delete stay consistent and durable")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: budget-native.py APK GENERATED_PACKAGE_ID")
    d = BudgetDevice(sys.argv[1], sys.argv[2])
    try:
        d.install(clear=True)
        cases(d)
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
