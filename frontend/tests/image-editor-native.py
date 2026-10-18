#!/usr/bin/env python3
"""Opt-in actual-device photo editing regression; requires Pillow and saved image fixtures."""
import importlib.util,pathlib,sys,time,json,re,subprocess,hashlib,shutil,traceback
from PIL import Image,ImageStat,ImageChops
class HarnessSelectorError(Exception):pass
import os,types,xml.etree.ElementTree as ET
ROOT=pathlib.Path(os.environ['MELD_NATIVE_QA_OUTPUT']);ROOT.mkdir(parents=True,exist_ok=True)
ADB=os.environ['MELD_ANDROID_ADB'];SERIAL=os.environ['MELD_ANDROID_SERIAL']
def adb(*args):return subprocess.check_output([ADB,'-s',SERIAL,*args],timeout=40)
def tree():
 adb('shell','uiautomator','dump','/data/local/tmp/image-editor-window.xml')
 return ET.fromstring(adb('exec-out','cat','/data/local/tmp/image-editor-window.xml'))
def labels():return [(x.get('text') or x.get('content-desc'),x.get('bounds'),x.get('enabled')) for x in tree().iter('node') if x.get('text') or x.get('content-desc')]
def tap(text):
 if text in ['Shape','Adjust','Filters','Blur','Text and stickers']:
  for _ in range(5):
   current=tree()
   if any(text in [x.get('text'),x.get('content-desc')] and x.get('enabled')=='true' for x in current.iter('node')):break
   strips=[x for x in current.iter('node') if x.get('scrollable')=='true' and len(re.findall(r'\d+',x.get('bounds','')))==4]
   strips=[list(map(int,re.findall(r'\d+',x.get('bounds')))) for x in strips]
   strips=[b for b in strips if b[3]-b[1]<200 and b[2]-b[0]>200]
   if not strips:break
   b=max(strips,key=lambda b:b[3]);adb('shell','input','swipe',str(b[2]-15),str((b[1]+b[3])//2),str(b[0]+15),str((b[1]+b[3])//2),'350')
 matches=[x for x in tree().iter('node') if text in [x.get('text'),x.get('content-desc')] and x.get('enabled')=='true']
 for node in matches:
  b=list(map(int,re.findall(r'\d+',node.get('bounds',''))))
  if len(b)==4 and b[2]>b[0] and b[3]>b[1]:
   adb('shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2));return
 raise HarnessSelectorError('Visible enabled control missing: '+text+' '+str(labels()))
def shot(name):
 (ROOT/(name+'.png')).write_bytes(adb('exec-out','screencap','-p'))
 try:(ROOT/(name+'.xml')).write_bytes(ET.tostring(tree()))
 except Exception:pass
n=types.SimpleNamespace(adb=adb,tree=tree,labels=labels,tap=tap,shot=shot,ADB=ADB,SERIAL=SERIAL)
fixture=pathlib.Path(os.environ.get('MELD_IMAGE_EDITOR_FIXTURES',str(pathlib.Path(__file__).resolve().parents[2]/'outputs/image-editor-base-run')))
for filename in ['test-original.jpg','test-camera-12mp.jpg']:
 if (fixture/filename).is_file():shutil.copy2(fixture/filename,ROOT/filename)
 else:
  from PIL import ImageDraw
  width,height=(800,600) if filename=='test-original.jpg' else (4000,3000)
  image=Image.new('RGB',(width,height));draw=ImageDraw.Draw(image)
  for x in range(width):draw.line((x,0,x,height),fill=(40+(x%80)*2,50+(x%50)*2,70+(x%60)*2))
  draw.rectangle((width//10,height//8,width//3,height//2),fill='#1763d5')
  draw.ellipse((width//2,height//3,width*4//5,height*4//5),fill='#e5af20')
  image.save(ROOT/filename,quality=95)


APK=pathlib.Path(sys.argv[1]);snapshot=ROOT/'qa-current.apk';shutil.copyfile(APK,snapshot);digest=hashlib.sha256(snapshot.read_bytes()).hexdigest()
PKG=sys.argv[2];cases=[]
if not re.fullmatch(r'com\.meld\.apps\.p[a-f0-9]+',PKG):raise SystemExit('Use an isolated generated app package.')
def select_photo(filename):
 # Query the isolated synthetic fixture rather than scrolling a growing Recent feed.
 if not re.fullmatch(r'image-editor-(?:original|camera-12mp)\.jpg',filename):raise HarnessSelectorError('Unexpected fixture name')
 def result(current):
  matches=[x for x in current.iter('node') if (x.get('content-desc') or '').startswith(filename+',') and len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>40 and bounds(x)[3]>130]
  if len(matches)>1:raise HarnessSelectorError('Ambiguous test photo: '+filename)
  return matches[0] if matches else None
 current=n.tree();node=result(current)
 if node is None:
  search=[x for x in current.iter('node') if x.get('content-desc')=='Search' and x.get('enabled')=='true']
  if search:
   b=bounds(search[0]);n.adb('shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2))
  for _ in range(6):
   fields=[x for x in n.tree().iter('node') if (x.get('resource-id') or '').endswith(':id/search_src_text') and x.get('enabled')=='true']
   if fields:break
   time.sleep(.2)
  if not fields:raise HarnessSelectorError('The document picker search field is unavailable')
  b=bounds(fields[0]);n.adb('shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2))
  n.adb('shell','input','keyevent','123');n.adb('shell','input','keyevent',*(['67']*80));n.adb('shell','input','text',filename);n.adb('shell','input','keyevent','66')
  for _ in range(10):
   node=result(n.tree())
   if node is not None:break
   time.sleep(.3)
 if node is None:raise HarnessSelectorError('Test photo was not found by document search: '+filename)
 b=bounds(node);n.adb('shell','input','tap',str(b[0]+15),str(b[3]-15))

def passed(name):
 cases.append({'case':name,'passed':True})
 (ROOT/'runtime-progress.json').write_text(json.dumps({'status':'running','apkSha256':digest,'packageId':PKG,'cases':cases},indent=2))
 print('PASS '+name,flush=True)
def bounds(node):return list(map(int,re.findall(r'\d+',node.get('bounds',''))))
def nodes(text):return [x for x in n.tree().iter('node') if text in [x.get('text'),x.get('content-desc')] and len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>=20]
aliases={'Back to editing':['Back to editing','Done'],'Rotate 90°':['Rotate 90°','Rotate'],'Star':['Star','star','star sticker'],'Square':['Square','Square crop']}
def scroll_to(text,field=False):
 for _ in range(20):
  tree=n.tree()
  # Autofocus can open the IME after the tap and before the first UI tree.
  if not field and 'mInputShown=true' in n.adb('shell','dumpsys','input_method').decode():
   n.adb('shell','input','keyevent','4');time.sleep(.4);continue
  densities=re.findall(r'(?:Physical|Override) density:\s*(\d+)',n.adb('shell','wm','density').decode());density=int(densities[-1]) if densities else 160
  window_bottom=max((bounds(x)[3] for x in tree.iter('node') if len(bounds(x))==4),default=960)
  tap_bottom=window_bottom-max(24,round(24*density/160))
  choices=aliases.get(text,[text,text.capitalize(),text.title()])
  found=[x for x in tree.iter('node') if (x.get('class')=='android.widget.EditText' and any(c.get('text')==text for c in x.iter('node'))) ] if field else [x for x in tree.iter('node') if any(value in choices or (text=='Rotate 90°' and (value or '').startswith('Rotate 90°')) for value in [x.get('text'),x.get('content-desc')])]
  if field and not found and text in ['Text','Caption']:
   editable=[x for x in tree.iter('node') if x.get('class')=='android.widget.EditText']
   if len(editable)==1:found=editable
  found=[x for x in found if len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>=25 and (bounds(x)[1]+bounds(x)[3])//2<tap_bottom]
  if found:return found[0]
  owners=[x for x in tree.iter('node') if x.get('package')==PKG and x.get('scrollable')=='true' and x.get('class')=='android.widget.ScrollView' and len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>40]
  if not owners:raise HarnessSelectorError('No app scroll container for '+text+' '+str(n.labels()))
  b=bounds(max(owners,key=lambda x:bounds(x)[3]-bounds(x)[1]))
  bottom=min(b[3],window_bottom-max(48,round(48*density/160)))
  if bottom-b[1]<40:raise HarnessSelectorError('App scroll viewport is too short for '+text)
  x=b[0]+min(36,(b[2]-b[0])//4);start=bottom-12;end=max(b[1]+12,int(start-min(240,(bottom-b[1])*.45)))
  n.adb('shell','input','swipe',str(x),str(start),str(x),str(end),'350')
 raise HarnessSelectorError('Action not reachable: '+text)
before_save=set()
def exported_paths():
 return {p for p in n.adb('shell','find','/sdcard/Pictures','/sdcard/Download','-type','f').decode().splitlines() if p.lower().endswith(('.jpg','.jpeg'))}
def click(text):
 global before_save
 node=scroll_to(text)
 choices=aliases.get(text,[text,text.capitalize(),text.title()])
 text=next(value for value in [node.get('text'),node.get('content-desc')] if value in choices or (text=='Rotate 90°' and (value or '').startswith('Rotate 90°')))
 if text=='Save copy':before_save=exported_paths()
 until=time.monotonic()+35
 while True:
  try:n.tap(text);return
  except HarnessSelectorError:
   if time.monotonic()>=until:raise
   time.sleep(.3)
def wait_label(test,timeout=20):
 until=time.time()+timeout
 while time.time()<until:
  ls=n.labels()
  if any(test(x[0] or '') for x in ls):return ls
  time.sleep(.4)
 raise Exception('Expected state missing: '+str(ls))
def mode_editor():
 until=time.monotonic()+40
 while time.monotonic()<until:
  current=n.labels()
  if any(x[0]=='Editor' for x in current) and not any(x[0]=='Apply' for x in current):return
  time.sleep(.3)
 raise Exception('Editor did not finish its pending tool: '+str(current))
def dimensions(w,h):
 # Dimensions need not be UI copy. Verify the actual exported JPEG when a
 # compact editor exposes only an image description instead of a size label.
 labels=n.labels()
 if any(f'{w} by {h} pixels' in (x[0] or '') for x in labels):return
 click('Save and share');click('Save copy');wait_label(lambda x:x.startswith('Saved'))
 exported=latest_export('geometry-'+str(time.time_ns())+'.jpg')
 assert Image.open(exported).size==(w,h),(Image.open(exported).size,(w,h))
 click('Back to editing');mode_editor()

def export_probe(name):
 click('Save and share');click('Save copy');wait_label(lambda x:x.startswith('Saved'))
 image=Image.open(latest_export(name)).convert('RGB').copy()
 click('Back to editing');mode_editor();return image

def assert_pixels_changed(before,after,label):
 assert before.size==after.size,label+' changed the image dimensions'
 difference=ImageChops.difference(before,after)
 assert sum(ImageStat.Stat(difference).mean)>0.3,label+' did not change actual exported pixels'

def field(label,value):
 node=scroll_to(label,True);b=bounds(node);n.adb('shell','input','tap',str((b[0]+b[2])//2),str(min((b[1]+b[3])//2,845)))
 n.adb('shell','input','keyevent','123');n.adb('shell','input','keyevent',*(['67']*20));n.adb('shell','input','text',value);n.adb('shell','input','keyevent','4')
def latest_export(name):
 paths=sorted(exported_paths()-before_save)
 if not paths:raise HarnessSelectorError('Save returned an existing destination; resolve its exact URI before checking pixels. '+str(n.labels()))
 assert len(paths)==1,'One Save copy action published multiple JPEGs: '+str(paths)
 target=ROOT/name;subprocess.run([n.ADB,'-s',n.SERIAL,'pull',paths[-1],str(target)],check=True,timeout=30,stdout=subprocess.DEVNULL);return target
def verify_large_blur():
 import statistics
 n.adb('push',str(ROOT/'test-camera-12mp.jpg'),'/sdcard/Download/image-editor-camera-12mp.jpg')
 n.adb('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Download/image-editor-camera-12mp.jpg')
 n.adb('shell','am','force-stop',PKG);n.adb('shell','am','start','-W','-f','0x10008000','-n',PKG+'/generated.MainActivity')
 wait_label(lambda x:x=='Choose photo');n.tap('Choose photo');time.sleep(1);select_photo('image-editor-camera-12mp.jpg');mode_editor();passed('12mp-import')
 n.tap('Blur');current=n.tree()
 paint=[x for x in current.iter('node') if 'paint' in (x.get('content-desc') or '').lower() and len(bounds(x))==4]
 if not paint:raise HarnessSelectorError('Accessible blur painting area missing: '+str(n.labels()))
 b=bounds(paint[0]);start=time.monotonic()
 n.adb('shell','input','swipe',str(int(b[0]+.35*(b[2]-b[0]))),str((b[1]+b[3])//2),str(int(b[0]+.65*(b[2]-b[0]))),str((b[1]+b[3])//2),'350')
 time.sleep(1);click('Apply');mode_editor();preview_ms=round((time.monotonic()-start)*1000)
 click('Save and share');start=time.monotonic();click('Save copy');wait_label(lambda x:x.startswith('Saved'),45);export_ms=round((time.monotonic()-start)*1000)
 exported=latest_export('verified-12mp-blur.jpg');image=Image.open(exported).convert('RGB');original=Image.open(ROOT/'test-camera-12mp.jpg').convert('RGB')
 assert image.size==(4000,3000),('12MP export dimensions',image.size)
 before=statistics.pstdev(original.getpixel((x,1500))[0] for x in range(1500,2400));after=statistics.pstdev(image.getpixel((x,1500))[0] for x in range(1500,2400))
 assert after<before*.9,('Painted blur did not soften exported pixels',before,after)
 assert export_ms<45000,('12MP blur export exceeded 45 seconds',export_ms)
 (ROOT/'native-blur-performance-report.json').write_text(json.dumps({'passed':True,'apkSha256':digest,'sourceDimensions':[4000,3000],'outputDimensions':list(image.size),'previewAndApplyMs':preview_ms,'exportMs':export_ms,'sourceRedContrast':before,'blurredRedContrast':after},indent=2))
 n.shot('android-12mp-blur');passed('12mp-painted-blur-export-under-45s')

try:
 n.adb('shell','am','force-stop',PKG);n.adb('install','-r',str(snapshot));n.adb('push',str(ROOT/'test-original.jpg'),'/sdcard/Download/image-editor-original.jpg');n.adb('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Download/image-editor-original.jpg');n.adb('shell','am','start','-W','-f','0x10008000','-n',PKG+'/generated.MainActivity');wait_label(lambda x:x=='Choose photo');passed('launch')
 # Run the largest image first so memory/performance regressions fail promptly.
 verify_large_blur()
 n.adb('shell','am','force-stop',PKG);n.adb('shell','am','start','-W','-f','0x10008000','-n',PKG+'/generated.MainActivity');wait_label(lambda x:x=='Choose photo')
 n.tap('Choose photo');time.sleep(1)
 select_photo('image-editor-original.jpg');mode_editor();dimensions(800,600);passed('import')
 n.tap('Shape');click('Rotate 90°');click('Apply');mode_editor();dimensions(600,800);passed('rotate')
 n.tap('Undo');dimensions(800,600);passed('undo');n.tap('Redo');dimensions(600,800);passed('redo')
 click('Save and share');click('Save copy');wait_label(lambda x:x.startswith('Saved'));rotated=latest_export('verified-rotated.jpg');assert Image.open(rotated).size==(600,800);passed('save-rotated-copy')
 click('Back to editing');mode_editor();n.tap('Undo');dimensions(800,600);n.tap('Shape')
 if any('Right crop edge' in (x[0] or '') for x in n.labels()):
  field('Right crop edge (px)','400');field('Bottom crop edge (px)','300');crop_size=(400,300)
 else:
  click('Square');crop_size=None
 click('Apply');mode_editor()
 if crop_size is None:
  cropped=export_probe('verified-square-crop.jpg');crop_size=cropped.size;assert crop_size[0]==crop_size[1] and 0<crop_size[0]<=600,('Square crop must export a square JPEG',crop_size)
 dimensions(*crop_size);passed('crop');before_adjust=export_probe('before-adjust.jpg')
 n.tap('Adjust');sliders=[x for x in n.tree().iter('node') if x.get('class')=='android.widget.SeekBar' and len(bounds(x))==4]
 assert sliders,'Adjustment sliders are not accessible'
 node=min(sliders,key=lambda x:bounds(x)[1]);b=bounds(node);n.adb('shell','input','tap',str(int(b[0]+.77*(b[2]-b[0]))),str((b[1]+b[3])//2));time.sleep(1);click('Apply');mode_editor();dimensions(*crop_size);after_adjust=export_probe('after-adjust.jpg');assert_pixels_changed(before_adjust,after_adjust,'Adjustment');passed('crop-then-adjust')
 before_filter=export_probe('before-filter.jpg');n.tap('Filters');click('warm');click('Apply');mode_editor();after_filter=export_probe('after-filter.jpg');assert_pixels_changed(before_filter,after_filter,'Filter');passed('filter-exported-pixels')
 n.tap('Undo');undone=export_probe('after-filter-undo.jpg');assert sum(ImageStat.Stat(ImageChops.difference(before_filter,undone)).mean)<1.0,'Undo did not restore actual pixels';passed('undo-restores-exported-pixels')
 before_text=export_probe('before-text.jpg');n.tap('Text and stickers');
 if any(x[0]=='Add text' for x in n.labels()):click('Add text')
 field('Text','Hello');click('Apply');mode_editor();after_text=export_probe('after-text.jpg');assert_pixels_changed(before_text,after_text,'Text');passed('text-overlay')
 n.tap('Text and stickers');click('Star');click('Apply');mode_editor();after_sticker=export_probe('after-sticker.jpg');assert_pixels_changed(after_text,after_sticker,'Sticker');passed('sticker-overlay');n.shot('android-edited-final')
 click('Save and share');click('Save copy');wait_label(lambda x:x.startswith('Saved'));final=latest_export('verified-edited.jpg');im=Image.open(final).convert('RGB');assert im.size==crop_size;assert_pixels_changed(before_adjust,im,'Combined edits');passed('export-edited-pixels-and-dimensions')
 assert hashlib.sha256(n.adb('exec-out','cat','/sdcard/Download/image-editor-original.jpg')).digest()==hashlib.sha256((ROOT/'test-original.jpg').read_bytes()).digest();passed('original-unchanged')
 click('Share');time.sleep(2);activity=n.adb('shell','dumpsys','activity','activities').decode();assert re.search(r'(?:mResumedActivity|topResumedActivity|ResumedActivity).*?(?:ChooserActivity|ResolverActivity|intentresolver)',activity) or any('Quick Share' in (x[0] or '') for x in n.labels()),n.labels();n.shot('android-share-final');passed('android-share-sheet')
 n.adb('shell','input','keyevent','4');click('Back to editing');mode_editor();n.shot('android-editor-final')
 spec=importlib.util.spec_from_file_location('image_editor_ui_checks',pathlib.Path(__file__).with_name('image-editor-ui-checks.py'))
 ui_checks=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui_checks);ui_checks.verify(globals())
 report={'passed':True,'apkSha256':digest,'packageId':PKG,'device':{'serial':n.SERIAL,'api':n.adb('shell','getprop','ro.build.version.sdk').decode().strip(),'abi':n.adb('shell','getprop','ro.product.cpu.abi').decode().strip(),'display':n.adb('shell','wm','size').decode().strip()},'cases':cases,'scope':'Actual APK import, geometry, pixel history, crop+color combination, filters, text/stickers, JPEG export pixels, 12MP painted blur performance, Android sharing, real keyboard/rotation, stable filter thumbnails, saved-share retry fault recovery and image-relative 12MP captions. No message was sent.'};(ROOT/'runtime-report.json').write_text(json.dumps(report,indent=2));(ROOT/'runtime-progress.json').write_text(json.dumps({'status':'passed','apkSha256':digest,'packageId':PKG,'cases':cases},indent=2));print('All native regression checks passed.',flush=True)
except Exception as error:
 (ROOT/'runtime-progress.json').write_text(json.dumps({'status':'failed','apkSha256':digest,'packageId':PKG,'cases':cases,'error':str(error)},indent=2))
 n.shot('android-regression-failure');(ROOT/'native-regression-failure.json').write_text(json.dumps({'passed':False,'apkSha256':digest,'cases':cases,'error':str(error)},indent=2));print(traceback.format_exc(),flush=True);sys.exit(1)
