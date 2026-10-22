package generated

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import java.math.BigDecimal
import java.time.LocalDate
import java.time.YearMonth
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class LedgerViewModel(
    application: Application,
    private val savedStateHandle: SavedStateHandle
) : AndroidViewModel(application) {
    private val repository: LedgerRepository = LocalLedgerRepository(application)
    private val restored = savedStateHandle.get<String>("session")?.let(::decodeSession)
    private val initial = restored?.getOrNull() ?: SavedSession(
        AppNavState(PrimarySection.HOME, YearMonth.now(), emptyList()),
        null, null, null, emptyMap()
    )
    private val mutable = MutableStateFlow(AppUiState(
        null, initial, true, initial.pendingOperationId != null,
        if (restored?.isFailure == true) "Couldn't restore your unfinished form." else null,
        null, false, false, null
    ))
    val uiState = mutable.asStateFlow()
    private var observation: Job? = null
    private var retryWrite: Pair<String, LedgerCommand>? = null
    private var liveAccent: String? = null

    init {
        observe()
        initial.pendingOperationId?.let { id ->
            viewModelScope.launch {
                try {
                    if (repository.isOperationCommitted(id)) {
                        finish(savedStateHandle["writeKind"] ?: "save")
                    } else {
                        retryWrite = recoverCommand()?.let { id to it }
                        change { copy(pending = false, error = "Save interrupted. Retry to finish.") }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    change { copy(pending = false, error = "Couldn't check the last save. Try again.") }
                }
            }
        }
    }

    private fun change(block: AppUiState.() -> AppUiState) {
        mutable.update(block)
        savedStateHandle["session"] = encodeSession(mutable.value.session)
    }

    private fun observe() {
        observation?.cancel()
        observation = viewModelScope.launch {
            try {
                repository.observeSnapshot().collect { snapshot ->
                    if (snapshot.accentToken == liveAccent) liveAccent = null
                    mutable.update { it.copy(
                        snapshot = liveAccent?.let { token -> snapshot.copy(accentToken = token) }
                            ?: snapshot,
                        loading = false
                    ) }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                mutable.update { it.copy(loading = false, error = "Couldn't load your data. Try again.") }
            }
        }
    }

    fun dispatch(event: AppEvent) {
        if (mutable.value.pending && event != AppEvent.FeedbackConsumed) return
        when (event) {
            is AppEvent.SelectSection -> if (mutable.value.session.navigation.details.isEmpty()) {
                change { copy(session = session.copy(navigation = session.navigation.copy(primary = event.section))) }
            }
            is AppEvent.ShiftMonth -> change { copy(session = session.copy(
                navigation = session.navigation.copy(calendarMonth = session.navigation.calendarMonth.plusMonths(event.delta.toLong()))
            )) }
            is AppEvent.Open -> open(event.route)
            is AppEvent.ChangeDraft -> change {
                val old = session.draft ?: return@change this
                val safe = event.draft.copy(
                    operationId = old.current.operationId,
                    transactionId = old.current.transactionId,
                    type = if (old.isSandbox) TransactionType.EXPENSE else event.draft.type,
                    dateText = if (old.isSandbox) old.current.dateText else event.draft.dateText
                )
                copy(session = session.copy(draft = old.copy(current = safe)), error = null)
            }
            is AppEvent.ChangeLimit -> change { copy(
                session = session.copy(budget = session.budget?.copy(limitText = event.text)), error = null
            ) }
            is AppEvent.RequestDelete -> change { copy(deleteTargetId = event.transactionId, error = null) }
            AppEvent.DismissDelete -> change { copy(deleteTargetId = null, error = null) }
            AppEvent.ConfirmDelete -> mutable.value.deleteTargetId?.let { write(LedgerCommand.Delete(it)) }
            AppEvent.Save -> save(false)
            AppEvent.Record -> save(true)
            AppEvent.Back, AppEvent.Cancel -> back()
            AppEvent.KeepEditing -> change { copy(showUnsavedDialog = false) }
            AppEvent.Discard -> pop()
            AppEvent.OpenTheme -> change { copy(showThemePicker = true) }
            AppEvent.CloseTheme -> change { copy(showThemePicker = false) }
            is AppEvent.PickAccent -> {
                liveAccent = event.token
                change { copy(snapshot = snapshot?.copy(accentToken = event.token)) }
                write(LedgerCommand.SetAccent(event.token))
            }
            AppEvent.FeedbackConsumed -> change { copy(feedback = null) }
            AppEvent.Retry -> {
                change { copy(error = null) }
                observe()
                val pendingId = mutable.value.session.pendingOperationId
                val retry = retryWrite ?: pendingId?.let { id -> recoverCommand()?.let { id to it } }
                if (retry != null) write(retry.second, retry.first)
            }
        }
    }

    private fun money(cents: Long): String = BigDecimal.valueOf(cents, 2).toPlainString()

    private fun open(route: DetailRoute) {
        val snapshot = mutable.value.snapshot ?: return
        if (route is DetailRoute.Budget) {
            val category = snapshot.categories.find { it.id == route.categoryId } ?: return
            val text = category.monthlyLimitCents?.let(::money).orEmpty()
            change { copy(session = session.copy(
                navigation = session.navigation.copy(details = session.navigation.details + route),
                budget = BudgetDraft(category.id, text, text)
            ), error = null) }
            return
        }
        if (route is DetailRoute.Day) {
            change { copy(session = session.copy(navigation = session.navigation.copy(
                details = session.navigation.details + route
            ))) }
            return
        }
        if (mutable.value.session.draft != null) return
        val existing = (route as? DetailRoute.Editor)?.transactionId?.let { id ->
            snapshot.transactions.find { it.id == id }
        }
        if (route is DetailRoute.Editor && route.transactionId != null && existing == null) {
            change { copy(error = "Transaction no longer exists.") }
            return
        }
        change { copy(pending = true) }
        viewModelScope.launch {
            try {
                val draft = TransactionDraft(
                    repository.allocateOperationId(), existing?.id, existing?.title.orEmpty(),
                    existing?.amountCents?.let(::money).orEmpty(), existing?.categoryId ?: "other",
                    (existing?.date ?: (route as? DetailRoute.Editor)?.presetDate ?: LocalDate.now()).toString(),
                    existing?.type ?: TransactionType.EXPENSE
                )
                change { copy(pending = false, error = null, session = session.copy(
                    navigation = session.navigation.copy(details = session.navigation.details + route),
                    draft = DraftSession(draft, draft, route == DetailRoute.Sandbox)
                )) }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: Exception) { change { copy(pending = false, error = "Couldn't open the form. Try again.") } }
        }
    }

    private fun save(record: Boolean) {
        val state = mutable.value
        if (state.session.navigation.details.lastOrNull() is DetailRoute.Budget) {
            val budget = state.session.budget ?: return
            val amount = parsePositiveCents(budget.limitText)
            if (amount == null) change { copy(error = "Limit must be a positive amount.") }
            else write(LedgerCommand.SetLimit(budget.categoryId, amount))
            return
        }
        val draftSession = state.session.draft ?: return
        if (record != draftSession.isSandbox) return
        val snapshot = state.snapshot ?: return
        val draft = draftSession.current
        if (record) {
            // Reconcile date and monthly comparison together without changing the
            // editable draft. Failed writes retain all unfinished input and the
            // same operation identity for receipt reconciliation and retries.
            val purchaseDate = LocalDate.now()
            val prepared = preparePurchase(snapshot, draft, purchaseDate).getOrElse { failure ->
                change { copy(error = failure.message ?: "Couldn't prepare this purchase. Try again.") }
                return
            }
            write(LedgerCommand.RecordPurchase(prepared.draft), prepared.draft.operationId)
            return
        }
        val errors = validateDraft(draft, snapshot.categories)
        if (errors.isNotEmpty()) {
            change { copy(error = errors.values.joinToString(" ")) }
            return
        }
        write(LedgerCommand.Save(draft), draft.operationId)
    }

    private fun back() {
        val state = mutable.value
        if (state.showThemePicker) { dispatch(AppEvent.CloseTheme); return }
        if (state.deleteTargetId != null) { dispatch(AppEvent.DismissDelete); return }
        val dirty = if (state.session.navigation.details.lastOrNull() is DetailRoute.Budget) {
            state.session.budget?.let { it.limitText != it.originalLimitText } == true
        } else state.session.draft?.let(::isDirty) == true
        if (dirty) change { copy(showUnsavedDialog = true) } else pop()
    }

    private fun pop() {
        change {
            val top = session.navigation.details.lastOrNull()
            copy(session = session.copy(
                navigation = session.navigation.copy(details = session.navigation.details.dropLast(1)),
                budget = if (top is DetailRoute.Budget) null else session.budget,
                draft = if (top is DetailRoute.Editor || top == DetailRoute.Sandbox) null else session.draft,
                pendingOperationId = null
            ), showUnsavedDialog = false, deleteTargetId = null, error = null)
        }
        retryWrite = null
    }

    private fun write(command: LedgerCommand, operationId: String? = null) {
        change { copy(pending = true, error = null) }
        viewModelScope.launch {
            try {
                val id = operationId ?: repository.allocateOperationId()
                val kind = when (command) {
                    is LedgerCommand.Save -> "save"
                    is LedgerCommand.RecordPurchase -> "record"
                    is LedgerCommand.Delete -> "delete"
                    is LedgerCommand.SetLimit -> "limit"
                    is LedgerCommand.SetAccent -> "accent"
                }
                savedStateHandle["writeKind"] = kind
                savedStateHandle["writeTarget"] = when (command) {
                    is LedgerCommand.Delete -> command.transactionId
                    is LedgerCommand.SetAccent -> command.token
                    else -> ""
                }
                retryWrite = id to command
                change { copy(session = session.copy(pendingOperationId = id)) }
                repository.execute(id, command).getOrThrow()
                finish(kind)
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (exception: Exception) {
                change { copy(pending = false, error = exception.message ?: "Couldn't save. Try again.") }
            }
        }
    }

    private fun recoverCommand(): LedgerCommand? = when (savedStateHandle.get<String>("writeKind")) {
        "save" -> mutable.value.session.draft?.current?.let(LedgerCommand::Save)
        "record" -> mutable.value.session.draft?.current?.let(LedgerCommand::RecordPurchase)
        "limit" -> mutable.value.session.budget?.let { budget ->
            parsePositiveCents(budget.limitText)?.let { LedgerCommand.SetLimit(budget.categoryId, it) }
        }
        "delete" -> savedStateHandle.get<String>("writeTarget")?.let(LedgerCommand::Delete)
        "accent" -> savedStateHandle.get<String>("writeTarget")?.let(LedgerCommand::SetAccent)
        else -> null
    }

    private fun finish(kind: String) {
        if (kind == "record") {
            change { copy(session = session.copy(
                navigation = session.navigation.copy(primary = PrimarySection.HOME, details = emptyList()),
                draft = null, budget = null
            )) }
        } else if (kind == "save" || kind == "limit" ||
            (kind == "delete" && mutable.value.session.navigation.details.lastOrNull() is DetailRoute.Editor)) {
            pop()
        }
        change { copy(pending = false, error = null, deleteTargetId = null,
            session = session.copy(pendingOperationId = null),
            feedback = when (kind) {
                "record" -> "Purchase recorded"
                "delete" -> "Transaction deleted"
                "accent" -> feedback
                else -> "Saved"
            }
        ) }
        retryWrite = null
        savedStateHandle.remove<String>("writeKind")
        savedStateHandle.remove<String>("writeTarget")
    }

    fun saveScrollPosition(key: String, index: Int, offset: Int) {
        if (index < 0 || offset < 0) return
        change { copy(session = session.copy(scrollPositions = session.scrollPositions + (key to (index to offset)))) }
    }
}
