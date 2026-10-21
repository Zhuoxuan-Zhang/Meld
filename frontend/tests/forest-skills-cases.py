"""UI acceptance helpers for the five-reference Focus Grove example.

Only UI input changes app state. Snapshots are read-only evidence, not fixtures.
"""
import re
import time


def visible(d, *labels):
    wanted = {s.casefold() for s in labels}
    return [n for n in d.nodes() if n.get('enabled') == 'true'
            and n.get('bounds') != '[0,0][0,0]'
            and ((n.get('text') or '').casefold() in wanted
                 or (n.get('content-desc') or '').casefold() in wanted)]


def tap_visible(d, *labels):
    d.tap(list(labels), scroll=False)


def slider(d, fraction, label=None):
    nodes = d.nodes()
    candidates = [n for n in nodes if n.get('class') == 'android.widget.SeekBar'
                  and n.get('enabled') == 'true' and n.get('bounds') != '[0,0][0,0]']
    if label:
        candidates = [n for n in candidates if label.casefold() in (n.get('content-desc') or '').casefold()]
    assert candidates, 'Expected an accessible slider'
    x1,y1,x2,y2 = map(int,re.findall(r'\d+',candidates[0].get('bounds')))
    # Stay on the material slider track, inside its touch target.
    # This recorded 480px emulator uses Material3 semantic bounds extending
    # 15px beyond the actual track. An endpoint must be inside that track.
    inset = min(16 if fraction in (0, 1) else 24,(x2-x1)//10)
    x = round(x1+inset+(x2-x1-2*inset)*fraction)
    d.adb('shell','input','tap',x,(y1+y2)//2)
    time.sleep(.3)


def records(d, label):
    tables = d.database(label)
    def table(name):
        matches = [rows for key, rows in tables.items() if key.lower().replace('_', '') in (name, name+'entity')]
        assert len(matches) == 1, 'Expected durable table ' + name + '; found ' + repr(list(tables))
        return matches[0]
    return table('tasks'), table('sessions'), table('trees'), tables


def session(d, label, session_id=None):
    _, sessions, _, _ = records(d, label)
    if session_id:
        return next(row for row in sessions if row['id'] == session_id)
    assert sessions, 'A planted session must be persisted'
    return max(sessions, key=lambda row: row['startedAt'])


def assert_running(d, label, original):
    _, sessions, trees, _ = records(d, label)
    running = [s for s in sessions if s['status'].upper() == 'RUNNING']
    assert len(running) == 1 and running[0]['id'] == original['id'], 'Restore the same single active session'
    assert running[0]['startedAt'] == original['startedAt'], 'Recovery must preserve its deadline'
    assert not any(t['sessionId'] == original['id'] for t in trees), 'A running session has no earned tree'
    return running[0]


def wait_for_completion(d, original, before_resume=None):
    deadline = original['startedAt']/1000 + original['durationMinutes']*60
    # Compare against the emulator clock without changing it; these are real
    # elapsed minutes. Polling/launching reconciles a background completion.
    while True:
        left = deadline + 2 - float(d.adb('shell','date','+%s').strip())
        if left <= 0:
            break
        time.sleep(min(8,left))
    if before_resume:
        before_resume()
    d.launch()
    row = session(d, 'completed', original['id'])
    assert row['status'].upper() == 'COMPLETED', 'An elapsed live deadline must complete'
    return row


def app_playing(d, pid, label):
    audio = d.adb('shell','dumpsys','audio')
    (d.out/(label+'.txt')).write_text(audio)
    return any(re.search(r'[/ ]'+re.escape(pid)+r'\b', line)
               and 'state:started' in line and 'AudioPlaybackConfiguration' in line
               for line in audio.splitlines())


def wait_for_playback(d, pid, expected, label):
    deadline = time.monotonic() + 8
    while True:
        actual = app_playing(d, pid, label)
        if actual == expected:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(.3)


def run_cases(d):
    deadline = time.monotonic() + 30
    while 'Focus Grove' not in d.texts() and time.monotonic() < deadline:
        time.sleep(.5)
    assert 'Focus Grove' in d.texts(), 'The installed app must finish loading its real home screen'
    findings = []
    tasks, sessions, trees, _ = records(d, 'initial')
    assert not tasks and not sessions and not trees, 'A fresh install must not show fabricated history'
    d.screenshot('home-empty')
    d.tap('Your Forest')
    assert 'No trees yet' in d.texts()
    d.screenshot('forest-empty')
    d.tap(['Close forest', 'Close'])
    d.passed('Fresh install, empty forest and working base-style navigation')

    d.edit('Biology', label='Quick add', upward=False)
    d.tap('Add task')
    tasks, sessions, trees, _ = records(d, 'task-created')
    biology = next(t for t in tasks if t['name'] == 'Biology')
    assert biology['isActive'] and not biology['isCompleted']
    for _ in range(3):
        d.scroll(upward=True)
    d.screenshot('home-ready')
    # Measure the clickable control, not its smaller text-only child.
    plant = [n for n in d.nodes() if n.get('clickable') == 'true'
             and n.get('enabled') == 'true' and n.get('bounds') != '[0,0][0,0]'
             and any(child.get('text') == 'Plant' for child in n.iter('node'))]
    if not plant or int(re.findall(r'\d+', plant[-1].get('bounds'))[3]) - int(re.findall(r'\d+', plant[-1].get('bounds'))[1]) < 60:
        findings.append('On the default 480x960 portrait phone, Home hides Plant below the initial viewport after a task is selected. Keep the prominent tree, chosen task, duration and a fully visible Plant action usable without an initial scroll. Reduce auxiliary form density (for example collapse quick-add after a task exists), preserve its access, and reduce redundant vertical gaps rather than shrinking the tree to an icon.')
    d.restart()
    tasks, _, _, _ = records(d, 'task-restarted')
    assert next(t for t in tasks if t['id'] == biology['id'])['isActive']
    d.passed('Real study task creation, active selection and cold-restart persistence')

    if findings:
        # Fail a known primary-layout defect with a focused real completion
        # preflight before spending time on the full feature suite. The repaired
        # APK must still pass every case below from a fresh install.
        d.seek('Session duration')
        slider(d, 0, 'Session duration')
        d.seek('Duration: 1 min', scroll=False)
        d.tap('Plant')
        preflight = session(d, 'ui-preflight-start')
        wait_for_completion(d, preflight)
        if 'Tree collected!' not in d.texts():
            findings.append('Natural completion returns Home at a restored scroll position that hides its result. Reveal the retained result immediately.')
            for _ in range(3): d.scroll(upward=True)
        d.screenshot('ui-preflight-completed')
        if '100 percent grown' not in d.texts():
            findings.append('After a real one-minute completion, Home still renders its fixed 12-percent seedling. Bind central artwork to the retained completed result at 100 percent until Continue, preserve it across rotation/restart, and keep a clearly withered abandonment result.')
        raise AssertionError('UI design acceptance failed: ' + ' '.join(findings))

    run_task_and_goal_cases(d, biology)
    d.adb('shell','input','keyevent','KEYCODE_BACK')
    for _ in range(3):
        d.scroll(upward=True)
    d.seek('Session duration')
    slider(d, .12, 'Session duration')
    d.tap('Plant')
    first = session(d, 'started')
    assert first['taskId'] == biology['id'] and first['durationMinutes'] > 1
    assert_running(d, 'single-start', first)
    d.screenshot('session-growing')
    initial_frame = (d.out/'session-growing.png').read_bytes()
    time.sleep(3)
    d.screenshot('session-growing-later')
    assert (d.out/'session-growing-later.png').read_bytes() != initial_frame, 'The visible growing/countdown frame must advance'
    d.passed('Plant creates one real durable session and a live countdown')

    d.tap('Focus sounds')
    d.tap('Rain')
    time.sleep(1)
    pid = d.adb('shell','pidof',d.package).strip().split()[0]
    assert wait_for_playback(d, pid, True, 'audio-playing'), 'Rain must start a real app-owned Android audio player'
    d.seek('Sound volume')
    slider(d, .7, 'Sound volume')
    d.tap('Pause')
    assert wait_for_playback(d, pid, False, 'audio-paused'), 'Pause must stop active playback'
    d.tap('Play')
    d.tap('Stop')
    assert_running(d, 'sound-independent-timer', first)
    d.passed('Actual app-owned rain audio playback, volume, pause, resume and stop')

    d.rotate(1)
    d.screenshot('session-landscape')
    assert_running(d, 'rotation', first)
    d.rotate(0)
    d.adb('shell','input','keyevent','KEYCODE_BACK')
    assert_running(d, 'system-back', first)
    d.adb('shell','input','keyevent','KEYCODE_HOME')
    time.sleep(3)
    d.launch()
    assert_running(d, 'background-restored', first)
    d.adb('shell','input','keyevent','KEYCODE_SLEEP')
    time.sleep(2)
    d.adb('shell','input','keyevent','KEYCODE_WAKEUP')
    d.adb('shell','wm','dismiss-keyguard')
    d.launch()
    assert_running(d, 'screen-lock-restored', first)
    d.restart()
    assert_running(d, 'process-restart-restored', first)
    d.screenshot('session-restored')
    d.passed('Same single session survives rotation, Back, background, lock and process restart')

    d.tap('Give Up')
    d.tap('Keep focusing')
    assert_running(d, 'give-up-cancelled', first)
    d.tap('Give Up')
    d.tap('Give Up', scroll=False)
    abandoned = session(d, 'abandoned', first['id'])
    assert abandoned['status'].upper() == 'ABANDONED'
    _, _, trees, _ = records(d, 'abandon-no-tree')
    assert not trees, 'Giving up must not earn any tree'
    if 'withered' not in d.texts().lower():
        findings.append('Returning Home after Give Up restores an old scroll position and hides the withered outcome. Bring the retained result and primary action into view on terminal outcome.')
        for _ in range(3): d.scroll(upward=True)
    assert 'withered' in d.texts().lower(), 'Keep an explicit withered result until acknowledgement'
    d.screenshot('session-withered')
    d.restart()
    assert 'withered' in d.texts().lower(), 'Pending abandonment feedback must survive cold restart'
    d.tap('Continue')
    d.passed('Give Up cancellation, explicit abandonment, retained withered feedback and no earned tree')

    d.seek('Session duration')
    slider(d, 0, 'Session duration')
    d.seek('Duration: 1 min', scroll=False)
    d.tap('Plant')
    second = session(d, 'completion-start')
    assert second['durationMinutes'] == 1 and second['id'] != first['id']
    d.tap('Focus sounds')
    d.tap('Rain')
    time.sleep(1)
    completion_pid = d.adb('shell','pidof',d.package).strip().split()[0]
    assert wait_for_playback(d, completion_pid, True, 'completion-audio-started'), 'Start actual rain before backgrounding'
    d.adb('shell','input','keyevent','KEYCODE_HOME')
    def before_resume():
        assert not app_playing(d, completion_pid, 'completion-audio-background'), 'At the elapsed deadline audio must stop while still backgrounded, before Activity resume'
    completed = wait_for_completion(d, second, before_resume)
    if 'Tree collected!' not in d.texts():
        findings.append('Returning Home after real completion hides the collected-tree feedback at a restored scroll position. Reveal the retained result immediately, without requiring the user to discover it by scrolling.')
        for _ in range(3): d.scroll(upward=True)
    assert 'Tree collected!' in d.texts(), 'Completion feedback remains visible until acknowledged'
    d.screenshot('session-completed')
    if '100 percent grown' not in d.texts():
        findings.append('After actual one-minute completion Home announces Tree collected but its main tree still looks like the initial 12-percent seedling. Bind the central artwork to the retained completed result (100-percent tree), keep a clearly withered result for abandonment, and return to the idle seedling only after Continue. Preserve these result visuals across rotation/restart until acknowledgement.')
    tasks, sessions, trees, data = records(d, 'one-earned-tree')
    assert len(trees) == 1 and trees[0]['sessionId'] == second['id']
    assert sum(s['durationMinutes'] for s in sessions if s['status'].upper() == 'COMPLETED') == 1
    goal = data['daily_goal'][0]
    assert goal['goalMinutes'] == 1 and goal['currentStreakDays'] == 1
    d.restart()
    assert 'Tree collected!' in d.texts()
    assert session(d, 'completion-restarted', second['id']) == completed
    assert len(records(d, 'idempotent-tree')[2]) == 1
    d.passed('Real one-minute background completion, one earned tree, goal/streak and idempotent recovery')
    d.tap('Continue')
    run_forest_and_stats_cases(d, biology)
    assert not findings, 'UI design acceptance failed: ' + ' '.join(findings)
    d.passed('Default portrait primary action and retained completed-tree visual match the approved design')


def run_task_and_goal_cases(d, biology):
    d.tap(['Tasks and daily goal settings', 'Settings'])
    d.edit('Chemistry', label='New task name', upward=False)
    d.tap('Add')
    d.tap('Rename Chemistry')
    d.rotate(1)
    d.edit('Physics', label='Task name', capture='task-rename-landscape-ime', upward=False)
    # Reopen the IME, then scroll the dialog's actual Save control into view.
    fields = [n for n in d.nodes() if n.get('class') == 'android.widget.EditText' and n.get('bounds') != '[0,0][0,0]']
    assert len(fields) == 1
    d.tap_node(fields[0])
    d.tap('Save')
    d.rotate(0)
    tasks, _, _, _ = records(d, 'renamed-task')
    physics = next(t for t in tasks if t['name'] == 'Physics')
    assert not any(t['name'] == 'Chemistry' for t in tasks)
    d.tap('Mark Physics complete')
    assert next(t for t in records(d, 'completed-task')[0] if t['id'] == physics['id'])['isCompleted']
    d.tap('Delete task Physics')
    d.tap('Cancel')
    assert any(t['id'] == physics['id'] for t in records(d, 'delete-cancelled')[0])
    d.tap('Delete task Physics')
    d.tap('Delete')
    assert not any(t['id'] == physics['id'] for t in records(d, 'deleted-task')[0])
    d.tap('Select Biology as active task')
    d.passed('Task rename with landscape keyboard, completion, cancelled/confirmed deletion and selection')

    d.edit('0', label='Daily goal', upward=False)
    assert 'between 1 and 1440' in d.texts()
    assert records(d, 'invalid-goal')[3]['daily_goal'][0]['goalMinutes'] == 60
    d.edit('1', label='Daily goal', capture='goal-portrait-ime', upward=False)
    d.tap('Save')
    assert records(d, 'saved-goal')[3]['daily_goal'][0]['goalMinutes'] == 1
    d.restart()
    assert records(d, 'goal-restarted')[3]['daily_goal'][0]['goalMinutes'] == 1
    d.passed('Daily-goal bounds, keyboard-safe editing and durable one-minute target')


def run_forest_and_stats_cases(d, biology):
    for _ in range(3):
        d.scroll(upward=True)
    d.tap('Your Forest')
    text = d.texts()
    assert 'Tree collected' in text and 'No trees yet' not in text
    d.screenshot('forest-earned-tree')
    d.rotate(1)
    d.screenshot('forest-landscape')
    d.rotate(0)
    assert len(records(d, 'forest-recreated')[2]) == 1
    d.tap(['Close forest', 'Close'])
    d.tap(['Tasks and daily goal settings', 'Settings'])
    d.tap('Stats')
    d.tap('Day')
    assert 'Total focused time: 1 min' in d.texts(), 'Day stats include completed minutes only'
    d.screenshot('stats-day')
    d.seek('Time by task')
    assert 'Biology' in d.texts()
    for _ in range(3):
        d.scroll(upward=True)
    d.tap('Week')
    assert 'Total focused time: 1 min' in d.texts(), 'Week stats retain the same single completed minute'
    d.screenshot('stats-week')
    d.restart()
    assert 'Total focused time: 1 min' in d.texts()
    _, sessions, trees, _ = records(d, 'final-state')
    assert len(sessions) == 2 and len(trees) == 1
    assert sorted(s['status'].upper() for s in sessions) == ['ABANDONED','COMPLETED']
    assert sum(s['durationMinutes'] for s in sessions if s['status'].upper() == 'COMPLETED') == 1
    d.passed('Earned forest tree, landscape layout, daily/weekly task minutes and durable history')
