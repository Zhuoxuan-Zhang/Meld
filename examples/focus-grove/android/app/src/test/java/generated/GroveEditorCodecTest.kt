package generated

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GroveEditorCodecTest {
    private val completed = Session("done", "task", 1, SessionStatus.COMPLETED, 0L, 60_000L)
    private val abandoned = Session("given-up", "task", 1, SessionStatus.ABANDONED, 0L, 10_000L)
    private val tree = Tree("tree:done", "done", 60_000L)
    private val history = GroveState(sessions = listOf(completed, abandoned), trees = listOf(tree))

    private fun roundTrip(ui: RestorableUiState, state: GroveState = history) =
        GroveEditorCodec.decode(GroveEditorCodec.encode(ui), state)

    @Test fun unfinishedEditorAndOperationIdentityRoundTrip() {
        val state = history.copy(tasks = listOf(Task("task", "Study", isActive = true, createdAt = 0L)))
        val ui = RestorableUiState(
            navigation = AppNavState(Route.TasksGoal(SettingsTab.STATS), Route.Stats),
            drafts = EditorDrafts(
                quickTask = "未完成\n\"draft\"", newTask = "Essay", goal = "invalid",
                renameTaskId = "task", renameText = "New name", durationMinutes = 119,
                selectedTaskId = "task", pendingPlant = PendingPlant("retry-same-id", "task", 119)
            ),
            statsPeriodType = PeriodType.MONTH, statsPeriodIndex = -12,
            deleteTaskId = "task", showUnsavedDialog = true
        )
        assertEquals(ui, roundTrip(ui, state))
        val forest = ui.copy(navigation = AppNavState(Route.Forest(PeriodType.YEAR, -3)))
        assertEquals(forest, roundTrip(forest, state))
    }

    @Test fun terminalResultsUseDurableRecordsAndSelectHome() {
        for (session in listOf(completed, abandoned)) {
            val ui = RestorableUiState(
                navigation = AppNavState(Route.Forest(), Route.Stats),
                showGiveUpDialog = true, showUnsavedDialog = true,
                // Saved metadata is deliberately stale; only identity is authoritative.
                terminalResult = TerminalResult(session.id, SessionStatus.ABANDONED, 1L)
            )
            val restored = roundTrip(ui)
            assertEquals(AppNavState(Route.Home), restored.navigation)
            assertEquals(TerminalResult(session.id, session.status, session.endedAt!!,
                if (session == completed) tree.id else null), restored.terminalResult)
            assertFalse(restored.showGiveUpDialog)
            assertFalse(restored.showUnsavedDialog)
            assertEquals(restored, roundTrip(restored))
        }
        assertEquals(2, history.sessions.size)
        assertEquals(listOf(tree), history.trees)
    }

    @Test fun staleRunningAndIncompleteResultsAreRejected() {
        val raw = GroveEditorCodec.encode(RestorableUiState(
            terminalResult = TerminalResult("done", SessionStatus.COMPLETED, 60_000L, tree.id)
        ))
        val running = completed.copy(status = SessionStatus.RUNNING, endedAt = null)
        val cases = listOf(
            GroveState(),
            history.copy(trees = emptyList()),
            history.copy(trees = listOf(tree.copy(collectedAt = 59_999L))),
            history.copy(sessions = listOf(completed.copy(endedAt = null))),
            history.copy(sessions = listOf(running), trees = emptyList())
        )
        for (state in cases) {
            val restored = GroveEditorCodec.decode(raw, state)
            assertNull(restored.terminalResult)
            assertEquals(if (state.runningSession != null) Route.Session else Route.Home,
                restored.navigation.current)
        }
    }

    @Test fun acknowledgementDoesNotResurrectHistoricalResult() {
        val visible = roundTrip(RestorableUiState(
            terminalResult = TerminalResult("done", SessionStatus.COMPLETED, 60_000L, tree.id)
        ))
        val acknowledged = visible.copy(terminalResult = null)
        assertNull(roundTrip(acknowledged).terminalResult)
        assertEquals(history, history.copy())
    }

    @Test fun malformedFieldsFallBackAndCalendarOffsetsAreBounded() {
        val saved = GroveState(dailyGoal = DailyGoal(goalMinutes = 90))
        for (raw in listOf(null, "", "{broken", "[]")) {
            val restored = GroveEditorCodec.decode(raw, saved)
            assertEquals(EditorDrafts(goal = "90"), restored.drafts)
            assertEquals(AppNavState(), restored.navigation)
            assertNull(restored.terminalResult)
        }
        val restored = GroveEditorCodec.decode("""{
            "primary":{"kind":"forest","type":"UNKNOWN","index":2147483647},
            "duration":0,"goal":false,"pending":null,"renameId":"null",
            "statsType":"BAD","statsIndex":-2147483648,"deleteTaskId":"missing"
        }""", saved)
        assertEquals(Route.Forest(PeriodType.DAY, 0), restored.navigation.current)
        assertEquals(1, restored.drafts.durationMinutes)
        assertEquals("90", restored.drafts.goal)
        assertNull(restored.drafts.pendingPlant)
        assertNull(restored.drafts.renameTaskId)
        assertNull(restored.deleteTaskId)
        assertEquals(PeriodType.WEEK, restored.statsPeriodType)
        assertEquals(-10_000, restored.statsPeriodIndex)
        assertEquals(120, roundTrip(RestorableUiState(
            drafts = EditorDrafts(durationMinutes = 999), statsPeriodIndex = 5
        )).drafts.durationMinutes)
        assertEquals(0, roundTrip(RestorableUiState(statsPeriodIndex = 5)).statsPeriodIndex)
    }

    private fun eligibleState(): GroveState = history.copy(tasks = listOf(
        Task("task", "Study", isActive = true, createdAt = 0L),
        Task("other", "Math", createdAt = 1L)
    ))

    private fun pendingUi(): RestorableUiState = RestorableUiState(
        navigation = AppNavState(Route.TasksGoal(), Route.Stats),
        drafts = EditorDrafts(
            quickTask = "Unfinished reading", newTask = "Essay", goal = "invalid",
            renameTaskId = "task", renameText = "Renamed study",
            durationMinutes = 25, selectedTaskId = "task",
            pendingPlant = PendingPlant("retry", "task", 25)
        ),
        statsPeriodType = PeriodType.MONTH, statsPeriodIndex = -2,
        showUnsavedDialog = true
    )

    @Test fun completePendingPayloadIsEncodedAndRestoredRetryReusesIdentity() {
        val state = eligibleState()
        val ui = pendingUi()
        val encoded = GroveEditorCodec.encode(ui)
        val payload = JSONObject(encoded).getJSONObject("pending")
        assertEquals("retry", payload.getString("sessionId"))
        assertEquals("task", payload.getString("taskId"))
        assertEquals(25, payload.getInt("durationMinutes"))
        val restored = GroveEditorCodec.decode(encoded, state)
        assertEquals(ui, restored)
        val pending = requireNotNull(restored.drafts.pendingPlant)
        var allocations = 0
        val prepared = preparePlantOperation(pending, state, restored.drafts.durationMinutes) {
            allocations++
            "unexpected"
        }
        assertSame(pending, prepared)
        assertEquals(0, allocations)
        val started = startSession(state, prepared.sessionId, prepared.taskId,
            prepared.durationMinutes, 100_000L)
        assertEquals("retry", started.runningSession?.id)
        assertEquals("task", started.runningSession?.taskId)
        assertEquals(25, started.runningSession?.durationMinutes)
        assertEquals(state.sessions.size + 1, started.sessions.size)
        assertEquals(state.trees, started.trees)
    }

    @Test fun stalePendingPayloadsAreDiscardedAgainstCurrentTasksAndDuration() {
        val state = eligibleState()
        val ui = pendingUi()
        val selectedOther = updateTask(state, TaskCommand.Select("other"), 2L)
        val cases = listOf(
            ui.copy(drafts = ui.drafts.copy(durationMinutes = 10)) to state,
            ui.copy(drafts = ui.drafts.copy(selectedTaskId = "other")) to state,
            ui to selectedOther,
            ui to updateTask(state, TaskCommand.Delete("task"), 2L),
            ui to updateTask(state, TaskCommand.SetCompleted("task", true), 2L),
            ui to state.copy(tasks = state.tasks.map { it.copy(isActive = false) }),
            ui to GroveState()
        )
        for ((editor, committed) in cases) {
            val restored = roundTrip(editor, committed)
            assertEquals(editor.copy(drafts = editor.drafts.copy(pendingPlant = null)), restored)
        }
    }

    @Test fun restoredChangedIntentAllocatesReplacementAndStartsCurrentPayload() {
        val ui = pendingUi().copy(drafts = pendingUi().drafts.copy(
            selectedTaskId = "other", durationMinutes = 10
        ))
        val state = updateTask(eligibleState(), TaskCommand.Select("other"), 2L)
        val restored = roundTrip(ui, state)
        assertNull(restored.drafts.pendingPlant)
        var allocations = 0
        val prepared = preparePlantOperation(restored.drafts.pendingPlant, state,
            restored.drafts.durationMinutes) {
            allocations++
            "replacement"
        }
        assertEquals(PendingPlant("replacement", "other", 10), prepared)
        assertEquals(1, allocations)
        val started = startSession(state, prepared.sessionId, prepared.taskId,
            prepared.durationMinutes, 100_000L)
        assertEquals("other", started.runningSession?.taskId)
        assertEquals(10, started.runningSession?.durationMinutes)
        assertFalse(started.sessions.any { it.id == "retry" })
    }

    @Test fun committedPendingIdentitiesAreDiscardedForEverySessionStatus() {
        val ui = pendingUi()
        val running = startSession(eligibleState(), "retry", "task", 25, 100_000L)
        val states = listOf(
            running,
            resolveSession(running, "retry", false, 1_600_000L),
            resolveSession(running, "retry", true, 101_000L)
        )
        for (state in states) {
            val restored = roundTrip(ui, state)
            assertNull(restored.drafts.pendingPlant)
            assertEquals(ui.drafts.copy(pendingPlant = null), restored.drafts)
            assertEquals(if (state.runningSession != null) AppNavState(Route.Session)
                else ui.navigation, restored.navigation)
            assertNull(restored.terminalResult)
            assertEquals(state, startSession(state, "retry", "task", 25, 2_000_000L))
        }
    }

    @Test fun malformedAndLegacyPendingRecordsDoNotLoseOtherEditorFields() {
        val ui = pendingUi()
        val state = eligibleState()
        val expected = ui.copy(drafts = ui.drafts.copy(pendingPlant = null))
        val malformed = listOf(
            "null", "\"retry\"", "[]", "{}",
            """{"sessionId":"retry","taskId":"task"}""",
            """{"sessionId":"retry","durationMinutes":25}""",
            """{"taskId":"task","durationMinutes":25}""",
            """{"sessionId":" ","taskId":"task","durationMinutes":25}""",
            """{"sessionId":17,"taskId":"task","durationMinutes":25}""",
            """{"sessionId":"retry","taskId":false,"durationMinutes":25}""",
            """{"sessionId":"retry","taskId":"task","durationMinutes":"25"}""",
            """{"sessionId":"retry","taskId":"task","durationMinutes":25.5}""",
            """{"sessionId":"retry","taskId":"task","durationMinutes":false}""",
            """{"sessionId":"retry","taskId":"task","durationMinutes":null}""",
            """{"sessionId":"retry","taskId":"task","durationMinutes":0}""",
            """{"sessionId":"retry","taskId":"task","durationMinutes":121}""",
            """{"sessionId":"retry","taskId":"task","durationMinutes":2147483648}"""
        )
        for (payload in malformed) {
            val document = JSONObject(GroveEditorCodec.encode(ui))
            document.put("pending", JSONObject("""{"value":$payload}""").get("value"))
            assertEquals("Pending payload: $payload", expected,
                GroveEditorCodec.decode(document.toString(), state))
        }
        val legacy = JSONObject(GroveEditorCodec.encode(ui))
        legacy.remove("pending")
        legacy.put("pendingSessionId", "retry")
        assertEquals(expected, GroveEditorCodec.decode(legacy.toString(), state))
        // The pre-extraction navigation format remains readable with ID-only pending data.
        legacy.remove("primary")
        legacy.remove("subRoute")
        legacy.put("route", "forest")
        legacy.put("forestType", "YEAR")
        legacy.put("forestIndex", -3)
        legacy.put("pending", "retry")
        assertEquals(expected.copy(navigation = AppNavState(Route.Forest(PeriodType.YEAR, -3))),
            GroveEditorCodec.decode(legacy.toString(), state))
    }

    @Test fun absentOrInvalidSavedDurationCannotRestorePendingIntent() {
        val ui = pendingUi()
        for (duration in listOf(null, JSONObject.NULL, "bad", 0, 121, 25.5)) {
            val document = JSONObject(GroveEditorCodec.encode(ui))
            if (duration == null) document.remove("duration") else document.put("duration", duration)
            val restored = GroveEditorCodec.decode(document.toString(), eligibleState())
            assertNull("Saved duration: $duration", restored.drafts.pendingPlant)
            assertEquals(ui.drafts.quickTask, restored.drafts.quickTask)
            assertEquals(ui.drafts.newTask, restored.drafts.newTask)
            assertEquals(ui.drafts.goal, restored.drafts.goal)
            assertEquals(ui.navigation, restored.navigation)
        }
    }

    @Test fun runningSessionRestoresConfirmationButOrphanSessionRouteReturnsHome() {
        val ui = RestorableUiState(navigation = AppNavState(Route.Session), showGiveUpDialog = true)
        val running = GroveState(sessions = listOf(Session("live", "task", 25, startedAt = 0L)))
        assertEquals(ui, roundTrip(ui, running))
        val orphan = roundTrip(ui, GroveState())
        assertEquals(Route.Home, orphan.navigation.current)
        assertFalse(orphan.showGiveUpDialog)
    }
}
