#!/usr/bin/env python3
"""Package an exact verified development APK; refuse incomplete or mismatched evidence."""
import hashlib
import json
import pathlib
import shutil
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
APK = ROOT / "app/build/outputs/apk/debug/app-debug.apk"
NATIVE = pathlib.Path(sys.argv[1]).resolve()
DEST = pathlib.Path(sys.argv[2]).resolve()
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
native = json.loads((NATIVE / "runtime-report.json").read_text())
assert native["passed"] and native["apkSha256"] == digest(APK), "Native checks must match the exact APK"
assert native["packageId"] == "com.meld.minefield"
assert len(native["cases"]) >= 11 and all(case["passed"] for case in native["cases"])
gesture_file = NATIVE / "gesture-report.json"
gesture = json.loads(gesture_file.read_text())
assert gesture["passed"] and gesture["apkSha256"] == digest(APK) and gesture["packageId"] == native["packageId"]
tests = list((ROOT / "app/build/test-results/testDebugUnitTest").glob("TEST-*.xml"))
assert tests, "No unit-test results"
test_count = 0
for test in tests:
  suite = ET.parse(test).getroot()
  assert int(suite.get("failures", "0")) == 0 and int(suite.get("errors", "0")) == 0
  assert int(suite.get("skipped", "0")) == 0
  test_count += int(suite.get("tests", "0"))
assert test_count >= 37
lint_file = ROOT / "app/build/reports/lint-results-debug.xml"
lint = list(ET.parse(lint_file).getroot())
assert all(item.get("severity") not in ("Error", "Fatal") for item in lint)
contrast_file = ROOT / "artifacts/design-contrast.json"
contrast = json.loads(contrast_file.read_text())
assert contrast["passed"], "Design contrast check did not pass"
signature_file = ROOT / "artifacts/apk-signature.txt"
assert signature_file.exists() and "Verifies" in signature_file.read_text(), "Missing APK signature verification"
assert digest(APK) in signature_file.read_text(), "Signature evidence must identify the current APK hash"
assert not DEST.exists(), "Delivery directory already exists; use a new immutable destination"
DEST.mkdir(parents=True)
shutil.copyfile(APK, DEST / "minefield-plus-v1.apk")
shutil.copyfile(NATIVE / "runtime-report.json", DEST / "runtime-report.json")
shutil.copyfile(gesture_file, DEST / "gesture-report.json")
for name in ("README.md", "docs/design-decisions.md", "docs/provenance.json"):
  target = DEST / name
  target.parent.mkdir(parents=True, exist_ok=True)
  shutil.copyfile(ROOT / name, target)
screens = DEST / "screenshots"
screens.mkdir()
for path in NATIVE.glob("*.png"):
  shutil.copyfile(path, screens / path.name)
verification = DEST / "verification"
verification.mkdir()
for path in tests + [lint_file, contrast_file]:
  shutil.copyfile(path, verification / path.name)
shutil.copyfile(signature_file, verification / signature_file.name)
source_files = [p for p in ROOT.rglob("*") if p.is_file() and
  not any(part in {"build", ".gradle", ".kotlin", "artifacts", "__pycache__"} for part in p.relative_to(ROOT).parts)]
receipt = {
  "app": "Minefield Plus", "version": "1.0.0", "packageId": native["packageId"],
  "apk": "minefield-plus-v1.apk", "apkSha256": digest(APK), "signing": "Android development debug certificate",
  "minSdk": 26, "targetSdk": 35,
  "checks": {"jvmTests": {"passed": True, "count": test_count},
    "androidLint": {"passed": True, "errors": 0, "warnings": sum(i.get("severity") == "Warning" for i in lint)},
    "designContrast": {"passed": True, "pairs": len(contrast["checks"])},
    "native": {"passed": True, "cases": len(native["cases"]), "device": native["device"], "supplementalLongPressAndModes": True},
    "authorship": "Direct Codex implementation; no successful Claude codegen/model-review run is claimed"},
  "sourceFiles": [{"path": str(p.relative_to(ROOT)), "sha256": digest(p)} for p in sorted(source_files)]
}
(DEST / "release-v1.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"destination": str(DEST), "sha256": receipt["apkSha256"], "unitTests": test_count, "nativeCases": len(native["cases"])}))
