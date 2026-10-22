package generated

import org.json.JSONObject

/** Editor-only serialization. Durable sessions remain the authority for results. */
object GroveEditorCodec {
    fun encode(state: RestorableUiState): String {
        val d = state.drafts
        return JSONObject().apply {
            put("version", 1)
            put("primary", encodeRoute(state.navigation.primary))
            state.navigation.subRoute?.let { put("subRoute", encodeRoute(it)) }
            put("quick", d.quickTask)
            put("new", d.newTask)
            put("goal", d.goal)
            put("renameId", d.renameTaskId)
            put("rename", d.renameText)
            put("duration", d.durationMinutes)
            put("selectedTaskId", d.selectedTaskId)
            d.pendingPlant?.let { pending ->
                put("pending", JSONObject().apply {
                    put("sessionId", pending.sessionId)
                    put("taskId", pending.taskId)
                    put("durationMinutes", pending.durationMinutes)
                })
            }
            put("statsType", state.statsPeriodType.name)
            put("statsIndex", state.statsPeriodIndex)
            put("giveUp", state.showGiveUpDialog)
            put("deleteTaskId", state.deleteTaskId)
            put("unsaved", state.showUnsavedDialog)
            state.terminalResult?.let { put("resultId", it.sessionId) }
        }.toString()
    }

    fun decode(raw: String?, persisted: GroveState): RestorableUiState {
        val j = runCatching { JSONObject(raw ?: "{}") }.getOrElse { JSONObject() }
        val result = j.optional("resultId")?.let { id ->
            persisted.sessions.firstOrNull { it.id == id && it.isTerminal }?.let { session ->
                session.endedAt?.let { ended ->
                    when (session.status) {
                        SessionStatus.COMPLETED -> persisted.trees.firstOrNull {
                            it.sessionId == id && it.collectedAt == ended
                        }?.let { TerminalResult(id, session.status, ended, it.id) }
                        SessionStatus.ABANDONED -> TerminalResult(id, session.status, ended)
                        SessionStatus.RUNNING -> null
                    }
                }
            }
        }
        val restoredNavigation = if (j.optJSONObject("primary") != null) {
            AppNavState(
                decodeRoute(j.getJSONObject("primary")),
                j.optJSONObject("subRoute")?.let(::decodeRoute)
            )
        } else {
            // Accept the editor format written before this codec was extracted.
            AppNavState(when (j.text("route", "home")) {
                "forest" -> Route.Forest(period(j, "forestType", PeriodType.DAY),
                    index(j, "forestIndex"))
                "tasks" -> Route.TasksGoal()
                "stats" -> Route.Stats
                else -> Route.Home
            })
        }
        val navigation = when {
            result != null -> AppNavState(Route.Home)
            persisted.runningSession != null -> AppNavState(Route.Session)
            restoredNavigation.current == Route.Session -> AppNavState(Route.Home)
            else -> restoredNavigation
        }
        val savedDuration = j.opt("duration")?.toString()?.toIntOrNull()
        val duration = (savedDuration ?: 25).coerceIn(1, 120)
        val selectedTaskId = j.optional("selectedTaskId")
        // Legacy ID-only records cannot establish the intent of a retry. Read
        // only a complete, typed payload, then apply the same production rules
        // used before planting against committed tasks and session history.
        val pending = j.optJSONObject("pending")?.let { payload ->
            val sessionId = payload.optional("sessionId") ?: return@let null
            val taskId = payload.optional("taskId") ?: return@let null
            val rawMinutes = payload.opt("durationMinutes")
            if (rawMinutes !is Number) return@let null
            val minutes = rawMinutes.toString().toIntOrNull() ?: return@let null
            if (minutes !in 1..120 || savedDuration == null ||
                savedDuration !in 1..120 ||
                (selectedTaskId != null && selectedTaskId != taskId)) return@let null
            reconcilePendingPlant(
                PendingPlant(sessionId, taskId, minutes), persisted, duration
            )
        }
        return RestorableUiState(
            navigation = navigation,
            drafts = EditorDrafts(
                quickTask = j.text("quick"),
                newTask = j.text("new"),
                goal = j.text("goal", persisted.dailyGoal.goalMinutes.toString()),
                renameTaskId = j.optional("renameId"),
                renameText = j.text("rename"),
                durationMinutes = duration,
                selectedTaskId = selectedTaskId,
                pendingPlant = pending
            ),
            statsPeriodType = period(j, "statsType", PeriodType.WEEK),
            statsPeriodIndex = index(j, "statsIndex"),
            showGiveUpDialog = result == null && persisted.runningSession != null &&
                j.opt("giveUp") == true,
            deleteTaskId = j.optional("deleteTaskId")?.takeIf { id ->
                persisted.tasks.any { it.id == id }
            },
            showUnsavedDialog = result == null && j.opt("unsaved") == true,
            terminalResult = result
        )
    }

    private fun encodeRoute(route: Route): JSONObject = JSONObject().apply {
        put("kind", when (route) {
            Route.Home -> "home"
            Route.Session -> "session"
            Route.Stats -> "stats"
            is Route.Forest -> "forest"
            is Route.TasksGoal -> "tasks"
        })
        if (route is Route.Forest) {
            put("type", route.periodType.name)
            put("index", route.periodIndex)
        }
        if (route is Route.TasksGoal) put("tab", route.initialTab.name)
    }

    private fun decodeRoute(j: JSONObject): Route = when (j.text("kind")) {
        "session" -> Route.Session
        "stats" -> Route.Stats
        "forest" -> Route.Forest(period(j, "type", PeriodType.DAY), index(j, "index"))
        "tasks" -> Route.TasksGoal(SettingsTab.entries.firstOrNull {
            it.name == j.text("tab")
        } ?: SettingsTab.TASKS)
        else -> Route.Home
    }

    private fun period(j: JSONObject, key: String, fallback: PeriodType): PeriodType =
        PeriodType.entries.firstOrNull { it.name == j.text(key) } ?: fallback

    // Bound corrupt offsets before calendar arithmetic and previous-period paging.
    private fun index(j: JSONObject, key: String): Int =
        integer(j, key, 0).coerceIn(-10_000, 0)

    private fun integer(j: JSONObject, key: String, fallback: Int): Int =
        j.opt(key)?.toString()?.toIntOrNull() ?: fallback

    private fun JSONObject.text(key: String, fallback: String = ""): String =
        opt(key) as? String ?: fallback

    private fun JSONObject.optional(key: String): String? =
        (opt(key) as? String)?.takeIf { it.isNotBlank() && it != "null" }
}
