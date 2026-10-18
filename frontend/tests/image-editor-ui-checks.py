"""Actual-device UI regressions run after the ordinary image-editor cases.

The caller supplies the exact APK-bound native harness namespace. These checks
never submit a share; the cache-permission fault is scoped and restored.
"""
import time,re,json
from PIL import Image,ImageChops,ImageStat


def keyboard_content_top(windows):
  """IME content insets are window-local; expose their absolute screen Y."""
  for block in re.split(r'(?=  Window #\d+)', windows):
    if not re.search(r'^  Window #\d+.* InputMethod', block):continue
    frame=re.search(r'Frames:.*? frame=\[(-?\d+),(-?\d+)\]',block)
    inset=re.search(r'mGivenContentInsets=\[-?\d+,(-?\d+)\]',block)
    if frame and inset:return int(frame[2])+int(inset[1])
  raise RuntimeError('Visible keyboard frame/insets unavailable')

def verify(h):
  n=h['n'];bounds=h['bounds'];pkg=h['PKG'];folder=h['ROOT'];digest=h['digest']
  cases=[];issues=[];metrics={}
  def record(name):
    cases.append(name);h['passed'](name)
  def texts():return [x[0] for x in n.labels()]
  def snap(name):n.shot(name)
  def tap_node(node):
   b=bounds(node);n.adb('shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2))
  def fresh(filename='image-editor-original.jpg'):
   n.adb('shell','am','force-stop',pkg);n.adb('shell','am','start','-W','-f','0x10008000','-n',pkg+'/generated.MainActivity');h['wait_label'](lambda x:x=='Choose photo');n.tap('Choose photo');time.sleep(1);h['select_photo'](filename);h['mode_editor']()
  def safe_bottom(current,tap=False):
   values=re.findall(r'(?:Physical|Override) density:\s*(\d+)',n.adb('shell','wm','density').decode());density=int(values[-1]) if values else 160
   bottom=max((bounds(x)[3] for x in current.iter('node') if len(bounds(x))==4),default=960)-round((24 if tap else 48)*density/160)
   ime=n.adb('shell','dumpsys','input_method').decode()
   if 'mInputShown=true' in ime:
    bottom=min(bottom,keyboard_content_top(n.adb('shell','dumpsys','window','windows').decode()))
   return bottom
  def choose_tool(name):
   for _ in range(16):
    current=n.tree()
    controls=[x for x in current.iter('node') if name in [x.get('text'),x.get('content-desc')] and x.get('enabled')=='true' and len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>=20 and (bounds(x)[1]+bounds(x)[3])//2<safe_bottom(current,True)]
    if controls:tap_node(controls[0]);return
    owners=[x for x in current.iter('node') if x.get('scrollable')=='true' and x.get('package')==pkg and len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>30]
    if not owners:raise RuntimeError('No scroll owner for '+name)
    b=bounds(max(owners,key=lambda x:bounds(x)[3]-bounds(x)[1]))
    if b[2]-b[0]>2*(b[3]-b[1]) and b[3]-b[1]<200:
     n.adb('shell','input','swipe',str(b[2]-10),str((b[1]+b[3])//2),str(b[0]+10),str((b[1]+b[3])//2),'350')
    else:
     bottom=min(b[3],safe_bottom(current));start=bottom-12;end=max(b[1]+12,int(start-min(240,(bottom-b[1])*.45)));n.adb('shell','input','swipe',str(b[0]+36),str(start),str(b[0]+36),str(end),'350')
   raise RuntimeError('Tool not reachable: '+name)
  def edit_text(value):
   for _ in range(10):
    found=[x for x in n.tree().iter('node') if x.get('class')=='android.widget.EditText' and len(bounds(x))==4 and bounds(x)[3]>bounds(x)[1]]
    if found:tap_node(found[0]);n.adb('shell','input','text',value);time.sleep(.5);return
    scroll_controls()
   raise RuntimeError('Caption input not reachable: '+str(n.labels()))
  def scroll_controls(current=None,bottom_limit=None):
   current=current if current is not None else n.tree();candidates=[x for x in current.iter('node') if x.get('scrollable')=='true' and x.get('package')==pkg and x.get('class')=='android.widget.ScrollView' and len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>40]
   if not candidates:raise RuntimeError('No editor scroll owner: '+str(n.labels()))
   b=bounds(max(candidates,key=lambda x:bounds(x)[3]-bounds(x)[1]));bottom=min(b[3],safe_bottom(current) if bottom_limit is None else bottom_limit);start=bottom-12;end=max(b[1]+12,int(start-min(240,(bottom-b[1])*.45)))
   if start<=end:raise RuntimeError('Keyboard leaves no usable scroll viewport')
   n.adb('shell','input','swipe',str(b[0]+36),str(start),str(b[0]+36),str(end),'350')
  def apply_with_keyboard(name):
   assert 'mInputShown=true' in n.adb('shell','dumpsys','input_method').decode(),'Real soft keyboard is not shown'
   for _ in range(30):
    current=n.tree();limit=safe_bottom(current,True)
    controls=[x for x in current.iter('node') if bounds(x) and bounds(x)[3]<limit and x.get('text')=='Apply' and x.get('enabled')=='true' and len(bounds(x))==4 and bounds(x)[3]-bounds(x)[1]>=30]
    if controls:
     snap(name);tap_node(controls[0]);h['mode_editor']();return
    scroll_controls(current,limit)
   raise RuntimeError('Apply could not be reached while the keyboard stayed open')
  def set_rotation(value):
   n.adb('shell','settings','put','system','accelerometer_rotation','0');n.adb('shell','settings','put','system','user_rotation',str(value));time.sleep(2)
  def check_keyboard():
   old_acc=n.adb('shell','settings','get','system','accelerometer_rotation').decode().strip();old_rotation=n.adb('shell','settings','get','system','user_rotation').decode().strip()
   try:
    set_rotation(0);fresh();choose_tool('Text and stickers');edit_text('Portrait');apply_with_keyboard('portrait-keyboard-apply');record('portrait-keyboard-input-and-apply')
    set_rotation(1);assert 'Editor' in texts(),'Rotation lost the editor session';choose_tool('Text and stickers');edit_text('Landscape');apply_with_keyboard('landscape-keyboard-apply');record('landscape-keyboard-input-and-apply')
    choose_tool('Text and stickers');edit_text('RotationDraft');set_rotation(0)
    assert any('RotationDraft' in (x.get('text') or '') for x in n.tree().iter('node')),'Rotation lost the caption draft'
    tap_node(next(x for x in n.tree().iter('node') if x.get('class')=='android.widget.EditText' and 'RotationDraft' in (x.get('text') or '')));apply_with_keyboard('rotated-draft-keyboard-apply');record('rotation-retains-draft-and-editor');snap('portrait-after-keyboard-tests')
   finally:
    for key,value in [('user_rotation',old_rotation),('accelerometer_rotation',old_acc)]:
     if value=='null':n.adb('shell','settings','delete','system',key)
     elif re.fullmatch('[0-3]',value):n.adb('shell','settings','put','system',key,value)
    time.sleep(1)
  def none_thumbnail(name):
   node=next(x for x in n.tree().iter('node') if x.get('content-desc')=='none filter');b=bounds(node);snap(name)
   return Image.open(folder/(name+'.png')).convert('RGB').crop((b[0]+8,b[1]+8,b[2]-8,b[3]-8))
  def check_thumbnails():
   fresh();choose_tool('Filters');before=none_thumbnail('filters-before-selection');h['click']('warm');time.sleep(2);after=none_thumbnail('filters-after-warm')
   assert before.size==after.size,'Thumbnail changed layout during the check'
   delta=sum(ImageStat.Stat(ImageChops.difference(before,after)).mean);metrics['noneThumbnailChangeAfterWarm']=delta
   if delta>1.0:issues.append({'case':'filter-thumbnail-base','error':'None thumbnail changes when Warm is pending; presets are rendered from the pending filtered preview.','meanRgbDifference':delta})
   else:record('filter-thumbnails-use-committed-base')
  def is_share_sheet():
   activity=n.adb('shell','dumpsys','activity','activities').decode()
   return bool(re.search(r'(?:mResumedActivity|topResumedActivity|ResumedActivity).*?(?:ChooserActivity|ResolverActivity|intentresolver)',activity))
  def check_share_retry():
   fresh();n.tap('Save and share');h['click']('Save copy');h['wait_label'](lambda x:x.startswith('Saved'));before=h['exported_paths']();old=n.adb('shell','run-as',pkg,'stat','-c','%a','cache/shared_images').decode().strip()
   assert re.fullmatch('[0-7]{3,4}',old),old
   try:
    n.adb('shell','run-as',pkg,'chmod','500','cache/shared_images');h['click']('Share');h['wait_label'](lambda x:x=='Retry');snap('saved-sharing-preparation-failure')
   finally:n.adb('shell','run-as',pkg,'chmod',old,'cache/shared_images')
   h['click']('Retry');time.sleep(1)
   until=time.monotonic()+12
   while time.monotonic()<until and not is_share_sheet():time.sleep(.3)
   snap('saved-sharing-after-retry');opened=is_share_sheet();metrics['shareRetryOpenedSharesheet']=opened
   assert h['exported_paths']()==before,'Share retry created another permanent image'
   if opened:record('saved-sharing-retry-opens-sharesheet-without-duplicate');n.adb('shell','input','keyevent','4')
   else:issues.append({'case':'saved-sharing-retry','error':'After restoring the sharing cache permission, Retry returns to saved success without opening the Sharesheet.'})

  def check_large_caption():
   fresh('image-editor-camera-12mp.jpg');before=h['export_probe']('large-before-caption.jpg',timeout=45)
   choose_tool('Text and stickers');h['field']('Text','Readable');h['click']('Apply');h['mode_editor']();after=h['export_probe']('large-after-caption.jpg',timeout=45)
   assert before.size==after.size==(4000,3000),('High-resolution caption changed dimensions',before.size,after.size)
   mask=ImageChops.difference(before,after).convert('L').point(lambda value:255 if value>35 else 0)
   box=mask.getbbox();metrics['largeCaptionInkBounds']=box
   assert box and box[3]-box[1]>=min(after.size)*.03,('Initial caption is too small on a 12MP photo',box)
   snap('large-caption-readable');record('12mp-initial-caption-is-image-relative')

  groups=[('keyboard-and-rotation',check_keyboard),('filter-thumbnails',check_thumbnails),('saved-sharing-retry',check_share_retry),('large-caption',check_large_caption)]
  for name,check in groups:
    try:
      check()
      assert not issues,json.dumps(issues)
    finally:
      (folder/'ui-regression-metrics.json').write_text(json.dumps({'apkSha256':digest,'group':name,'cases':cases,'issues':issues,'metrics':metrics},indent=2))
