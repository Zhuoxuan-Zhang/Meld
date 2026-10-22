package generated

import java.math.BigDecimal
import java.time.LocalDate
import java.time.YearMonth

private val moneyPattern = Regex("[0-9]+(?:\\.[0-9]{1,2})?")

/** Strict decimal USD input: no signs, grouping, exponent or fractional cents. */
fun parsePositiveCents(text: String): Long? {
    if (!moneyPattern.matches(text)) return null
    return try {
        BigDecimal(text).movePointRight(2).longValueExact().takeIf { it > 0 }
    } catch (_: ArithmeticException) {
        null
    } catch (_: NumberFormatException) {
        null
    }
}

/** Canonical ISO calendar dates, including leap-day validation. */
fun parseLedgerDate(text: String): LocalDate? = try {
    LocalDate.parse(text).takeIf { it.toString() == text }
} catch (_: java.time.DateTimeException) {
    null
}

fun validateDraft(
    draft: TransactionDraft,
    categories: List<Category>
): Map<String, String> = buildMap {
    if (draft.title.trim().length !in 1..80) {
        put("title", "Enter a title of 1–80 characters.")
    }
    if (parsePositiveCents(draft.amountText) == null) {
        put("amount", "Enter a positive amount with at most two decimal places.")
    }
    if (categories.none { it.id == draft.categoryId }) {
        put("category", "Select an existing category.")
    }
    if (parseLedgerDate(draft.dateText) == null) {
        put("date", "Enter a valid date in YYYY-MM-DD format.")
    }
}

private fun Iterable<Long>.checkedTotal(): Long = fold(0L) { total, amount ->
    Math.addExact(total, amount)
}

/** Income never consumes a spending budget. Arithmetic overflow is an error. */
fun summarizeMonth(snapshot: LedgerSnapshot, month: YearMonth): MonthSummary {
    val categoryIds = snapshot.categories.map { it.id }.toSet()
    require(categoryIds.size == snapshot.categories.size) { "Duplicate category ids." }
    snapshot.categories.forEach {
        require(it.monthlyLimitCents == null || it.monthlyLimitCents > 0) {
            "Monthly limits must be positive."
        }
    }
    val transactions = snapshot.transactions.filter { YearMonth.from(it.date) == month }
    transactions.forEach {
        require(it.amountCents > 0) { "Transaction amounts must be positive." }
        require(it.categoryId in categoryIds) { "Unknown transaction category." }
    }
    val expenses = transactions.filter { it.type == TransactionType.EXPENSE }
    val byCategory = expenses.groupBy { it.categoryId }
    val categories = snapshot.categories.map { category ->
        val rows = byCategory[category.id].orEmpty()
        val spent = rows.map { it.amountCents }.checkedTotal()
        val remaining = category.monthlyLimitCents?.let { Math.subtractExact(it, spent) }
        CategorySummary(
            category = category,
            spentCents = spent,
            remainingCents = remaining,
            overageCents = if (remaining != null && remaining < 0) {
                Math.negateExact(remaining)
            } else 0L,
            transactionCount = rows.size
        )
    }.sortedWith(compareByDescending<CategorySummary> { it.spentCents }
        .thenBy { it.category.id })

    val daily = LongArray(month.lengthOfMonth())
    expenses.forEach { transaction ->
        val index = transaction.date.dayOfMonth - 1
        daily[index] = Math.addExact(daily[index], transaction.amountCents)
    }
    var running = 0L
    val cumulative = daily.map {
        running = Math.addExact(running, it)
        running
    }
    return MonthSummary(
        month = month,
        incomeCents = transactions.filter { it.type == TransactionType.INCOME }
            .map { it.amountCents }.checkedTotal(),
        expenseCents = running,
        limitCents = snapshot.categories.mapNotNull { it.monthlyLimitCents }.checkedTotal(),
        categories = categories,
        cumulativeExpenseCents = cumulative
    )
}

/** The reconciled expense and comparison share one purchase date and operation identity. */
data class PreparedPurchase(val draft: TransactionDraft, val comparison: Comparison)

/**
 * Reconcile a sandbox draft before validation so a draft opened on an earlier day
 * uses the purchase date's month for both comparison and eventual insertion.
 * This is pure: the supplied draft and ledger remain unchanged, and no operation
 * identity or timestamps are allocated. Callers capture the purchase date once.
 * Allowance includes the purchase day and preserves signed over-budget results;
 * integer division truncates toward zero to express whole cents per day.
 */
fun preparePurchase(
    snapshot: LedgerSnapshot,
    draft: TransactionDraft,
    purchaseDate: LocalDate
): Result<PreparedPurchase> = runCatching {
    val reconciled = draft.copy(dateText = purchaseDate.toString())
    require(reconciled.transactionId == null) { "A preview must create a new expense." }
    require(reconciled.type == TransactionType.EXPENSE) { "Purchases must be expenses." }
    val errors = validateDraft(reconciled, snapshot.categories)
    require(errors.isEmpty()) { errors.values.joinToString(" ") }
    val category = snapshot.categories.single { it.id == reconciled.categoryId }
    requireNotNull(category.monthlyLimitCents) {
        "This category has no budget yet. Set one first."
    }
    val amount = requireNotNull(parsePositiveCents(reconciled.amountText))
    val month = YearMonth.from(purchaseDate)
    val summary = summarizeMonth(snapshot, month)
    val before = requireNotNull(
        summary.categories.single { it.category.id == category.id }.remainingCents
    )
    val monthlyRemaining = Math.subtractExact(summary.limitCents, summary.expenseCents)
    val days = (month.lengthOfMonth() - purchaseDate.dayOfMonth + 1).toLong()
    PreparedPurchase(
        draft = reconciled,
        comparison = Comparison(
            beforeRemainingCents = before,
            afterRemainingCents = Math.subtractExact(before, amount),
            beforeAllowanceCents = monthlyRemaining / days,
            afterAllowanceCents = Math.subtractExact(monthlyRemaining, amount) / days
        )
    )
}

/** Read-only preview using the same date reconciliation as purchase recording. */
fun previewPurchase(
    snapshot: LedgerSnapshot,
    draft: TransactionDraft,
    today: LocalDate
): Result<Comparison> = preparePurchase(snapshot, draft, today).map { it.comparison }
