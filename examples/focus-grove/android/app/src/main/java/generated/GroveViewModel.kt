package generated

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class GroveViewModel(application: Application) : AndroidViewModel(application) {
    private val repository: GroveRepository = RoomGroveRepository(application)
    private val preferences = application.getSharedPreferences("grove_editor", 0)
    private val serial = Mutex()
    private val clock = object : Clock {
        override fun nowMillis(): Long = System.currentTimeMillis()
    }
    private var mutationJob: Job? = null
    private var soundSelectionJob: Job? = null
    private val _state = MutableStateFlow(GroveState())
    val state = _state.asStateFlow()
    private val _ui = MutableStateFlow(RestorableUiState())
    val ui = _ui.asStateFlow()
    private val _busy = MutableStateFlow(true)
    val busy = _busy.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()
    private val _now = MutableStateFlow(System.currentTimeMillis())
    val now = _now.asStateFlow()
    private val _loaded = MutableStateFlow(false)
    val loaded = _loaded.asStateFlow()
    private var retryAction: (() -> Unit)? = null
    private var pendingAdd: TaskCommand.Add? = null
    private val player = AmbientPlayer(application)
    private var soundSelectionGeneration = 0L
    private val _sound = MutableStateFlow(SoundSetting())
    val sound = _sound.asStateFlow()
    private val _soundError = MutableStateFlow<String?>(null)
    val soundError = _soundError.asStateFlow()

    val remaining = combine(state, now) { s, time ->
        s.runningSession?.let { remainingSeconds(it, time) } ?: 0L
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0L)

    val goal = combine(state, now.map { localDay(it) }.distinctUntilChanged()) { s, day ->
        goalProgress(s, day, ZoneId.systemDefault())
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope,
        SharingStarted.WhileSubscribed(5000), GoalProgress())

    val summary = combine(state, ui.map { it.statsPeriodType to it.statsPeriodIndex }
        .distinctUntilChanged(), now.map { localDay(it) }.distinctUntilChanged()) { s, period, day ->
        summarize(s, periodRange(period.first, period.second, day, ZoneId.systemDefault()),
            ZoneId.systemDefault())
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope,
        SharingStarted.WhileSubscribed(5000), FocusSummary())

    init {
        viewModelScope.launch {
            restoreEditor()
            // This child belongs to the ViewModel, independently of Activity
            // STARTED state. Rotation, app switches and lock never abandon work.
            launch {
                SessionDeadlineWatcher(clock).watch(state.map { it.runningSession }) { id ->
                    val running = state.value.runningSession
                    if (running?.id == id && clock.nowMillis() >= running.deadlineMillis) {
                        // Silence first, even when another write is suspended or
                        // the eventual completion transaction fails.
                        stopSound()
                        while (true) {
                            val pending = mutationJob?.takeUnless { it.isCompleted } ?: break
                            pending.join()
                        }
                        _now.value = clock.nowMillis()
                        val current = state.value.runningSession
                        if (current?.id == id && _now.value >= current.deadlineMillis) {
                            finish(id, false)
                        }
                    }
                }
            }
            repository.state.retryWhen { cause, _ ->
                _error.value = cause.message ?: "Couldn't load local data. Retrying."
                delay(2000)
                true
            }.collect { snapshot ->
                _state.value = snapshot
                reconcileEditorPendingPlant(snapshot)
                _loaded.value = true
                if (mutationJob?.isCompleted != false) _busy.value = false
                if (snapshot.runningSession != null) {
                    _ui.update { it.copy(navigation = AppNavState(Route.Session)) }
                    reconcile()
                }
            }
        }
    }

    /** Called by the host's lifecycle-aware one-second ticker and on resume. */
    fun tick() {
        _now.value = System.currentTimeMillis()
        if (_loaded.value) reconcile()
    }

    private fun reconcile() {
        val running = state.value.runningSession ?: return
        _now.value = clock.nowMillis()
        if (_now.value >= running.deadlineMillis) {
            stopSound()
            if (!busy.value) finish(running.id, false)
        }
    }

    private fun reconcileEditorPendingPlant(committed: GroveState) {
        var changed = false
        _ui.update { current ->
            val drafts = current.drafts
            val pending = reconcilePendingPlant(
                drafts.pendingPlant, committed, drafts.durationMinutes
            )
            if (pending == drafts.pendingPlant) current else {
                changed = true
                current.copy(drafts = drafts.copy(pendingPlant = pending))
            }
        }
        if (changed) persistEditor()
    }

    fun editDraft(change: (EditorDrafts) -> EditorDrafts) {
        if (!loaded.value) return
        _ui.update { current ->
            val changed = change(current.drafts)
            current.copy(drafts = changed.copy(pendingPlant = reconcilePendingPlant(
                changed.pendingPlant, state.value, changed.durationMinutes
            )))
        }
        persistEditor()
    }

    fun setDuration(minutes: Int) = editDraft { it.copy(durationMinutes = minutes.coerceIn(1, 120)) }

    fun addTask(name: String, quick: Boolean = false) {
        val command = pendingAdd?.takeIf { it.name == name }
            ?: TaskCommand.Add(name).also { pendingAdd = it }
        mutate({ addTask(name, quick) }, { updateTask(it, command, now.value) }) {
            pendingAdd = null
            editDraft { if (quick) it.copy(quickTask = "") else it.copy(newTask = "") }
        }
    }

    fun task(command: TaskCommand): Unit = mutate({ task(command) }, {
        updateTask(it, command, now.value)
    }) {
        _ui.update { it.copy(deleteTaskId = null) }
        if (command is TaskCommand.Rename) editDraft {
            it.copy(renameTaskId = null, renameText = "")
        }
    }

    fun plant() {
        if (!loaded.value || busy.value) return
        reconcileEditorPendingPlant(state.value)
        val drafts = ui.value.drafts
        val operation = try {
            preparePlantOperation(
                drafts.pendingPlant, state.value, drafts.durationMinutes
            ) { UUID.randomUUID().toString() }
        } catch (failure: GroveRuleException) {
            _error.value = failure.message
            retryAction = ::plant
            return
        }
        // The restored editor payload is the sole owner of retry identity and intent.
        // Store all arguments together before attempting the session transaction.
        editDraft { it.copy(pendingPlant = operation) }
        mutate(::plant, {
            startSession(it, operation.sessionId, operation.taskId, operation.durationMinutes,
                System.currentTimeMillis())
        }) {
            editDraft { it.copy(pendingPlant = null) }
            _ui.update { it.copy(navigation = AppNavState(Route.Session), terminalResult = null) }
        }
    }

    fun giveUpDialog(show: Boolean) { _ui.update { it.copy(showGiveUpDialog = show) } }
    fun confirmGiveUp() { state.value.runningSession?.let { finish(it.id, true) } }

    private fun finish(id: String, giveUp: Boolean): Unit = mutate({ finish(id, giveUp) }, {
        resolveSession(it, id, giveUp, System.currentTimeMillis())
    }) { committed ->
        committed.sessions.firstOrNull { it.id == id && it.isTerminal }?.let { session ->
            stopSound()
            _ui.update { it.copy(
                navigation = AppNavState(Route.Home), showGiveUpDialog = false,
                terminalResult = TerminalResult(id, session.status, requireNotNull(session.endedAt),
                    committed.trees.firstOrNull { tree -> tree.sessionId == id }?.id)
            ) }
        }
    }

    fun acknowledgeResult() { _ui.update { it.copy(terminalResult = null) }; persistEditor() }
    fun saveDailyGoal() {
        val draft = ui.value.drafts.goal
        mutate(::saveDailyGoal, { saveGoal(it, draft, System.currentTimeMillis()) }) {
            editDraft { d -> d.copy(goal = it.dailyGoal.goalMinutes.toString()) }
        }
    }

    fun navigate(route: Route) {
        if (state.value.runningSession != null) return
        _ui.update { it.copy(navigation = AppNavState(route)) }
        persistEditor()
    }
    fun back(): Boolean {
        if (state.value.runningSession != null) return true
        when (ui.value.navigation.current) {
            Route.Home -> return false
            Route.Stats -> navigate(Route.TasksGoal())
            is Route.TasksGoal -> if (ui.value.drafts.hasUnsavedChanges(state.value.dailyGoal.goalMinutes)) {
                _ui.update { it.copy(showUnsavedDialog = true) }
            } else navigate(Route.Home)
            else -> navigate(Route.Home)
        }
        return true
    }
    fun discardChanges() {
        editDraft { it.copy(newTask = "", goal = state.value.dailyGoal.goalMinutes.toString(),
            renameTaskId = null, renameText = "") }
        keepEditing()
        navigate(Route.Home)
    }
    fun keepEditing() { _ui.update { it.copy(showUnsavedDialog = false) } }
    fun requestDelete(id: String?) { _ui.update { it.copy(deleteTaskId = id) } }
    fun confirmDelete() { ui.value.deleteTaskId?.let { task(TaskCommand.Delete(it)) } }
    fun statsPeriod(type: PeriodType, index: Int = 0) {
        _ui.update { it.copy(statsPeriodType = type, statsPeriodIndex = index.coerceAtMost(0)) }
        persistEditor()
    }
    fun retry() { retryAction?.invoke() }
    fun dismissError() { _error.value = null }

    private fun mutate(retry: () -> Unit, change: (GroveState) -> GroveState,
                       success: (GroveState) -> Unit = {}) {
        if (!_loaded.value || busy.value) return
        _busy.value = true
        mutationJob = viewModelScope.launch {
            serial.withLock {
                try {
                    repository.transact(change)
                    val committed = repository.state.first()
                    _state.value = committed
                    // Selection, completion, deletion and committed session identities
                    // can all make an earlier failed Plant operation obsolete.
                    reconcileEditorPendingPlant(committed)
                    _error.value = null
                    retryAction = null
                    success(committed)
                    persistEditor()
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    _error.value = failure.message ?: "Couldn't save that. Try again."
                    retryAction = retry
                } finally { _busy.value = false }
            }
        }
    }

    fun selectSound(loop: SoundLoop) {
        stopSound()
        val generation = soundSelectionGeneration
        // A pending replacement has no resumable selection. Publish the loop
        // only after the platform player has successfully started it.
        _sound.update { it.copy(selectedSound = SoundLoop.NONE, isPlaying = false) }
        _soundError.value = null
        if (loop == SoundLoop.NONE) return
        val session = state.value.runningSession ?: return
        if (!canPlaySound(session.id)) return
        soundSelectionJob = viewModelScope.launch {
            try {
                if (!canPlaySound(session.id)) return@launch
                player.select(loop)
                currentCoroutineContext().ensureActive()
                // A cancelled or superseded selection must never publish success
                // or pause playback owned by a newer selection.
                if (generation != soundSelectionGeneration) return@launch
                if (!canPlaySound(session.id)) {
                    stopSound()
                    return@launch
                }
                _sound.update { it.copy(selectedSound = loop, isPlaying = true) }
                _soundError.value = null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (generation == soundSelectionGeneration) {
                    stopSound()
                    _sound.update { it.copy(selectedSound = SoundLoop.NONE, isPlaying = false) }
                    _soundError.value = "Couldn't load this sound. Choose a sound to try again."
                }
            }
        }
    }

    private fun canPlaySound(sessionId: String): Boolean {
        val session = state.value.runningSession ?: return false
        return session.id == sessionId && clock.nowMillis() < session.deadlineMillis
    }
    fun volume(value: Float) {
        val bounded = value.takeIf { it.isFinite() }?.coerceIn(0f, 1f) ?: 0.5f
        _sound.update { it.copy(volume = bounded) }
        try {
            player.setVolume(bounded)
        } catch (_: Exception) {
            stopSound()
            _sound.update { it.copy(selectedSound = SoundLoop.NONE, isPlaying = false) }
            _soundError.value = "Couldn't adjust this sound. Choose a sound to try again."
        }
    }
    fun stopSound() {
        soundSelectionGeneration++
        soundSelectionJob?.cancel()
        soundSelectionJob = null
        // Invalidate pending preparation immediately, before any timer write.
        // Audio failures must never interrupt deadline reconciliation.
        val paused = runCatching { player.pause() }.isSuccess
        _sound.update {
            it.copy(isPlaying = false,
                selectedSound = if (paused) it.selectedSound else SoundLoop.NONE)
        }
        if (!paused) {
            _soundError.value = "Couldn't pause this sound. Choose a sound to try again."
        }
    }
    fun resumeSound() {
        val session = state.value.runningSession
        if (session == null || !canPlaySound(session.id)) {
            stopSound()
            return
        }
        if (sound.value.selectedSound == SoundLoop.NONE) return
        try {
            player.resume()
            _sound.update { it.copy(isPlaying = true) }
            _soundError.value = null
        } catch (_: Exception) {
            stopSound()
            _sound.update { it.copy(selectedSound = SoundLoop.NONE, isPlaying = false) }
            _soundError.value = "Couldn't play this sound. Choose a sound to try again."
        }
    }

    private fun localDay(time: Long) = Instant.ofEpochMilli(time).atZone(ZoneId.systemDefault()).toLocalDate()

    private val editorWrites = Mutex()
    private fun persistEditor() {
        val snapshot = ui.value
        viewModelScope.launch(Dispatchers.IO) {
            editorWrites.withLock {
                preferences.edit()
                    .putString("editor", GroveEditorCodec.encode(snapshot))
                    .commit()
            }
        }
    }

    private suspend fun restoreEditor() {
        val restored = withContext(Dispatchers.IO) {
            // Resolve saved identities against committed history before exposing
            // editor state. Restoration never replays a terminal mutation.
            val persisted = repository.state.retryWhen { cause, _ ->
                _error.value = cause.message ?: "Couldn't load local data. Retrying."
                delay(2000)
                true
            }.first()
            val raw = runCatching { preferences.getString("editor", null) }.getOrNull()
            GroveEditorCodec.decode(raw, persisted)
        }
        _ui.value = restored
    }

    override fun onCleared() {
        soundSelectionGeneration++
        soundSelectionJob?.cancel()
        soundSelectionJob = null
        player.close()
        super.onCleared()
    }
}
