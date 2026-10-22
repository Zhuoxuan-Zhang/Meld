package generated

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * Observes durable session timing without depending on an Activity or its ticker.
 * Launch [watch] in the session owner's scope, rather than repeatOnLifecycle.
 * Leaving the screen or locking the device is never an abandonment signal.
 *
 * This class owns no audio or storage. The callback must stop audio before
 * awaiting completion persistence; the repository still owns atomic, idempotent
 * resolution. Persistence retries belong to that owner, not to this watcher.
 */
class SessionDeadlineWatcher(private val clock: Clock) {
    private data class Deadline(val sessionId: String, val atMillis: Long)

    /**
     * Reconciles the first snapshot immediately, including overdue restoration.
     * Unrelated task, goal or session metadata changes cannot reset the wait or
     * cancel an in-flight callback. A terminal/null session or a different timing
     * identity cancels obsolete work, including a suspended callback.
     *
     * Delivery occurs once per distinct running identity/deadline observed by
     * this subscription. A new subscription can deliver again after restoration,
     * so [onDeadline] must tolerate an already-resolved session. Callback failures
     * propagate to the caller; cancellation is never swallowed.
     */
    suspend fun watch(
        sessions: Flow<Session?>,
        onDeadline: suspend (sessionId: String) -> Unit
    ) {
        sessions.map { session ->
            session?.takeIf { it.status == SessionStatus.RUNNING }?.let {
                Deadline(it.id, it.deadlineMillis)
            }
        }
            .distinctUntilChanged()
            .collectLatest { deadline ->
                if (deadline == null) return@collectLatest
                awaitDeadline(deadline.atMillis)
                currentCoroutineContext().ensureActive()
                onDeadline(deadline.sessionId)
            }
    }

    /**
     * One cancellable sleep for the remaining interval, with no polling or disk
     * writes. Recheck wall time after waking: a backward clock adjustment must
     * not resolve the persisted deadline prematurely. Late dispatch (for example
     * after device sleep) reconciles immediately when execution resumes.
     */
    private suspend fun awaitDeadline(deadlineMillis: Long) {
        while (true) {
            currentCoroutineContext().ensureActive()
            val now = clock.nowMillis()
            if (now >= deadlineMillis) return
            // Saturate subtraction for injected clocks spanning Long's limits.
            val remaining = if (now < 0L && deadlineMillis > Long.MAX_VALUE + now) {
                Long.MAX_VALUE
            } else {
                deadlineMillis - now
            }
            delay(remaining)
        }
    }
}
