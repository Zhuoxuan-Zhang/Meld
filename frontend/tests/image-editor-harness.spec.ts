import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pipelineRoot } from '../../pipeline/dist/src/integration.js';

test('native editor scrolling handles autofocus races, off-screen aliases and system navigation', () => {
  const pillow = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
  test.skip(pillow.status !== 0, 'The opt-in native image harness requires Python Pillow.');
  const source = path.join(pipelineRoot, '../frontend/tests/image-editor-native.py');
  const script = String.raw`
import pathlib,tempfile,os,sys,xml.etree.ElementTree as E,json
from PIL import Image
native=pathlib.Path(sys.argv[1]);package='com.meld.apps.p1234567890abcdef'
prefix=native.read_text().split("\ntry:\n n.adb('shell','am','force-stop',PKG)")
assert len(prefix)==2, 'Update the harness fixture after restructuring the CLI entry point'
with tempfile.TemporaryDirectory() as directory:
 p=pathlib.Path(directory);apk=p/'fixture.apk';apk.write_bytes(b'synthetic test APK')
 for name in ['test-original.jpg','test-camera-12mp.jpg']:Image.new('RGB',(2,2)).save(p/name)
 os.environ.update(MELD_NATIVE_QA_OUTPUT=str(p/'qa'),MELD_IMAGE_EDITOR_FIXTURES=str(p),MELD_ANDROID_ADB='/unused-fixture-adb',MELD_ANDROID_SERIAL='fixture')
 sys.argv=[str(native),str(apk),package];h={'__file__':str(native)};exec(compile(prefix[0],str(native),'exec'),h)
 state={'trees':0,'keyboard':False,'scrolls':0,'actions':[],'tapped':None}
 def tree():
  state['trees']+=1
  if state['trees']==1:state['keyboard']=True
  star=''
  if state['scrolls']:
   box='[146,928][188,960]' if state['scrolls']==1 else '[146,698][188,740]'
   star='<node text="" content-desc="star sticker" enabled="true" bounds="'+box+'"/>'
  return E.fromstring('<hierarchy><node package="'+package+'" bounds="[0,0][480,960]"><node class="android.widget.ScrollView" package="'+package+'" scrollable="true" bounds="[0,299][480,960]">'+star+'</node></node></hierarchy>')
 def adb(*args):
  if 'density' in args:return b'Physical density: 240'
  if 'keyevent' in args:state['keyboard']=False;state['actions'].append('hide-keyboard')
  if 'swipe' in args:
   assert not state['keyboard'], 'Scroll entered the keyboard'
   assert 299<int(args[4])<924, 'Scroll started in system navigation'
   state['scrolls']+=1;state['actions'].append('app-scroll')
  return b'mInputShown=true' if state['keyboard'] else b'mInputShown=false'
 h['n'].tree=tree;h['n'].adb=adb;h['n'].tap=lambda text:state.update(tapped=text)
 h['click']('Star')
 assert state['scrolls']==2, 'A navigation-obscured target was accepted as reachable'
 assert state['actions']==['hide-keyboard','app-scroll','app-scroll']
 assert state['tapped']=='star sticker'
 picker={'opened':False,'query':None,'picked':False}
 def picker_tree():
  if picker['query']:
   return E.fromstring('<hierarchy><node content-desc="image-editor-original.jpg, fixture" enabled="true" bounds="[20,140][150,260]"/></hierarchy>')
  if picker['opened']:
   return E.fromstring('<hierarchy><node class="android.widget.AutoCompleteTextView" resource-id="android:id/search_src_text" enabled="true" bounds="[50,36][420,108]"/></hierarchy>')
  return E.fromstring('<hierarchy><node content-desc="Search" enabled="true" bounds="[336,36][408,108]"/><node content-desc="unrelated export.jpg, fixture" bounds="[20,140][150,260]"/></hierarchy>')
 def picker_adb(*args):
  if 'text' in args:picker['query']=args[-1]
  if 'tap' in args:
   if not picker['opened']:picker['opened']=True
   elif picker['query']:
    assert args[-2:]==('35','245'), 'Select the result outside its preview icon'
    picker['picked']=True
  return b''
 h['n'].tree=picker_tree;h['n'].adb=picker_adb;h['time'].sleep=lambda _:None
 h['select_photo']('image-editor-original.jpg')
 assert picker['picked'] and picker['query']=='image-editor-original.jpg'
 state['pickerSearch']=picker
 print(json.dumps(state))
`;
  const result = spawnSync('python3', ['-c', script, source], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).tapped).toBe('star sticker');
  expect(JSON.parse(result.stdout).pickerSearch.picked).toBe(true);
});


test('keyboard hit testing translates window-local IME insets to screen coordinates', () => {
  test.skip(spawnSync('python3', ['-c', 'import PIL']).status !== 0, 'The opt-in native image harness requires Python Pillow.');
  const result = spawnSync('python3', ['-c', String.raw`
import importlib.util,sys
spec=importlib.util.spec_from_file_location('checks',sys.argv[1]);checks=importlib.util.module_from_spec(spec);spec.loader.exec_module(checks)
for frame,inset,expected in [(36,571,607),(0,200,200),(24,300,324)]:
 dump=f"  Window #5 Window{{123 u0 InputMethod}}:\n    mGivenContentInsets=[0,{inset}][0,0]\n    Frames: parent=[0,{frame}][480,960] frame=[0,{frame}][480,960]\n  Window #6 Window{{456 u0 app}}:"
 assert checks.keyboard_content_top(dump)==expected
assert checks.system_content_bottom('InsetsSource type=ITYPE_STATUS_BAR frame=[0,0][960,36] visible=true',960,480)==480
assert checks.system_content_bottom('InsetsSource type=ITYPE_NAVIGATION_BAR frame=[0,924][480,960] visible=true',480,960)==924
assert checks.system_content_bottom('InsetsSource type=ITYPE_NAVIGATION_BAR frame=[924,0][960,480] visible=true',960,480)==480
assert checks.system_content_bottom('InsetsSource type=ITYPE_NAVIGATION_BAR frame=[0,444][960,480] visible=false',960,480)==480
assert checks.system_content_bottom('unknown display format',960,480) is None
try:checks.keyboard_content_top('No keyboard frame')
except RuntimeError:pass
else:raise AssertionError('Unknown IME layout must not invent a coordinate')
`, path.join(pipelineRoot, '../frontend/tests/image-editor-ui-checks.py')], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
