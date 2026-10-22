package generated

import java.time.LocalDate
import java.util.UUID

/** Domain timestamps are UTC epoch milliseconds; calendar boundaries use an explicit zone. */
interface Clock {
    fun nowMillis(): Long
}

enum class SessionStatus { RUNNING, COMPLETED, ABANDONED }
enum class PeriodType { DAY, WEEK, MONTH, YEAR }
enum class SoundLoop { NONE, RAIN, WIND, FOREST }
enum class SettingsTab { TASKS, STATS }

data class Task(
    val id: String,
    val name: String,
    val isCompleted: Boolean = false,
    val isActive: Boolean = false,
    val createdAt: Long
)

data class Session(
    val id: String,
    val taskId: String,
    val durationMinutes: Int,
    val status: SessionStatus = SessionStatus.RUNNING,
    val startedAt: Long,
    val endedAt: Long? = null,
    /** Snapshot keeps historical attribution readable after the task is deleted. */
    val taskName: String = ""
) {
    val deadlineMillis: Long get() = startedAt + durationMinutes * 60_000L
    val isTerminal: Boolean get() = status != SessionStatus.RUNNING
}

data class Tree(
    val id: String,
    val sessionId: String,
    val collectedAt: Long
)

data class DailyGoal(
    val id: String = "singleton",
    val goalMinutes: Int = 60,
    val currentStreakDays: Int = 0,
    val updatedAt: Long = 0L
)

/** Sound settings belong to the current session UI, never to durable app storage. */
data class SoundSetting(
    val selectedSound: SoundLoop = SoundLoop.NONE,
    val volume: Float = 0.5f,
    val isPlaying: Boolean = false
)

/** A repository publishes immutable snapshots, replacing lists on each committed mutation. */
data class GroveState(
    val tasks: List<Task> = emptyList(),
    val sessions: List<Session> = emptyList(),
    val trees: List<Tree> = emptyList(),
    val dailyGoal: DailyGoal = DailyGoal()
) {
    val activeTask: Task? get() = tasks.firstOrNull { it.isActive && !it.isCompleted }
    val runningSession: Session? get() = sessions.firstOrNull { it.status == SessionStatus.RUNNING }
}

sealed interface TaskCommand {
    /** The caller retains this ID across write retries. */
    data class Add(
        val name: String,
        val id: String = UUID.randomUUID().toString(),
        val activateIfNone: Boolean = true
    ) : TaskCommand
    data class Rename(val taskId: String, val name: String) : TaskCommand
    data class Select(val taskId: String) : TaskCommand
    data class SetCompleted(val taskId: String, val completed: Boolean) : TaskCommand
    data class Delete(val taskId: String) : TaskCommand
}

/** Inclusive start, exclusive end, including DST-shortened or extended calendar days. */
data class PeriodRange(
    val startMillis: Long,
    val endMillis: Long,
    val startDate: LocalDate,
    val endDateExclusive: LocalDate,
    val type: PeriodType,
    val index: Int = 0
) {
    fun contains(timestamp: Long): Boolean = timestamp >= startMillis && timestamp < endMillis
}

data class FocusSummary(
    val totalMinutes: Int = 0,
    val minutesByBucket: List<Pair<String, Int>> = emptyList(),
    val minutesByTask: List<Pair<String, Int>> = emptyList(),
    val completedSessionCount: Int = 0
) {
    val isEmpty: Boolean get() = completedSessionCount == 0
}

data class GoalProgress(
    val focusedMinutes: Int = 0,
    val goalMinutes: Int = 60,
    val streakDays: Int = 0
) {
    val isMet: Boolean get() = focusedMinutes >= goalMinutes
    val fraction: Float
        get() = if (goalMinutes > 0) (focusedMinutes.toFloat() / goalMinutes).coerceIn(0f, 1f) else 0f
}

sealed class Route {
    data object Home : Route()
    data object Session : Route()
    data class Forest(val periodType: PeriodType = PeriodType.DAY, val periodIndex: Int = 0) : Route()
    data class TasksGoal(val initialTab: SettingsTab = SettingsTab.TASKS) : Route()
    data object Stats : Route()
}

data class AppNavState(
    val primary: Route = Route.Home,
    val subRoute: Route? = null
) {
    val current: Route get() = subRoute ?: primary
}

/** Immutable payload retained together so an unchanged Plant retry keeps its identity. */
data class PendingPlant(
    val sessionId: String,
    val taskId: String,
    val durationMinutes: Int
)

/** Editor drafts are serialized together for restoration across recreation and restart. */
data class EditorDrafts(
    val quickTask: String = "",
    val newTask: String = "",
    val goal: String = "60",
    val renameTaskId: String? = null,
    val renameText: String = "",
    val durationMinutes: Int = 25,
    val selectedTaskId: String? = null,
    val pendingPlant: PendingPlant? = null
) {
    fun hasUnsavedChanges(savedGoalMinutes: Int): Boolean =
        newTask.isNotBlank() || goal != savedGoalMinutes.toString() || renameTaskId != null
}

/** Retained until acknowledged; navigating or recreating must not replay the mutation. */
data class TerminalResult(
    val sessionId: String,
    val status: SessionStatus,
    val endedAt: Long,
    val treeId: String? = null
) {
    init {
        require(status != SessionStatus.RUNNING) { "A result must be terminal." }
        require(status == SessionStatus.COMPLETED || treeId == null) {
            "An abandoned session cannot collect a tree."
        }
    }
}

data class RestorableUiState(
    val navigation: AppNavState = AppNavState(),
    val drafts: EditorDrafts = EditorDrafts(),
    val statsPeriodType: PeriodType = PeriodType.WEEK,
    val statsPeriodIndex: Int = 0,
    val showGiveUpDialog: Boolean = false,
    val deleteTaskId: String? = null,
    val showUnsavedDialog: Boolean = false,
    val terminalResult: TerminalResult? = null
)

/** Expected rule failures are safe for presentation; persistence failures remain retryable. */
class GroveRuleException(message: String) : IllegalArgumentException(message)
