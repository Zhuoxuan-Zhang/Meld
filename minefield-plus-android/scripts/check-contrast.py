#!/usr/bin/env python3
"""Check selected shipped color pairs and save the design evidence receipt."""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
source = (ROOT / "app/src/main/java/com/meld/minefield/MainActivity.kt").read_text()


def palette(name):
  block = re.search(r"private val " + name + r" = \w+ColorScheme\((.*?)\n\)", source, re.S).group(1)
  return {role: "#" + (hex_value or "FFFFFF") for role, _, hex_value in
    re.findall(r"(\w+) = (Color\(0xFF([0-9A-F]{6})\)|Color\.White)", block)}


def luminance(color):
  values = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
  linear = [x / 12.92 if x <= .04045 else ((x + .055) / 1.055) ** 2.4 for x in values]
  return sum(a * b for a, b in zip(linear, [.2126, .7152, .0722]))


light, dark = palette("LightColors"), palette("DarkColors")
assert "Color(0xFF805600)" in source, "Review the changed light flag ink"
pairs = [
  ("light primary/on-primary", light["primary"], light["onPrimary"], 4.5),
  ("light text/background", light["onBackground"], light["background"], 4.5),
  ("dark primary/on-primary", dark["primary"], dark["onPrimary"], 4.5),
  ("dark text/background", dark["onBackground"], dark["background"], 4.5),
  ("light flag", "#805600", light["surface"], 3),
  ("light cell border", light["outlineVariant"], light["surface"], 3),
  ("dark cell border", dark["outlineVariant"], dark["surface"], 3)
]
checks = []
for role, foreground, background, minimum in pairs:
  low, high = sorted([luminance(foreground), luminance(background)])
  ratio = (high + .05) / (low + .05)
  checks.append(dict(role=role, foreground=foreground, background=background, ratio=round(ratio, 2), minimum=minimum, passed=ratio >= minimum))
passed = all(c["passed"] for c in checks)
output = ROOT / "artifacts/design-contrast.json"
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps({"passed": passed, "checks": checks,
  "scope": "Shipped primary text, accent, light flag and cell-border pairs; not an exhaustive automated accessibility audit."}, indent=2) + "\n")
print(json.dumps({"passed": passed, "pairs": len(checks), "receipt": str(output)}))
raise SystemExit(0 if passed else 1)
