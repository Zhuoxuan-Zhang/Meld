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
 print(json.dumps(state))
`;
  const result = spawnSync('python3', ['-c', script, source], { encoding: 'utf8', timeout: 15000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).tapped).toBe('star sticker');
});
