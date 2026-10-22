#!/usr/bin/env python3
"""Caption and compose actual Android captures; never draw replacement app UI."""
import hashlib
import json
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "frontend/public/demos"
WORK = ROOT / "outputs/comparison-videos"
FONT = Path("/usr/share/fonts/truetype/dejavu")


def font(size, bold=False):
    return ImageFont.truetype(str(FONT / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")), size)


def wrapped(draw, text, xy, width, size=21, fill="#44524b", bold=False):
    x, y = xy
    face = font(size, bold)
    line = ""
    for word in text.split():
        candidate = (line + " " + word).strip()
        if face.getlength(candidate) > width and line:
            draw.text((x, y), line, font=face, fill=fill)
            y += size + 10
            line = word
        else:
            line = candidate
    if line:
        draw.text((x, y), line, font=face, fill=fill)
    return y + size + 10


def background(demo, scene, index, total, output):
    image = Image.new("RGB", (1280, 800), "#f8f7f2")
    draw = ImageDraw.Draw(image)
    draw.text((40, 27), "MELD  /  REAL REFERENCES, WORKING APPS", font=font(15, True), fill="#52685b")
    draw.text((40, 61), demo["title"], font=font(34, True), fill="#203b2d")
    draw.line((40, 115, 1240, 115), fill="#d9dfd7", width=2)
    for x, label, note in [(56, demo["base"], demo["baseLabel"]), (390, demo["app"], "Generated Android APK")]:
        draw.text((x, 134), label, font=font(23, True), fill="#203b2d")
        draw.rounded_rectangle((x - 7, 172, x + 279, 724), radius=19, fill="white", outline="#ccd5cc", width=2)
        wrapped(draw, note, (x, 738), 285, size=13)
    accent = "#ae512d" if scene["kind"] == "addition" else "#2b7451"
    badge = "PROPOSED ADAPTATION" if scene["kind"] == "addition" else "SHARED FOUNDATION"
    draw.rounded_rectangle((742, 180, 1228, 223), radius=14, fill=accent)
    draw.text((760, 191), badge, font=font(17, True), fill="white")
    y = wrapped(draw, scene["heading"], (742, 254), 480, size=30, fill="#203b2d", bold=True) + 18
    for bullet in scene["points"]:
        draw.ellipse((744, y + 9, 752, y + 17), fill=accent)
        y = wrapped(draw, bullet, (770, y), 450, size=21) + 17
    wrapped(draw, scene.get("note", ""), (742, 647), 475, size=15, fill="#68766a")
    draw.text((40, 777), f"{index + 1:02d} / {total:02d}   |   BASE + SELECTED IDEAS + YOUR PRODUCT", font=font(12, True), fill="#607264")
    image.save(output)


def command(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Video command failed: " + result.stderr[-2400:])


def timestamp(seconds):
    millis = round(seconds * 1000)
    return f"{millis // 3600000:02d}:{millis // 60000 % 60:02d}:{millis // 1000 % 60:02d}.{millis % 1000:03d}"


def render(demo):
    if demo.get("runtimeReport"):
        report = json.loads((ROOT / demo["runtimeReport"]).read_text())
        if report.get("passed") is not True or report.get("apkSha256") != demo["apkSha256"]:
            raise AssertionError("Comparison must use the tested APK recorded by its native report")
    folder = WORK / demo["id"]
    folder.mkdir(parents=True, exist_ok=True)
    segments = []
    sources = {}
    duration = 0
    scenes = []
    for index, scene in enumerate(demo["scenes"]):
        frame = folder / f"scene-{index}.png"
        background(demo, scene, index, len(demo["scenes"]), frame)
        args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-loop", "1", "-framerate", "24", "-i", str(frame)]
        for side in ["left", "right"]:
            source = ROOT / scene[side]["path"]
            if not source.is_file():
                raise FileNotFoundError(source)
            sources[str(source.relative_to(ROOT))] = hashlib.sha256(source.read_bytes()).hexdigest()
            if source.suffix.lower() in [".png", ".jpg", ".jpeg"]:
                args += ["-loop", "1", "-framerate", "24", "-i", str(source)]
            else:
                args += ["-ss", str(scene[side].get("start", 0)), "-i", str(source)]
        segment = folder / f"scene-{index}.mp4"
        filters = (
            f"[1:v]setpts=(PTS-STARTPTS)/{scene['left'].get('speed', 1)},scale=272:544:force_original_aspect_ratio=decrease,pad=272:544:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration={scene['seconds']}[left];"
            f"[2:v]setpts=(PTS-STARTPTS)/{scene['right'].get('speed', 1)},scale=272:544:force_original_aspect_ratio=decrease,pad=272:544:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration={scene['seconds']}[right];"
            "[0:v][left]overlay=56:176[base];[base][right]overlay=390:176,format=yuv420p[out]"
        )
        args += ["-filter_complex_threads", "1", "-filter_complex", filters, "-map", "[out]", "-t", str(scene["seconds"]), "-an", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "23", "-r", "24", "-movflags", "+faststart", str(segment)]
        command(args)
        segments.append(segment)
        scenes.append({"startSeconds": duration, "durationSeconds": scene["seconds"], "heading": scene["heading"], "kind": scene["kind"], "left": scene["left"], "right": scene["right"]})
        duration += scene["seconds"]
        print(f"{demo['id']}: scene {index + 1}/{len(demo['scenes'])}", flush=True)
    concat = folder / "concat.txt"
    concat.write_text("".join("file '" + str(file).replace("'", "'\\''") + "'\n" for file in segments))
    output = PUBLIC / f"{demo['id']}.mp4"
    command(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(output)])
    poster = PUBLIC / f"{demo['id']}-poster.jpg"
    command(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", "2", "-i", str(output), "-frames:v", "1", "-q:v", "2", str(poster)])
    # A short, inline GitHub preview accompanies the full MP4.
    preview = PUBLIC / f"{demo['id']}-preview.gif"
    command(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(demo.get("previewStart", sum(s["seconds"] for s in demo["scenes"][:2]))), "-t", "8", "-i", str(output), "-filter_complex", "fps=4,scale=768:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=80[p];[b][p]paletteuse=dither=bayer", "-loop", "0", str(preview)])
    actual = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height,codec_name", "-of", "json", str(output)]))
    if abs(float(actual["format"]["duration"]) - duration) > .2:
        raise AssertionError("Encoded duration does not match storyboard")
    captions = ["WEBVTT", ""]
    elapsed = 0
    for scene in demo["scenes"]:
        captions += [f"{timestamp(elapsed)} --> {timestamp(elapsed + scene['seconds'])}", scene["heading"], ""]
        elapsed += scene["seconds"]
    (PUBLIC / f"{demo['id']}.vtt").write_text("\n".join(captions))
    return {"id": demo["id"], "title": demo["title"], "base": demo["base"], "baseEvidence": demo["baseLabel"], "baseCapture": demo.get("baseCapture"), "captureContext": demo.get("captureContext"), "app": demo["app"], "apkSha256": demo["apkSha256"], "sourceSha256": sources, "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest(), "durationSeconds": duration, "encoding": actual, "scenes": scenes, "scope": demo["scope"]}


if __name__ == "__main__":
    PUBLIC.mkdir(parents=True, exist_ok=True)
    storyboard = json.loads((ROOT / "docs/demos/storyboard.json").read_text())
    manifest = {"formatVersion": 1, "renderer": "scripts/demos/render-comparisons.py", "videos": [render(demo) for demo in storyboard["demos"]]}
    (PUBLIC / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Published comparison videos and verified their durations.", flush=True)
