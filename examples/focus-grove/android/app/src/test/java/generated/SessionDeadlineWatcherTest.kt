package generated

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionDeadlineWatcherTest {
    private val epoch = 1_800_000_000_000L

    private fun TestScope.clock(): Clock = object : Clock {
        override fun nowMillis(): Long = epoch + testScheduler.currentTime
    }

    private fun session(id: String = "first", start: Long = epoch) = Session(
        id = id, taskId = "study", durationMinutes = 1, startedAt = start,
        taskName = "Chemistry"
    )

    @Test fun shutsDownAtExactDeadlineWithoutActivityTicks() = runTest {
        val snapshots = MutableStateFlow<Session?>(session())
        val deliveries = mutableListOf<Pair<String, Long>>()
        val watcher = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) {
                deliveries += it to testScheduler.currentTime
            }
        }
        runCurrent()
        advanceTimeBy(59_999)
        runCurrent()
        assertTrue(deliveries.isEmpty())
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf("first" to 60_000L), deliveries)
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(1, deliveries.size)
        watcher.cancelAndJoin()
    }

    @Test fun overdueRestorationDeliversImmediatelyUsingPersistedIdentity() = runTest {
        val restored = session("restored", epoch - 90_000)
        val snapshots = MutableStateFlow<Session?>(restored)
        val deliveries = mutableListOf<String>()
        val watcher = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) { deliveries += it }
        }
        runCurrent()
        assertEquals(listOf("restored"), deliveries)
        assertEquals(0L, testScheduler.currentTime)
        watcher.cancelAndJoin()
    }

    @Test fun metadataSnapshotsDoNotPostponeDeadline() = runTest {
        val original = session()
        val snapshots = MutableStateFlow<Session?>(original)
        val deliveries = mutableListOf<Long>()
        val watcher = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) {
                deliveries += testScheduler.currentTime
            }
        }
        runCurrent()
        repeat(3) { index ->
            advanceTimeBy(15_000)
            snapshots.value = original.copy(taskName = "Renamed $index")
            runCurrent()
        }
        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(listOf(60_000L), deliveries)
        watcher.cancelAndJoin()
    }

    @Test fun terminalAndMissingSessionsCancelPendingWaits() = runTest {
        for (status in listOf(SessionStatus.COMPLETED, SessionStatus.ABANDONED, null)) {
            val original = session(start = clock().nowMillis())
            val snapshots = MutableStateFlow<Session?>(original)
            var calls = 0
            val watcher = launch {
                SessionDeadlineWatcher(clock()).watch(snapshots) { calls++ }
            }
            runCurrent()
            advanceTimeBy(10_000)
            snapshots.value = status?.let {
                snapshots.value!!.copy(status = it, endedAt = clock().nowMillis())
            }
            runCurrent()
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals("Unexpected delivery for $status", 0, calls)
            watcher.cancelAndJoin()
        }
    }

    @Test fun replacementCancelsObsoleteSessionDeadline() = runTest {
        val snapshots = MutableStateFlow<Session?>(session())
        val deliveries = mutableListOf<Pair<String, Long>>()
        val watcher = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) {
                deliveries += it to testScheduler.currentTime
            }
        }
        runCurrent()
        advanceTimeBy(20_000)
        snapshots.value = session("replacement", epoch + 20_000)
        runCurrent()
        advanceTimeBy(40_000)
        runCurrent()
        assertTrue(deliveries.isEmpty())
        advanceTimeBy(20_000)
        runCurrent()
        assertEquals(listOf("replacement" to 80_000L), deliveries)
        watcher.cancelAndJoin()
    }

    @Test fun changedDeadlineForSameIdReplacesPendingWait() = runTest {
        val original = session()
        val snapshots = MutableStateFlow<Session?>(original)
        val deliveries = mutableListOf<Long>()
        val watcher = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) {
                deliveries += testScheduler.currentTime
            }
        }
        runCurrent()
        advanceTimeBy(10_000)
        snapshots.value = original.copy(durationMinutes = 2)
        runCurrent()
        advanceTimeBy(50_000)
        runCurrent()
        assertTrue(deliveries.isEmpty())
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(listOf(120_000L), deliveries)
        watcher.cancelAndJoin()
    }

    @Test fun shutdownPrecedesSuspendedPersistenceAndMetadataDoesNotRedeliver() = runTest {
        val original = session()
        val snapshots = MutableStateFlow<Session?>(original)
        val persist = CompletableDeferred<Unit>()
        var audioPlaying = true
        var deliveries = 0
        var persisted = false
        var callbackExited = false
        val watcher = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) {
                deliveries++
                audioPlaying = false
                try {
                    persist.await()
                    persisted = true
                } finally {
                    callbackExited = true
                }
            }
        }
        runCurrent()
        advanceTimeBy(60_000)
        runCurrent()
        assertFalse(audioPlaying)
        assertFalse(persisted)
        repeat(3) { index ->
            snapshots.value = original.copy(taskName = "Update $index")
            runCurrent()
        }
        assertEquals(1, deliveries)
        assertFalse(callbackExited)
        persist.complete(Unit)
        runCurrent()
        assertTrue(persisted)
        assertTrue(callbackExited)
        assertEquals(1, deliveries)
        watcher.cancelAndJoin()
    }

    @Test fun cancellationReleasesWaitAndSuspendedCallback() = runTest {
        val snapshots = MutableStateFlow<Session?>(session())
        var calls = 0
        val waiting = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) { calls++ }
        }
        runCurrent()
        waiting.cancelAndJoin()
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(0, calls)

        var released = false
        val delivering = launch {
            SessionDeadlineWatcher(clock()).watch(snapshots) {
                calls++
                try { awaitCancellation() } finally { released = true }
            }
        }
        runCurrent()
        assertEquals(1, calls)
        delivering.cancelAndJoin()
        assertTrue(released)
        assertTrue(delivering.isCancelled)
    }
}
