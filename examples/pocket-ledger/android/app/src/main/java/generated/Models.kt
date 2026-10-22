package generated

import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth

/** Amounts are positive integer USD cents; type determines their ledger direction. */
enum class TransactionType { INCOME, EXPENSE }

data class Transaction(
    val id: String,
    val title: String,
    val amountCents: Long,
    val type: TransactionType,
    val categoryId: String,
    val date: LocalDate,
    val createdAt: Instant,
    val updatedAt: Instant
)

/** A null limit means unconfigured, rather than a zero-dollar budget. */
data class Category(
    val id: String,
    val name: String,
    val monthlyLimitCents: Long?,
    val colorToken: String,
    val iconKey: String
)

/** Fresh installs contain category metadata only, never invented financial history. */
fun seededCategories(): List<Category> = listOf(
    Category("food", "Food", null, "categoryGreen", "fork-and-knife"),
    Category("shopping", "Shopping", null, "categoryPink", "shopping-bag"),
    Category("transport", "Transport", null, "categoryBlue", "bus"),
    Category("other", "Other", null, "categoryGray", "tag")
)

/**
 * Text remains unparsed while editing so incomplete or invalid input survives
 * recreation. operationId is allocated once and retained across write retries;
 * transactionId is null for a new record and immutable for an existing record.
 */
data class TransactionDraft(
    val operationId: String,
    val transactionId: String?,
    val title: String,
    val amountText: String,
    val categoryId: String,
    val dateText: String,
    val type: TransactionType
)

/** Signed remaining amounts preserve over-budget results instead of hiding them. */
data class Comparison(
    val beforeRemainingCents: Long,
    val afterRemainingCents: Long,
    val beforeAllowanceCents: Long,
    val afterAllowanceCents: Long
)

data class CategorySummary(
    val category: Category,
    val spentCents: Long,
    val remainingCents: Long?,
    val overageCents: Long,
    val transactionCount: Int
)

/** cumulativeExpenseCents contains one cumulative expense total per calendar day. */
data class MonthSummary(
    val month: YearMonth,
    val incomeCents: Long,
    val expenseCents: Long,
    val limitCents: Long,
    val categories: List<CategorySummary>,
    val cumulativeExpenseCents: List<Long>
)

/** Repository emissions own their lists; consumers treat each snapshot as a value. */
data class LedgerSnapshot(
    val transactions: List<Transaction>,
    val categories: List<Category>,
    val accentToken: String
)

enum class PrimarySection { HOME, INSIGHTS, CALENDAR }

sealed interface DetailRoute {
    data class Day(val date: LocalDate) : DetailRoute
    data class Editor(
        val transactionId: String?,
        val presetDate: LocalDate
    ) : DetailRoute
    data class Budget(val categoryId: String) : DetailRoute
    data object Sandbox : DetailRoute
}

/**
 * Details are a bottom-to-top stack. A budget editor can sit above the sandbox,
 * allowing Back to restore the same preview rather than create another draft.
 */
data class AppNavState(
    val primary: PrimarySection,
    val calendarMonth: YearMonth,
    val details: List<DetailRoute>
)

/**
 * Only explicit commands mutate the ledger. Computing a purchase comparison is
 * deliberately absent: previews are pure reads, and recording is a separate act.
 * The repository executes commands with an atomic operation receipt.
 */
sealed interface LedgerCommand {
    data class Save(val draft: TransactionDraft) : LedgerCommand
    data class RecordPurchase(val draft: TransactionDraft) : LedgerCommand
    data class Delete(val transactionId: String) : LedgerCommand
    data class SetLimit(
        val categoryId: String,
        val limitCents: Long
    ) : LedgerCommand
    data class SetAccent(val token: String) : LedgerCommand
}
