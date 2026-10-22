package generated

import android.content.Context
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext

interface LedgerRepository {
    fun observeSnapshot(): Flow<LedgerSnapshot>
    suspend fun allocateOperationId(): String
    suspend fun execute(operationId: String, command: LedgerCommand): Result<Unit>
    suspend fun isOperationCommitted(operationId: String): Boolean
}

/** All validation, financial changes and receipts share one database transaction. */
class LocalLedgerRepository(
    private val database: LedgerDatabase,
    private val clock: Clock = Clock.systemDefaultZone()
) : LedgerRepository {
    constructor(context: Context) : this(LedgerDatabase.getInstance(context))

    override fun observeSnapshot(): Flow<LedgerSnapshot> =
        database.observeSnapshot().flowOn(Dispatchers.IO)

    override suspend fun allocateOperationId(): String = UUID.randomUUID().toString()

    override suspend fun isOperationCommitted(operationId: String): Boolean =
        withContext(Dispatchers.IO) {
            require(operationId.isNotBlank())
            database.dao().isOperationCommitted(operationId)
        }

    override suspend fun execute(
        operationId: String,
        command: LedgerCommand
    ): Result<Unit> = withContext(Dispatchers.IO) {
        try {
            require(operationId.isNotBlank()) { "Missing operation identity." }
            val now = Instant.ofEpochMilli(clock.millis())
            database.commitOnce(operationId, now) {
                when (command) {
                    is LedgerCommand.Save -> saveDraft(operationId, command.draft, now, false)
                    is LedgerCommand.RecordPurchase ->
                        saveDraft(operationId, command.draft, now, true)
                    is LedgerCommand.Delete -> {
                        require(command.transactionId.isNotBlank()) { "Missing transaction." }
                        // An already absent row has the same desired terminal state.
                        deleteTransaction(command.transactionId)
                    }
                    is LedgerCommand.SetLimit -> {
                        require(command.limitCents > 0) { "Limit must be a positive amount." }
                        val existing = requireNotNull(category(command.categoryId)) {
                            "Category no longer exists."
                        }
                        if (existing.monthlyLimitCents != command.limitCents) {
                            val categories = allCategories().map {
                                if (it.id == existing.id) {
                                    it.toDomain().copy(monthlyLimitCents = command.limitCents)
                                } else it.toDomain()
                            }
                            // Also reject aggregate limit overflow before changing any row.
                            categories.fold(0L) { sum, item ->
                                Math.addExact(sum, item.monthlyLimitCents ?: 0L)
                            }
                            check(updateLimit(existing.id, command.limitCents) == 1)
                        }
                    }
                    is LedgerCommand.SetAccent -> {
                        require(command.token in accentTokens) { "Unknown accent color." }
                        if (setting("accentToken") != command.token) {
                            putSetting(SettingEntity("accentToken", command.token))
                        }
                    }
                }
            }
            Result.success(Unit)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (exception: Exception) {
            Result.failure(exception)
        }
    }

    private suspend fun LedgerDao.saveDraft(
        operationId: String,
        draft: TransactionDraft,
        now: Instant,
        purchase: Boolean
    ) {
        require(draft.operationId == operationId) { "Draft operation identity changed." }
        val categories = allCategories().map { it.toDomain() }
        val rows = allTransactions().map { it.toDomain() }
        // Called inside commitOnce: reconcile against the transactional ledger,
        // using the same captured instant as the transaction and receipt timestamps.
        val committedDraft = if (purchase) {
            val purchaseDate = now.atZone(clock.zone).toLocalDate()
            preparePurchase(
                LedgerSnapshot(rows, categories, setting("accentToken") ?: "green"),
                draft,
                purchaseDate
            ).getOrThrow().draft
        } else draft
        val errors = validateDraft(committedDraft, categories)
        require(errors.isEmpty()) { errors.values.joinToString(" ") }
        val previous = committedDraft.transactionId?.let {
            requireNotNull(transaction(it)) { "Transaction no longer exists." }
        }
        // For a new record, its repository-issued operation identity is also its ID.
        // Edits retain their original record ID and immutable creation timestamp.
        val value = Transaction(
            id = previous?.id ?: operationId,
            title = committedDraft.title.trim(),
            amountCents = requireNotNull(parsePositiveCents(committedDraft.amountText)),
            type = committedDraft.type,
            categoryId = committedDraft.categoryId,
            date = requireNotNull(parseLedgerDate(committedDraft.dateText)),
            createdAt = previous?.createdAt ?: now,
            updatedAt = now
        )
        val proposed = rows.filterNot { it.id == value.id } + value
        val snapshot = LedgerSnapshot(proposed, categories, setting("accentToken") ?: "green")
        summarizeMonth(snapshot, YearMonth.from(value.date))
        if (previous != null && YearMonth.from(previous.date) != YearMonth.from(value.date)) {
            summarizeMonth(snapshot, YearMonth.from(previous.date))
        }
        if (previous == null) {
            // ABORT on collision; never replace an unrelated existing record.
            insertTransaction(value.toEntity())
        } else {
            check(updateTransaction(
                value.id, value.title, value.amountCents, value.type,
                value.categoryId, value.date, value.updatedAt
            ) == 1) { "Transaction no longer exists." }
        }
    }

    private companion object {
        val accentTokens = setOf(
            "green", "teal", "cyan", "blue", "indigo", "purple",
            "magenta", "pink", "red", "orange", "yellow"
        )
    }
}
