#!/usr/bin/env python3
"""Opt-in emulator regression for the three-game generated app. Clears its test data."""
import subprocess,xml.etree.ElementTree as ET,re,time,pathlib,json,sqlite3,os,sys,shutil
ADB=os.environ.get("MELD_ANDROID_ADB") or shutil.which("adb")
if not ADB: raise SystemExit("Set MELD_ANDROID_ADB to your SDK platform-tools/adb.")
SERIAL=os.environ.get("MELD_ANDROID_SERIAL", "emulator-5580")
OUT=pathlib.Path(os.environ.get("MELD_NATIVE_QA_OUTPUT", str(pathlib.Path(__file__).resolve().parent.parent/"qa-screenshots/puzzle-harbor")))
OUT.mkdir(parents=True,exist_ok=True)
if len(sys.argv)!=3: raise SystemExit("Usage: puzzle-native-smoke.py APK GENERATED_PACKAGE_ID (clears that app’s test data)")
PKG=sys.argv[2]
if not re.fullmatch(r"com\.meld\.apps\.p[a-f0-9]+",PKG): raise SystemExit("Use an isolated Meld-generated test app package.")
def adb(*args,binary=False):
    r=subprocess.run([ADB,"-s",SERIAL,*args],capture_output=True,check=True)
    return r.stdout if binary else r.stdout.decode()
def nodes():
    adb("shell","uiautomator","dump","/data/local/tmp/puzzle-window.xml")
    return list(ET.fromstring(adb("shell","cat","/data/local/tmp/puzzle-window.xml")).iter("node"))
def labels(): return [(n.get("text"),n.get("content-desc"),n.get("enabled"),n.get("bounds")) for n in nodes() if n.get("text") or n.get("content-desc")]
def click(label,description=False,occurrence=0,scroll=True):
    for attempt in range(7):
        matches=[n for n in nodes() if n.get("content-desc" if description else "text")==label and n.get("enabled")=="true"]
        if len(matches)>occurrence:
            b=list(map(int,re.findall(r"\d+",matches[occurrence].get("bounds"))))
            if b[2]>b[0] and b[3]>b[1]:
                adb("shell","input","tap",str((b[0]+b[2])//2),str((b[1]+b[3])//2));time.sleep(.7);return
        if not scroll: break
        adb("shell","input","swipe","550","1700","550","750","450");time.sleep(.5)
    raise AssertionError("Enabled control not found: "+label+"; "+str(labels()))
def screen(name):
    (OUT/(name+".png")).write_bytes(adb("exec-out","screencap","-p",binary=True))
    (OUT/(name+".xml")).write_text(adb("shell","cat","/data/local/tmp/puzzle-window.xml"))
def restart():
    adb("shell","am","force-stop",PKG);adb("shell","am","start","-n",PKG+"/generated.MainActivity");time.sleep(2)
def data(name):
    # Snapshot base and WAL while the UI is idle. Work only on local copies.
    target=OUT/(name+"-db")
    if target.exists(): shutil.rmtree(target)
    target.mkdir()
    names=adb("shell","run-as",PKG,"ls","databases").splitlines()
    for filename in names:
        if filename.endswith("-shm"):continue
        (target/filename).write_bytes(adb("exec-out","run-as",PKG,"cat","databases/"+filename,binary=True))
    base=next(f for f in target.iterdir() if not f.name.endswith(("-wal","-shm","-journal")))
    db=sqlite3.connect(base)
    games={mode:json.loads(payload) for mode,payload in db.execute("select mode,payload from active_games")}
    db.close();return games

import runpy,pathlib,json,hashlib,sys,time
h={name:globals()[name] for name in ["click","data","adb","PKG","OUT","nodes","labels","screen","restart"]}
c,d,adb=h["click"],h["data"],h["adb"]
checks=[]
def passed(label):
 checks.append({"case":label,"passed":True});print(label+": passed",flush=True)
def select(idx):
 prefix=f"Row {idx//9+1}, column {idx%9+1}, "
 label=next(n.get("content-desc") for n in h["nodes"]() if n.get("content-desc","").startswith(prefix))
 c(label,description=True)
def cursor_to(idx):
 label=next(x[0] for x in h["labels"]() if x[0].startswith("Selected: row "))
 row,col=map(int,re.findall(r"\d+",label));current=(row-1)*9+col-1
 for _ in range(abs(idx-current)): c("Next" if idx>current else "Previous")
apk=pathlib.Path(sys.argv[1]).resolve()
(h["OUT"]/"runtime-report.json").write_text(json.dumps({"passed":False,"status":"running","apkSha256":hashlib.sha256(apk.read_bytes()).hexdigest()}))
def failure_report(kind, error, traceback):
 (h["OUT"]/"runtime-report.json").write_text(json.dumps({"passed":False,"status":"failed","apkSha256":hashlib.sha256(apk.read_bytes()).hexdigest(),"packageId":h["PKG"],"cases":checks,"error":str(error)},indent=2))
 sys.__excepthook__(kind,error,traceback)
sys.excepthook=failure_report
adb("install","-r",str(apk));adb("shell","pm","clear",h["PKG"]);h["restart"]();h["labels"]();h["screen"]("final-native-games")
c("New 2048 game",description=True);c("Resume");a=d("final-2048-before")["GAME_2048"]
for direction in ["Up","Left","Down","Right"]:
 c(direction);b=d("final-2048-"+direction)["GAME_2048"]
 if b["engineState"]["cells"]!=a["engineState"]["cells"]:break
assert a["engineState"]["cells"]!=b["engineState"]["cells"]
c("Undo");u=d("final-2048-undone")["GAME_2048"];assert u["engineState"]==a["engineState"] and u["rngState"]==a["rngState"]
c("Left");c("Down");h["labels"]();h["screen"]("final-native-2048");c("Pause");saved=d("final-2048-paused")["GAME_2048"];h["restart"]();res=d("final-2048-relaunch")["GAME_2048"];assert res["engineState"]==saved["engineState"] and res["gameId"]==saved["gameId"]
passed("2048 movement, exact undo and pause/force-stop recovery")
c("New Minesweeper game",description=True);c("Resume");c("Reveal selected cell");s=d("final-mines-first")["MINESWEEPER"]["engineState"];assert s["firstRevealCell"]==0 and 0 not in s["mineCells"] and len(set(s["mineCells"]))==10 and 0 in s["revealedCells"]
idx=next(i for i in range(81) if i not in s["revealedCells"] and i%9<7);cursor_to(idx);c("Flag");c("Toggle flag on selected cell");f=d("final-mines-flagged")["MINESWEEPER"];assert idx in f["engineState"]["flaggedCells"];h["labels"]();h["screen"]("final-native-minesweeper");c("Pause");saved=d("final-mines-paused")["MINESWEEPER"];h["restart"]();res=d("final-mines-relaunch")["MINESWEEPER"];assert res["engineState"]==saved["engineState"] and res["gameId"]==saved["gameId"]
passed("Minesweeper safe first reveal, ten mines, flag and durable recovery")
c("New Sudoku game",description=True);c("Resume");a=d("final-sudoku-before")["SUDOKU"];e=a["engineState"]
clue=next(i for i,v in enumerate(e["givens"]) if v and i%9<5);select(clue);c("Enter 1",description=True);b=d("final-sudoku-clue")["SUDOKU"];assert a["engineState"]==b["engineState"]
idx=next(i for i,v in enumerate(e["givens"]) if v==0 and i%9<5);select(idx);c("Pencil marks");c("Toggle pencil mark 3",description=True);s=d("final-sudoku-noted")["SUDOKU"];assert 3 in s["engineState"]["notes"][idx] and s["engineState"]["values"][idx]==0
c("Pencil marks");c("Enter 4",description=True);v=d("final-sudoku-entered")["SUDOKU"];assert v["engineState"]["values"][idx]==4 and v["engineState"]["notes"][idx]==[];c("Undo");u=d("final-sudoku-undone")["SUDOKU"];assert u["engineState"]["values"][idx]==0 and 3 in u["engineState"]["notes"][idx];h["labels"]();h["screen"]("final-native-sudoku");c("Pause");saved=d("final-sudoku-paused");h["restart"]();res=d("final-sudoku-relaunch");assert res["SUDOKU"]["engineState"]==saved["SUDOKU"]["engineState"] and len(res)==3
passed("Sudoku givens, manual pencil marks, entry/undo and three independent saves")
c("New 2048 game",description=True);c("Cancel");b=d("final-replacement-cancel");assert b["GAME_2048"]==res["GAME_2048"]
passed("Replacement cancellation preserves committed progress")
c("Statistics");assert any(x[0]=="No completed games yet." for x in h["labels"]());c("Settings");c("Dark");h["labels"]();h["screen"]("final-native-settings-dark");h["restart"]();c("Settings");h["labels"]();h["screen"]("final-native-settings-dark-relaunch")
# Verify actual persisted preference using the copied app database.
d("final-dark-preference");import sqlite3
root=h["OUT"]/"final-dark-preference-db";db=sqlite3.connect(next(p for p in root.iterdir() if not p.name.endswith(("-wal","-shm"))));row=db.execute("select theme from preferences").fetchone();assert row[0]=="DARK";db.close();c("Light");c("Games")
passed("Navigation, empty statistics and durable theme")
c("Resume Minesweeper",description=True);c("Resume");c("Reveal");state=d("final-mines-before-loss")["MINESWEEPER"]["engineState"];idx=next(i for i in state["mineCells"] if i not in state["flaggedCells"] and i%9<7);cursor_to(idx);c("Reveal selected cell");lost=d("final-mines-loss")["MINESWEEPER"];assert lost["engineState"]["phase"]=="LOST";c("Games");c("Statistics");screen_labels=h["labels"]();assert any(x[0]=="Completed 1" for x in screen_labels) and any(x[0]=="Losses 1" for x in screen_labels);h["screen"]("final-native-statistics");h["restart"]();c("Statistics");assert any(x[0]=="Completed 1" for x in h["labels"]());c("Games")
passed("Controlled loss, exactly-once outcome statistics and force-stop recovery")
report={"passed":True,"apkSha256":hashlib.sha256(apk.read_bytes()).hexdigest(),"packageId":h["PKG"],"device":{"serial":SERIAL,"api":adb("shell","getprop","ro.build.version.sdk").strip(),"abi":adb("shell","getprop","ro.product.cpu.abi").strip(),"display":adb("shell","wm","size").strip()},"cases":checks,"scope":"Real UI interactions and app database snapshots on one Android emulator. Does not establish original reference APK runtime behavior, every Android version, or all failure paths. Integrity/storage-error scenarios also covered separately by generated JUnit tests."}
(h["OUT"]/"runtime-report.json").write_text(json.dumps(report,indent=2));print(json.dumps({"passed":True,"cases":len(checks),"sha256":report["apkSha256"]}),flush=True)
