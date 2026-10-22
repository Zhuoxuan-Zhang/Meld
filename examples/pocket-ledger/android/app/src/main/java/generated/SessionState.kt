package generated

import java.time.LocalDate
import java.time.YearMonth
import org.json.JSONArray
import org.json.JSONObject

data class DraftSession(
    val current: TransactionDraft,
    val original: TransactionDraft,
    val isSandbox: Boolean
)

data class BudgetDraft(
    val categoryId: String,
    val limitText: String,
    val originalLimitText: String
)

data class SavedSession(
    val navigation: AppNavState,
    val draft: DraftSession?,
    val budget: BudgetDraft?,
    val pendingOperationId: String?,
    val scrollPositions: Map<String, Pair<Int, Int>>
)

data class AppUiState(
    val snapshot: LedgerSnapshot?,
    val session: SavedSession,
    val loading: Boolean,
    val pending: Boolean,
    val error: String?,
    val deleteTargetId: String?,
    val showUnsavedDialog: Boolean,
    val showThemePicker: Boolean,
    val feedback: String?
)

sealed interface AppEvent {
    data class SelectSection(val section: PrimarySection) : AppEvent
    data class ShiftMonth(val delta: Int) : AppEvent
    data class Open(val route: DetailRoute) : AppEvent
    data class ChangeDraft(val draft: TransactionDraft) : AppEvent
    data class ChangeLimit(val text: String) : AppEvent
    data class RequestDelete(val transactionId: String) : AppEvent
    data class PickAccent(val token: String) : AppEvent
    data object Save : AppEvent
    data object Record : AppEvent
    data object ConfirmDelete : AppEvent
    data object DismissDelete : AppEvent
    data object Back : AppEvent
    data object Cancel : AppEvent
    data object KeepEditing : AppEvent
    data object Discard : AppEvent
    data object Retry : AppEvent
    data object OpenTheme : AppEvent
    data object CloseTheme : AppEvent
    data object FeedbackConsumed : AppEvent
}

/** Compare editable values, not operation identity or normalized money/title text. */
fun isDirty(session: DraftSession): Boolean {
    val a = session.current
    val b = session.original
    return a.title != b.title || a.amountText != b.amountText ||
        a.categoryId != b.categoryId || a.dateText != b.dateText || a.type != b.type
}

private fun JSONObject.nullableString(key: String): String? {
    require(has(key)) { "Missing session field: $key" }
    return if (isNull(key)) null else getString(key)
}

private fun draftJson(draft: TransactionDraft): JSONObject = JSONObject().apply {
    put("operationId", draft.operationId)
    put("transactionId", draft.transactionId ?: JSONObject.NULL)
    put("title", draft.title)
    put("amount", draft.amountText)
    put("category", draft.categoryId)
    put("date", draft.dateText)
    put("type", draft.type.name)
}

private fun readDraft(json: JSONObject): TransactionDraft = TransactionDraft(
    operationId = json.getString("operationId").also { require(it.isNotBlank()) },
    transactionId = json.nullableString("transactionId"),
    title = json.getString("title"),
    amountText = json.getString("amount"),
    categoryId = json.getString("category"),
    dateText = json.getString("date"),
    type = TransactionType.valueOf(json.getString("type"))
)

private fun routeJson(route: DetailRoute): JSONObject = JSONObject().apply {
    when (route) {
        is DetailRoute.Day -> {
            put("kind", "day")
            put("date", route.date.toString())
        }
        is DetailRoute.Editor -> {
            put("kind", "editor")
            put("transactionId", route.transactionId ?: JSONObject.NULL)
            put("date", route.presetDate.toString())
        }
        is DetailRoute.Budget -> {
            put("kind", "budget")
            put("category", route.categoryId)
        }
        DetailRoute.Sandbox -> put("kind", "sandbox")
    }
}

private fun readRoute(json: JSONObject): DetailRoute = when (json.getString("kind")) {
    "day" -> DetailRoute.Day(LocalDate.parse(json.getString("date")))
    "editor" -> DetailRoute.Editor(
        json.nullableString("transactionId"), LocalDate.parse(json.getString("date"))
    )
    "budget" -> DetailRoute.Budget(json.getString("category"))
    "sandbox" -> DetailRoute.Sandbox
    else -> error("Unknown saved route")
}

/** Version one stores drafts verbatim, including incomplete or invalid field input.
 * Encoding is pure; the state owner persists the result outside composition.
 * A pending operation is restored for receipt reconciliation, never blindly replayed.
 */
fun encodeSession(session: SavedSession): String = JSONObject().apply {
    put("version", 1)
    put("primary", session.navigation.primary.name)
    put("month", session.navigation.calendarMonth.toString())
    put("routes", JSONArray().apply {
        session.navigation.details.forEach { put(routeJson(it)) }
    })
    put("draft", session.draft?.let {
        JSONObject().apply {
            put("current", draftJson(it.current))
            put("original", draftJson(it.original))
            put("sandbox", it.isSandbox)
        }
    } ?: JSONObject.NULL)
    put("budget", session.budget?.let {
        JSONObject().apply {
            put("category", it.categoryId)
            put("limit", it.limitText)
            put("original", it.originalLimitText)
        }
    } ?: JSONObject.NULL)
    put("pending", session.pendingOperationId ?: JSONObject.NULL)
    put("scroll", JSONObject().apply {
        session.scrollPositions.forEach { (key, position) ->
            require(position.first >= 0 && position.second >= 0)
            put(key, JSONArray().put(position.first).put(position.second))
        }
    })
}.toString()

/** Corruption or an unsupported version is reported instead of partially restoring
 * a draft with a new operation id, which could otherwise duplicate a purchase.
 */
fun decodeSession(encoded: String): Result<SavedSession> = runCatching {
    val json = JSONObject(encoded)
    require(json.getInt("version") == 1) { "Unsupported session version" }
    val routes = json.getJSONArray("routes")
    val navigation = AppNavState(
        PrimarySection.valueOf(json.getString("primary")),
        YearMonth.parse(json.getString("month")),
        List(routes.length()) { readRoute(routes.getJSONObject(it)) }
    )
    require(json.has("draft") && json.has("budget")) { "Incomplete saved session" }
    val draft = if (json.isNull("draft")) null else {
        val value = json.getJSONObject("draft")
        DraftSession(
            readDraft(value.getJSONObject("current")),
            readDraft(value.getJSONObject("original")),
            value.getBoolean("sandbox")
        ).also {
            require(it.current.operationId == it.original.operationId) {
                "Draft operation identity changed"
            }
            require(it.current.transactionId == it.original.transactionId) {
                "Draft transaction identity changed"
            }
        }
    }
    val budget = if (json.isNull("budget")) null else {
        val value = json.getJSONObject("budget")
        BudgetDraft(value.getString("category"), value.getString("limit"), value.getString("original"))
    }
    val scrollJson = json.getJSONObject("scroll")
    val scroll = buildMap<String, Pair<Int, Int>> {
        val keys = scrollJson.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = scrollJson.getJSONArray(key)
            require(value.length() == 2)
            val index = value.getLong(0)
            val offset = value.getLong(1)
            require(index in 0L..Int.MAX_VALUE.toLong() && offset in 0L..Int.MAX_VALUE.toLong())
            put(key, index.toInt() to offset.toInt())
        }
    }
    SavedSession(navigation, draft, budget, json.nullableString("pending"), scroll)
}
