#!/usr/bin/env python3
"""Export source snapshots of delivered demo APKs, excluding local run logs."""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / "frontend/.meld-cache/workflow"
DEMOS = {
    "focus-grove": "project-282843ad-103f-4458-9a40-d192b65be2ba",
    "pocket-ledger": "project-a92b60ad-6e5a-445d-94f4-4b0f5d2c6064",
}


def export(name, project_id):
    project = json.loads((WORKFLOW / "projects" / f"{project_id}.json").read_text())
    build = project["latestBuild"]
    assert build["status"] == "succeeded" and not project["needsDesign"]
    assert build["revision"] == project["currentDesignRevision"]
    original = WORKFLOW / "builds" / build["id"]
    report = json.loads((original / "artifacts/build-report.json").read_text())
    assert report["build"] and report["unitTests"] and report["lint"] and report["runtimeVerified"]
    artifact = next(item for item in build["artifacts"] if item["name"] == "app.apk")
    assert hashlib.sha256((original / "artifacts/app.apk").read_bytes()).hexdigest() == artifact["sha256"]
    output = ROOT / "examples" / name / "android"
    assert not output.exists(), "Preserve a previously exported snapshot; update it deliberately"
    output.mkdir(parents=True)
    for relative in ["app/src", "app/schemas", "gradle/wrapper", "gradlew", "settings.gradle.kts", "build.gradle.kts", "gradle.properties", "app/build.gradle.kts"]:
        source, target = original / "source" / relative, output / relative
        if not source.exists():
            continue
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    generated = sorted((original / "model").glob("implementation-*.json"), key=lambda file: int(file.stem.split("-")[-1]))[-1]
    files = json.loads(generated.read_text())["files"]
    for file in files:
        assert (output / file["path"]).read_text() == file["content"], "Published app source must match the exact model output that was built"
    hashes = {str(file.relative_to(output)): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(output.rglob("*")) if file.is_file()}
    provenance = {"projectId": project_id, "buildId": build["id"], "revision": build["revision"], "apkSha256": artifact["sha256"], "packageId": report["packageId"], "sourceMatchesModelOutput": True, "validation": build["validation"], "sourceSha256": hashes}
    (output.parent / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    (output.parent / "README.md").write_text(f"# {project['brief']['name']}\n\nGenerated Android source for the [Meld product demo](../../README.md). This snapshot matches the recorded tested build; it contains no base-app code, APKs, model logs or local credentials.\n\nWith JDK 17+ and Android SDK 35 configured in `ANDROID_HOME`, run:\n\n```bash\ncd examples/{name}/android\n./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug\n```\n\nSee [provenance.json](provenance.json) for the source hashes, original APK hash and validation scope. A rebuild has its own APK hash and debug signing key.\n")
    print(name, len(hashes), "source files exported")


if __name__ == "__main__":
    for name, project_id in DEMOS.items():
        export(name, project_id)
