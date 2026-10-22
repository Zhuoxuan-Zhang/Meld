package generated

/** Keep only an uncommitted retry whose complete payload still matches the editor. */
fun reconcilePendingPlant(
    pending: PendingPlant?,
    state: GroveState,
    durationMinutes: Int
): PendingPlant? {
    if (pending == null || durationMinutes !in 1..120) return null
    val task = state.activeTask ?: return null
    return pending.takeIf {
        it.sessionId.isNotBlank() &&
            it.taskId == task.id &&
            it.durationMinutes == durationMinutes &&
            state.runningSession == null &&
            state.sessions.none { session -> session.id == it.sessionId }
    }
}

/** Validate current intent before allocating identity; unchanged retries reuse their payload. */
fun preparePlantOperation(
    pending: PendingPlant?,
    state: GroveState,
    durationMinutes: Int,
    newSessionId: () -> String
): PendingPlant {
    rule(durationMinutes in 1..120, "Choose a duration between 1 and 120 minutes.")
    val task = state.activeTask
        ?: throw GroveRuleException("Add and select an incomplete task before planting.")
    rule(task.id.isNotBlank(), "Task identity is required.")
    rule(state.runningSession == null,
        "Finish or give up your current session before planting another.")
    reconcilePendingPlant(pending, state, durationMinutes)?.let { return it }

    val sessionId = newSessionId()
    rule(sessionId.isNotBlank(), "Session identity is required.")
    rule(state.sessions.none { it.id == sessionId },
        "This session identity has already been committed.")
    rule(sessionId != pending?.sessionId,
        "A changed planting operation requires a new session identity.")
    return PendingPlant(sessionId, task.id, durationMinutes)
}

/** Pure transitions; repositories must execute them inside one atomic transaction. */
fun startSession(
    state: GroveState,
    sessionId: String,
    taskId: String,
    minutes: Int,
    now: Long
): GroveState {
    rule(sessionId.isNotBlank(), "Session identity is required.")
    rule(minutes in 1..120, "Choose a duration between 1 and 120 minutes.")
    state.sessions.firstOrNull { it.id == sessionId }?.let {
        rule(it.taskId == taskId && it.durationMinutes == minutes,
            "This session identity belongs to a different operation.")
        return state // A retry cannot restart even a terminal session.
    }
    rule(state.runningSession == null,
        "Finish or give up your current session before planting another.")
    val task = state.tasks.firstOrNull { it.id == taskId }
        ?: throw GroveRuleException("Choose an existing study task.")
    rule(!task.isCompleted, "Choose an incomplete study task.")
    rule(now <= Long.MAX_VALUE - minutes * 60_000L, "Session time is out of range.")
    return state.copy(sessions = state.sessions + Session(
        id = sessionId,
        taskId = taskId,
        durationMinutes = minutes,
        startedAt = now,
        taskName = task.name
    ))
}

/** A late Give Up reconciles an already elapsed deadline as a completion. */
fun resolveSession(
    state: GroveState,
    sessionId: String,
    giveUp: Boolean,
    now: Long
): GroveState {
    val session = state.sessions.firstOrNull { it.id == sessionId } ?: return state
    if (session.isTerminal) return state
    val elapsed = now >= session.deadlineMillis
    if (!elapsed && !giveUp) return state
    val status = if (elapsed) SessionStatus.COMPLETED else SessionStatus.ABANDONED
    // Attribute recovered completions to their actual deadline, not relaunch day.
    val endedAt = if (elapsed) session.deadlineMillis else maxOf(now, session.startedAt)
    val resolved = session.copy(status = status, endedAt = endedAt)
    val trees = if (status == SessionStatus.COMPLETED &&
        state.trees.none { it.sessionId == sessionId }) {
        // Deterministic identity also makes repeated completion attempts safe.
        state.trees + Tree(id = "tree:$sessionId", sessionId = sessionId, collectedAt = endedAt)
    } else state.trees
    return state.copy(
        sessions = state.sessions.map { if (it.id == sessionId) resolved else it },
        trees = trees
    )
}

fun remainingSeconds(session: Session, now: Long): Long {
    if (session.isTerminal || now >= session.deadlineMillis) return 0L
    val boundedNow = maxOf(now, session.startedAt)
    return (session.deadlineMillis - boundedNow + 999L) / 1_000L
}

fun updateTask(state: GroveState, command: TaskCommand, now: Long): GroveState {
    val tasks = state.tasks
    val changed = when (command) {
        is TaskCommand.Add -> {
            val name = validatedTaskName(command.name)
            rule(command.id.isNotBlank(), "Task identity is required.")
            val existing = tasks.firstOrNull { it.id == command.id }
            if (existing != null) {
                // Preserve later edits, completion and selection on an Add retry.
                return state
            }
            tasks + Task(
                id = command.id, name = name, createdAt = now,
                isActive = command.activateIfNone && state.activeTask == null
            )
        }
        is TaskCommand.Rename -> {
            val name = validatedTaskName(command.name)
            rule(tasks.any { it.id == command.taskId }, "This task no longer exists.")
            tasks.map { if (it.id == command.taskId) it.copy(name = name) else it }
        }
        is TaskCommand.Select -> {
            val selected = tasks.firstOrNull { it.id == command.taskId } ?: return state
            rule(!selected.isCompleted, "Choose an incomplete study task.")
            tasks.map { it.copy(isActive = it.id == selected.id) }
        }
        is TaskCommand.SetCompleted -> tasks.map {
            if (it.id == command.taskId) it.copy(
                isCompleted = command.completed,
                isActive = it.isActive && !command.completed
            ) else it
        }
        is TaskCommand.Delete -> {
            rule(state.sessions.none {
                it.taskId == command.taskId && it.status == SessionStatus.RUNNING
            }, "This task is in use by your current session.")
            // Session snapshots retain historical attribution after deletion.
            tasks.filterNot { it.id == command.taskId }
        }
    }
    // Normalize activation when adding after a completed active task.
    val activeId = changed.firstOrNull { it.isActive && !it.isCompleted }?.id
    val normalized = changed.map { it.copy(isActive = it.id == activeId) }
    return if (normalized == tasks) state else state.copy(tasks = normalized)
}

private fun validatedTaskName(raw: String): String {
    val name = raw.trim()
    rule(name.length in 1..80, "Enter a task name between 1 and 80 characters.")
    return name
}

private fun rule(condition: Boolean, message: String) {
    if (!condition) throw GroveRuleException(message)
}
