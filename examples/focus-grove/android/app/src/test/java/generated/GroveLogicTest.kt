package generated

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

class GroveLogicTest {
    private val utc = ZoneId.of("UTC")
    private val today = LocalDate.of(2026, 10, 21)
    private val start = today.atStartOfDay(utc).toInstant().toEpochMilli()

    private fun seeded(): GroveState = updateTask(
        GroveState(), TaskCommand.Add("  Chemistry  ", "a"), start
    )

    private fun completed(
        state: GroveState, id: String, day: LocalDate, minutes: Int,
        taskId: String = "a"
    ): GroveState {
        val time = day.atTime(12, 0).atZone(utc).toInstant().toEpochMilli()
        return resolveSession(startSession(state, id, taskId, minutes, time),
            id, false, time + minutes * 60_000L)
    }

    @Test fun taskLifecyclePreservesSelectionAndHistory() {
        var state = seeded()
        assertEquals("Chemistry", state.activeTask?.name)
        state = updateTask(state, TaskCommand.Add("Math", "b"), start)
        state = updateTask(state, TaskCommand.Select("b"), start)
        assertEquals(listOf("b"), state.tasks.filter { it.isActive }.map { it.id })
        state = updateTask(state, TaskCommand.Rename("b", "  Algebra "), start)
        state = completed(state, "s", today, 25, "b")
        state = updateTask(state, TaskCommand.SetCompleted("b", true), start)
        assertNull(state.activeTask)
        assertThrows(GroveRuleException::class.java) {
            startSession(state, "blocked", "b", 25, start)
        }
        state = updateTask(state, TaskCommand.SetCompleted("b", false), start)
        state = updateTask(state, TaskCommand.Select("b"), start)
        state = updateTask(state, TaskCommand.Delete("b"), start)
        assertNull(state.activeTask)
        val summary = summarize(state, periodRange(PeriodType.DAY, 0, today, utc), utc)
        assertEquals(listOf("Algebra" to 25), summary.minutesByTask)
        assertEquals(1, state.trees.size)
    }

    @Test fun invalidNamesAndRunningTaskDeletionAreRejected() {
        val state = seeded()
        for (name in listOf("  ", "x".repeat(81))) {
            assertThrows(GroveRuleException::class.java) {
                updateTask(state, TaskCommand.Add(name, "bad"), start)
            }
        }
        val running = startSession(state, "s", "a", 25, start)
        assertThrows(GroveRuleException::class.java) {
            updateTask(running, TaskCommand.Delete("a"), start)
        }
        assertEquals("a", running.runningSession?.taskId)
    }

    @Test fun startValidatesBoundsAndRetryIdentity() {
        val state = seeded()
        for (minutes in listOf(0, 121)) {
            assertThrows(GroveRuleException::class.java) {
                startSession(state, "s", "a", minutes, start)
            }
        }
        assertEquals(120, startSession(state, "max", "a", 120, start)
            .runningSession?.durationMinutes)
        val running = startSession(state, "s", "a", 1, start)
        assertEquals(running, startSession(running, "s", "a", 1, start + 10_000))
        assertThrows(GroveRuleException::class.java) {
            startSession(running, "another", "a", 1, start)
        }
        assertThrows(GroveRuleException::class.java) {
            startSession(running, "s", "a", 2, start)
        }
    }

    @Test fun deadlineRecoveryCollectsOnceAtOriginalDeadline() {
        val running = startSession(seeded(), "s", "a", 1, start)
        val session = running.runningSession!!
        assertEquals(60L, remainingSeconds(session, start - 100))
        assertEquals(1L, remainingSeconds(session, start + 59_001))
        assertEquals(running, resolveSession(running, "s", false, start + 59_999))
        // Rebuild a snapshot as a repository reload would, with no live timer state.
        val restored = running.copy(sessions = running.sessions.map { it.copy() })
        val done = resolveSession(restored, "s", false, start + 172_800_000)
        assertEquals(SessionStatus.COMPLETED, done.sessions.single().status)
        assertEquals(start + 60_000, done.sessions.single().endedAt)
        assertEquals(start + 60_000, done.trees.single().collectedAt)
        assertEquals(done, resolveSession(done, "s", true, start + 200_000_000))
        assertEquals(done, startSession(done, "s", "a", 1, start + 200_000_000))
    }

    @Test fun explicitAbandonmentIsTerminalButLateGiveUpCompletes() {
        val running = startSession(seeded(), "s", "a", 1, start)
        val abandoned = resolveSession(running, "s", true, start + 10_000)
        assertEquals(SessionStatus.ABANDONED, abandoned.sessions.single().status)
        assertTrue(abandoned.trees.isEmpty())
        assertEquals(abandoned, resolveSession(abandoned, "s", false, start + 60_000))
        assertEquals(0, summarize(abandoned,
            periodRange(PeriodType.DAY, 0, today, utc), utc).totalMinutes)
        assertEquals(1, resolveSession(running, "s", true, start + 60_000).trees.size)
    }

    @Test fun unchangedFailedPlantRetriesReuseIdentityAndCompletePayload() {
        val state = seeded()
        var allocations = 0
        val allocate = { "plant-${++allocations}" }
        val pending = preparePlantOperation(null, state, 25, allocate)
        assertEquals(PendingPlant("plant-1", "a", 25), pending)
        assertEquals(1, allocations)
        // A failed write leaves committed state unchanged and retains the payload.
        repeat(3) {
            assertSame(pending, reconcilePendingPlant(pending, state, 25))
            assertSame(pending, preparePlantOperation(pending, state, 25, allocate))
        }
        assertEquals(1, allocations)
        val started = startSession(state, pending.sessionId, pending.taskId,
            pending.durationMinutes, start)
        assertEquals("plant-1", started.runningSession?.id)
        assertEquals("a", started.runningSession?.taskId)
        assertEquals(25, started.runningSession?.durationMinutes)
        assertNull(reconcilePendingPlant(pending, started, 25))
    }

    @Test fun switchingTaskAndDurationReplacesFailedPlantIntent() {
        var state = updateTask(seeded(), TaskCommand.Add("Math", "b"), start)
        var allocations = 0
        val allocate = { "plant-${++allocations}" }
        val failed = preparePlantOperation(null, state, 25, allocate)
        state = updateTask(state, TaskCommand.Select("b"), start + 1)
        assertNull(reconcilePendingPlant(failed, state, 10))
        // Preparation must defend against a stale payload even before reconciliation.
        val replacement = preparePlantOperation(failed, state, 10, allocate)
        assertEquals(PendingPlant("plant-2", "b", 10), replacement)
        assertEquals(2, allocations)
        assertSame(replacement, preparePlantOperation(replacement, state, 10, allocate))
        assertEquals(2, allocations)
        val started = startSession(state, replacement.sessionId, replacement.taskId,
            replacement.durationMinutes, start + 2)
        assertEquals("b", started.runningSession?.taskId)
        assertEquals(10, started.runningSession?.durationMinutes)
        assertEquals("Math", started.runningSession?.taskName)
        assertFalse(started.sessions.any { it.id == failed.sessionId })
    }

    @Test fun taskOnlyAndDurationOnlyChangesEachRequireNewIdentity() {
        val initial = updateTask(seeded(), TaskCommand.Add("Math", "b"), start)
        var allocations = 0
        val allocate = { "plant-${++allocations}" }
        val failed = preparePlantOperation(null, initial, 25, allocate)
        val switched = updateTask(initial, TaskCommand.Select("b"), start)
        assertNull(reconcilePendingPlant(failed, switched, 25))
        val taskReplacement = preparePlantOperation(failed, switched, 25, allocate)
        assertEquals(PendingPlant("plant-2", "b", 25), taskReplacement)
        assertNull(reconcilePendingPlant(taskReplacement, switched, 10))
        val durationReplacement = preparePlantOperation(taskReplacement, switched, 10, allocate)
        assertEquals(PendingPlant("plant-3", "b", 10), durationReplacement)
        assertSame(durationReplacement,
            preparePlantOperation(durationReplacement, switched, 10, allocate))
        assertEquals(3, allocations)
    }

    @Test fun deletingOrCompletingPendingTaskInvalidatesItWithoutAllocating() {
        val initial = updateTask(seeded(), TaskCommand.Add("Math", "b"), start)
        for (command in listOf(TaskCommand.Delete("a"), TaskCommand.SetCompleted("a", true))) {
            var allocations = 0
            val allocate = { "plant-${++allocations}" }
            val failed = preparePlantOperation(null, initial, 25, allocate)
            val changed = updateTask(initial, command, start + 1)
            assertNull(changed.activeTask)
            assertNull(reconcilePendingPlant(failed, changed, 25))
            assertThrows(GroveRuleException::class.java) {
                preparePlantOperation(failed, changed, 25, allocate)
            }
            assertEquals(1, allocations)
            val selected = updateTask(changed, TaskCommand.Select("b"), start + 2)
            val replacement = preparePlantOperation(failed, selected, 25, allocate)
            assertEquals(PendingPlant("plant-2", "b", 25), replacement)
            assertEquals(2, allocations)
        }
    }

    @Test fun preparationValidatesSelectionDurationAndRunningSessionBeforeAllocation() {
        val eligible = seeded()
        val pending = PendingPlant("retry", "a", 25)
        val noSelection = eligible.copy(tasks = eligible.tasks.map { it.copy(isActive = false) })
        val completedTask = updateTask(eligible, TaskCommand.SetCompleted("a", true), start)
        val blankIdentity = eligible.copy(tasks = listOf(
            Task("", "Study", isActive = true, createdAt = start)
        ))
        val running = startSession(eligible, "live", "a", 25, start)
        val invalidInputs = listOf(
            GroveState() to 25,
            noSelection to 25,
            completedTask to 25,
            blankIdentity to 25,
            eligible to 0,
            eligible to 121,
            running to 25
        )
        var allocations = 0
        for ((state, minutes) in invalidInputs) {
            assertThrows(GroveRuleException::class.java) {
                preparePlantOperation(pending, state, minutes) {
                    allocations++
                    "unexpected"
                }
            }
        }
        assertEquals(0, allocations)
        assertNull(reconcilePendingPlant(pending, noSelection, 25))
        assertNull(reconcilePendingPlant(pending, eligible, 0))
        assertNull(reconcilePendingPlant(pending, eligible, 121))
    }

    @Test fun committedPendingIdentitiesCannotRestartSessions() {
        val initial = seeded()
        val pending = PendingPlant("committed", "a", 1)
        val running = startSession(initial, pending.sessionId, pending.taskId,
            pending.durationMinutes, start)
        var allocations = 0
        assertNull(reconcilePendingPlant(pending, running, 1))
        assertThrows(GroveRuleException::class.java) {
            preparePlantOperation(pending, running, 1) {
                allocations++
                "blocked"
            }
        }
        assertEquals(0, allocations)
        val terminalStates = listOf(
            resolveSession(running, pending.sessionId, false, start + 60_000),
            resolveSession(running, pending.sessionId, true, start + 1_000)
        )
        for (terminal in terminalStates) {
            assertNull(reconcilePendingPlant(pending, terminal, 1))
            assertEquals(terminal, startSession(terminal, pending.sessionId, pending.taskId,
                pending.durationMinutes, start + 120_000))
            assertThrows(GroveRuleException::class.java) {
                preparePlantOperation(pending, terminal, 1) { pending.sessionId }
            }
            val replacement = preparePlantOperation(pending, terminal, 1) {
                "fresh-${++allocations}"
            }
            val next = startSession(terminal, replacement.sessionId, replacement.taskId,
                replacement.durationMinutes, start + 120_000)
            assertEquals(replacement.sessionId, next.runningSession?.id)
            assertEquals(terminal.sessions.single(), next.sessions.first())
            assertEquals(terminal.trees, next.trees)
            assertEquals(2, next.sessions.size)
        }
        assertEquals(2, allocations)
    }

    @Test fun unrelatedEditsRetainPendingIdentityButInvalidReplacementIdsAreRejected() {
        val initial = seeded()
        val pending = PendingPlant("retry", "a", 25)
        val renamed = updateTask(initial, TaskCommand.Rename("a", "Organic chemistry"), start)
        val changedGoal = saveGoal(renamed, "90", start)
        assertSame(pending, reconcilePendingPlant(pending, changedGoal, 25))
        assertSame(pending, preparePlantOperation(pending, changedGoal, 25) {
            fail("Unchanged intent must not allocate another identity")
            "unexpected"
        })
        for (invalidId in listOf("", "  ", pending.sessionId)) {
            var allocations = 0
            assertThrows(GroveRuleException::class.java) {
                preparePlantOperation(pending, changedGoal, 10) {
                    allocations++
                    invalidId
                }
            }
            assertEquals(1, allocations)
        }
        assertNull(reconcilePendingPlant(pending.copy(sessionId = " "), initial, 25))
    }

    @Test fun calendarRangesRespectDstAndExclusiveEnds() {
        val zone = ZoneId.of("America/New_York")
        val spring = periodRange(PeriodType.DAY, 0, LocalDate.of(2026, 3, 8), zone)
        val fall = periodRange(PeriodType.DAY, 0, LocalDate.of(2026, 11, 1), zone)
        assertEquals(23 * 3_600_000L, spring.endMillis - spring.startMillis)
        assertEquals(25 * 3_600_000L, fall.endMillis - fall.startMillis)
        assertTrue(spring.contains(spring.startMillis))
        assertFalse(spring.contains(spring.endMillis))
        assertEquals(today.minusDays(2), periodRange(PeriodType.WEEK, 0, today, utc).startDate)
        assertEquals(today, periodRange(PeriodType.DAY, 3, today, utc).startDate)
        assertEquals(LocalDate.of(2026, 9, 1),
            periodRange(PeriodType.MONTH, -1, today, utc).startDate)
    }

    @Test fun aggregationUsesRealCompletedBucketsAndTaskIdentity() {
        var state = updateTask(seeded(), TaskCommand.Add("Chemistry", "b"), start)
        state = completed(state, "one", today, 20)
        state = completed(state, "two", today, 30, "b")
        state = completed(state, "old", today.minusDays(1), 15)
        val summary = summarize(state, periodRange(PeriodType.DAY, 0, today, utc), utc)
        assertEquals(50, summary.totalMinutes)
        assertEquals(2, summary.completedSessionCount)
        assertEquals(listOf(30, 20), summary.minutesByTask.map { it.second })
        assertEquals(50, summary.minutesByBucket.sumOf { it.second })
        assertTrue(summarize(state,
            periodRange(PeriodType.DAY, -2, today, utc), utc).isEmpty)
    }

    @Test fun goalsValidateAndStreakCountsEachDayOnce() {
        var state = seeded()
        for (draft in listOf("0", "1441", "abc", "1.5", "")) {
            assertThrows(GroveRuleException::class.java) { saveGoal(state, draft, start) }
        }
        assertEquals(state, saveGoal(state, "60", start + 1))
        assertEquals(90, saveGoal(state, "90", start).dailyGoal.goalMinutes)
        state = completed(state, "yesterday", today.minusDays(1), 60)
        state = completed(state, "first", today, 30)
        assertEquals(1, goalProgress(state, today, utc).streakDays)
        state = completed(state, "second", today, 30)
        assertEquals(2, goalProgress(state, today, utc).streakDays)
        state = completed(state, "extra", today, 10)
        assertEquals(2, goalProgress(state, today, utc).streakDays)
        assertTrue(goalProgress(state, today, utc).isMet)
        assertEquals(0, goalProgress(state, today.plusDays(2), utc).streakDays)
    }

    private class RecordingPlayback : AmbientPlaybackPort {
        val entered = CompletableDeferred<SoundLoop>()
        val prepared = CompletableDeferred<Unit>()
        val events = CopyOnWriteArrayList<String>()
        var startFailure: Exception? = null

        override suspend fun prepare(loop: SoundLoop) {
            events += "prepare:$loop"
            entered.complete(loop)
            prepared.await()
            events += "prepared"
        }
        override fun setLooping(looping: Boolean) { events += "loop:$looping" }
        override fun setVolume(volume: Float) { events += "volume:$volume" }
        override fun start() {
            events += "start"
            startFailure?.let { throw it }
        }
        override fun pause() { events += "pause" }
        override fun release() { events += "release" }
    }

    @Test fun wavHeadersDescribeActualBoundedNonSilentDistinctPcm() {
        val encoded = mutableListOf<ByteArray>()
        for (loop in listOf(SoundLoop.RAIN, SoundLoop.WIND, SoundLoop.FOREST)) {
            val bytes = ByteArrayOutputStream()
            var largestWrite = 0
            var writes = 0
            val output = object : java.io.OutputStream() {
                override fun write(value: Int) {
                    fail("Encoder must write bounded blocks, not individual bytes")
                }
                override fun write(block: ByteArray, offset: Int, length: Int) {
                    largestWrite = maxOf(largestWrite, length)
                    writes++
                    bytes.write(block, offset, length)
                }
            }
            AmbientWavEncoder.encode(loop, output)
            val wav = bytes.toByteArray()
            encoded += wav
            fun text(offset: Int, count: Int) =
                String(wav, offset, count, Charsets.US_ASCII)
            fun little(offset: Int, count: Int): Long {
                var value = 0L
                repeat(count) { value = value or
                    ((wav[offset + it].toLong() and 255L) shl (it * 8)) }
                return value
            }
            assertEquals("RIFF", text(0, 4))
            assertEquals("WAVE", text(8, 4))
            assertEquals("fmt ", text(12, 4))
            assertEquals("data", text(36, 4))
            assertEquals(wav.size.toLong() - 8, little(4, 4))
            assertEquals(16L, little(16, 4))
            assertEquals(1L, little(20, 2))
            assertEquals(1L, little(22, 2))
            assertEquals(AmbientWavEncoder.SAMPLE_RATE.toLong(), little(24, 4))
            assertEquals(AmbientWavEncoder.SAMPLE_RATE * 2L, little(28, 4))
            assertEquals(2L, little(32, 2))
            assertEquals(16L, little(34, 2))
            assertEquals(AmbientWavEncoder.DATA_BYTES.toLong(), little(40, 4))
            assertEquals(44 + AmbientWavEncoder.DATA_BYTES, wav.size)
            assertEquals(AmbientWavEncoder.SAMPLE_RATE * AmbientWavEncoder.DURATION_SECONDS,
                (wav.size - 44) / 2)
            assertTrue(largestWrite <= 4096)
            assertTrue(writes > 1)
            assertTrue(writes < 100)
            var energy = 0L
            var peak = 0
            var first = 0
            var last = 0
            for (offset in 44 until wav.size step 2) {
                val sample = little(offset, 2).toShort().toInt()
                if (offset == 44) first = sample
                last = sample
                peak = maxOf(peak, kotlin.math.abs(sample))
                energy += sample.toLong() * sample
            }
            assertTrue("$loop must be audible PCM", energy > 0)
            assertTrue("$loop must avoid clipping", peak in 1..27852)
            assertEquals(0, first)
            assertEquals(0, last)
        }
        for (i in encoded.indices) for (j in 0 until i) {
            assertFalse("Loops must contain distinct samples", encoded[i].contentEquals(encoded[j]))
        }
        val repeated = ByteArrayOutputStream()
        AmbientWavEncoder.encode(SoundLoop.RAIN, repeated)
        assertArrayEquals(encoded.first(), repeated.toByteArray())
    }

    @Test fun wavEncodingRejectsNoneAndHonorsCancellationBetweenBlocks() {
        val bytes = ByteArrayOutputStream()
        assertThrows(IllegalArgumentException::class.java) {
            AmbientWavEncoder.encode(SoundLoop.NONE, bytes)
        }
        assertEquals(0, bytes.size())
        var checks = 0
        assertThrows(CancellationException::class.java) {
            AmbientWavEncoder.encode(SoundLoop.RAIN, bytes) {
                checks++
                if (checks == 3) throw CancellationException("shutdown")
            }
        }
        assertEquals(3, checks)
        assertEquals(44 + 4096, bytes.size())
    }

    @Test fun playbackStartsOnlyAfterPreparationWithLoopAndLatestVolume() = runBlocking {
        withTimeout(5000) {
            val port = RecordingPlayback()
            val player = AmbientPlayer { port }
            try {
                player.setVolume(0.2f)
                val selection = async { player.select(SoundLoop.RAIN) }
                assertEquals(SoundLoop.RAIN, port.entered.await())
                assertEquals(listOf("prepare:RAIN"), port.events.toList())
                player.setVolume(0.8f)
                port.prepared.complete(Unit)
                selection.await()
                assertEquals(listOf("prepare:RAIN", "prepared", "loop:true", "volume:0.8", "start"),
                    port.events.toList())
                player.pause()
                assertEquals("pause", port.events.last())
                player.setVolume(2f)
                player.resume()
                assertEquals(listOf("volume:1.0", "volume:1.0", "start"), port.events.takeLast(3))
                player.setVolume(-1f)
                assertEquals("volume:0.0", port.events.last())
                player.setVolume(Float.NaN)
                assertEquals("volume:0.5", port.events.last())
            } finally { player.close() }
            assertEquals("release", port.events.last())
            assertEquals(1, port.events.count { it == "release" })
        }
    }

    @Test fun cancelledSelectionReleasesCandidateWhenNonCancellablePreparationReturns() = runBlocking {
        withTimeout(5000) {
            val recording = RecordingPlayback()
            val port = object : AmbientPlaybackPort by recording {
                override suspend fun prepare(loop: SoundLoop) {
                    // Model platform preparation that returns despite caller cancellation.
                    // Keeping the dispatcher unchanged lets the cancelled context return
                    // to production select(), where installation must check cancellation.
                    withContext(NonCancellable) {
                        recording.prepare(loop)
                    }
                }
            }
            val player = AmbientPlayer { port }
            val selection = async { player.select(SoundLoop.RAIN) }
            try {
                assertEquals(SoundLoop.RAIN, recording.entered.await())
                assertEquals(listOf("prepare:RAIN"), recording.events.toList())
                assertFalse(recording.prepared.isCompleted)

                // Cancel while preparation owns the candidate, then explicitly
                // release the barrier. Do not pause/close: those would invalidate
                // generation independently and conceal a missing cancellation check.
                selection.cancel()
                assertTrue(selection.isCancelled)
                assertFalse(selection.isCompleted)
                recording.prepared.complete(Unit)
                selection.join()

                assertTrue(selection.isCancelled)
                assertEquals(listOf("prepare:RAIN", "prepared", "release"),
                    recording.events.toList())
                player.resume()
                assertFalse(recording.events.contains("start"))
                assertEquals(1, recording.events.count { it == "release" })
            } finally {
                recording.prepared.complete(Unit)
                selection.cancelAndJoin()
                player.close()
            }
            assertFalse(recording.events.contains("start"))
            assertEquals(1, recording.events.count { it == "release" })
        }
    }

    @Test fun pauseDuringPreparationVetoesLateStartAndReleasesCandidate() = runBlocking {
        withTimeout(5000) {
            val port = RecordingPlayback()
            val player = AmbientPlayer { port }
            try {
                val selection = async { runCatching { player.select(SoundLoop.WIND) } }
                port.entered.await()
                player.pause()
                port.prepared.complete(Unit)
                assertTrue(selection.await().exceptionOrNull() is CancellationException)
                player.resume()
                assertFalse(port.events.contains("start"))
                assertEquals(1, port.events.count { it == "release" })
            } finally { player.close() }
        }
    }

    @Test fun replacementOwnsPlaybackEvenWhenOldPreparationReturnsLast() = runBlocking {
        withTimeout(5000) {
            val old = RecordingPlayback()
            val latest = RecordingPlayback()
            var created = 0
            val player = AmbientPlayer { if (created++ == 0) old else latest }
            try {
                val first = async { runCatching { player.select(SoundLoop.RAIN) } }
                old.entered.await()
                val second = async { player.select(SoundLoop.FOREST) }
                assertEquals(SoundLoop.FOREST, latest.entered.await())
                latest.prepared.complete(Unit)
                second.await()
                assertEquals("start", latest.events.last())
                // The first prepare remains suspended until the replacement owns playback.
                old.prepared.complete(Unit)
                assertTrue(first.await().exceptionOrNull() is CancellationException)
                assertFalse(old.events.contains("start"))
                assertEquals(1, old.events.count { it == "release" })
                assertFalse(latest.events.contains("release"))
                assertFalse(latest.events.contains("pause"))
                player.select(SoundLoop.NONE)
                assertEquals(1, latest.events.count { it == "release" })
                assertEquals(2, created)
            } finally { player.close() }
        }
    }

    @Test fun installedPlayerIsReleasedBeforeReplacementPreparation() = runBlocking {
        withTimeout(5000) {
            val first = RecordingPlayback()
            val second = RecordingPlayback()
            var created = 0
            val player = AmbientPlayer { if (created++ == 0) first else second }
            try {
                first.prepared.complete(Unit)
                player.select(SoundLoop.RAIN)
                val replacement = async { player.select(SoundLoop.WIND) }
                second.entered.await()
                assertEquals("release", first.events.last())
                assertFalse(second.events.contains("start"))
                second.prepared.complete(Unit)
                replacement.await()
            } finally { player.close() }
            assertEquals(1, first.events.count { it == "release" })
            assertEquals(1, second.events.count { it == "release" })
        }
    }

    @Test fun preparationAndStartFailuresPropagateReleaseAndAllowRetry() = runBlocking {
        withTimeout(5000) {
            for (failPreparation in listOf(true, false)) {
                val broken = RecordingPlayback()
                val recovered = RecordingPlayback()
                val failure = IllegalStateException("audio unavailable")
                if (!failPreparation) broken.startFailure = failure
                var created = 0
                val player = AmbientPlayer { if (created++ == 0) broken else recovered }
                try {
                    val selection = async { runCatching { player.select(SoundLoop.RAIN) } }
                    broken.entered.await()
                    if (failPreparation) broken.prepared.completeExceptionally(failure)
                    else broken.prepared.complete(Unit)
                    val propagated = selection.await().exceptionOrNull()
                    // Coroutine stack-trace recovery may copy the exception.
                    assertEquals(failure.javaClass, propagated?.javaClass)
                    assertEquals(failure.message, propagated?.message)
                    assertEquals(1, broken.events.count { it == "release" })
                    if (failPreparation) assertFalse(broken.events.contains("start"))
                    recovered.prepared.complete(Unit)
                    player.select(SoundLoop.FOREST)
                    assertEquals("start", recovered.events.last())
                } finally { player.close() }
                assertEquals(1, recovered.events.count { it == "release" })
            }
        }
    }

    @Test fun shutdownDuringLoadingAndCoroutineCancellationCannotStartAudio() = runBlocking {
        withTimeout(5000) {
            for (shutdown in listOf(true, false)) {
                val port = RecordingPlayback()
                val player = AmbientPlayer { port }
                try {
                    val selection = async { runCatching { player.select(SoundLoop.RAIN) } }
                    port.entered.await()
                    if (shutdown) {
                        player.close()
                        port.prepared.complete(Unit)
                        assertTrue(selection.await().exceptionOrNull() is CancellationException)
                        assertThrows(IllegalStateException::class.java) { player.resume() }
                        val rejected = runCatching { player.select(SoundLoop.WIND) }
                        assertTrue(rejected.exceptionOrNull() is IllegalStateException)
                    } else {
                        selection.cancelAndJoin()
                        port.prepared.complete(Unit)
                    }
                    assertFalse(port.events.contains("start"))
                    assertEquals(1, port.events.count { it == "release" })
                } finally { player.close() }
                assertEquals(1, port.events.count { it == "release" })
            }
        }
    }
}
