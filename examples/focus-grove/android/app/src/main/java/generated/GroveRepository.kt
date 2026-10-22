package generated

import android.content.Context
import androidx.room.withTransaction
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

interface GroveRepository {
    val state: Flow<GroveState>
    suspend fun transact(change: (GroveState) -> GroveState)
}

/**
 * Publishes committed snapshots. The database transaction covers the read as well
 * as the write, so separate repository instances cannot overwrite each other's
 * session completion or task selection.
 */
class RoomGroveRepository(
    private val database: GroveDatabase,
    private val clock: Clock = object : Clock {
        override fun nowMillis(): Long = System.currentTimeMillis()
    },
    private val zone: ZoneId = ZoneId.systemDefault()
) : GroveRepository {
    constructor(context: Context) : this(GroveDatabase.getInstance(context))

    private val mutations = Mutex()
    private val dao = database.dao()

    override val state: Flow<GroveState> = dao.observeChanges()
        .map { dao.readState() }
        .distinctUntilChanged()
        .flowOn(Dispatchers.IO)

    override suspend fun transact(change: (GroveState) -> GroveState) {
        withContext(Dispatchers.IO) {
            mutations.withLock {
                database.withTransaction {
                    val before = dao.readState()
                    val proposed = change(before)
                    // Retries and unchanged saves do not rewrite the singleton or
                    // emit artificial changes. Exceptions propagate to the owner
                    // so its draft and operation identity remain available.
                    if (proposed != before) {
                        validateHistory(before, proposed)
                        val now = clock.nowMillis()
                        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
                        val streak = goalProgress(proposed, today, zone).streakDays
                        val committed = if (streak == proposed.dailyGoal.currentStreakDays) {
                            proposed
                        } else {
                            proposed.copy(dailyGoal = proposed.dailyGoal.copy(
                                currentStreakDays = streak,
                                updatedAt = now
                            ))
                        }
                        dao.writeState(committed)
                    }
                }
            }
        }
    }

    private fun validateHistory(before: GroveState, after: GroveState) {
        require(after.tasks.map { it.id }.distinct().size == after.tasks.size)
        require(after.sessions.map { it.id }.distinct().size == after.sessions.size)
        require(after.trees.map { it.id }.distinct().size == after.trees.size)
        val sessions = after.sessions.associateBy { it.id }
        before.sessions.forEach { previous ->
            val next = requireNotNull(sessions[previous.id]) { "Session history must be retained." }
            require(next.copy(status = previous.status, endedAt = previous.endedAt) == previous) {
                "Session identity and original timing cannot change."
            }
            if (previous.isTerminal) require(next == previous) {
                "A terminal session cannot change."
            }
        }
        require(after.trees.containsAll(before.trees)) { "Collected trees must be retained." }
        after.sessions.forEach { session ->
            if (session.status == SessionStatus.COMPLETED) {
                require(after.trees.count { it.sessionId == session.id } == 1) {
                    "A completed session must collect exactly one tree."
                }
            }
        }
        after.runningSession?.let { running ->
            require(after.tasks.any { it.id == running.taskId }) {
                "This task is in use by your current session."
            }
        }
    }
}
