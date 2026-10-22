package generated

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.time.DayOfWeek
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class DayAmounts(val income: Long, val expense: Long)

private fun dayAmounts(rows: List<Transaction>) = DayAmounts(
    rows.filter { it.type == TransactionType.INCOME }
        .fold(0L) { total, row -> Math.addExact(total, row.amountCents) },
    rows.filter { it.type == TransactionType.EXPENSE }
        .fold(0L) { total, row -> Math.addExact(total, row.amountCents) }
)

private fun calendarAmount(cents: Long): String = when {
    cents < 100_000 -> ledgerMoney(cents)
    else -> {
        val divisor = if (cents >= 100_000_000) 100_000_000L else 100_000L
        "$" + BigDecimal.valueOf(cents).divide(BigDecimal.valueOf(divisor), 1,
            RoundingMode.HALF_UP).toPlainString() + if (divisor == 100_000L) "k" else "m"
    }
}

/** Calendar is inferred from the approved journey; card colors follow the base UI.
 * The host owns insets and the visible month. This list is the only scroll owner.
 */
@Composable
fun CalendarScreen(
    snapshot: LedgerSnapshot,
    month: YearMonth,
    scrollState: LazyListState,
    onEvent: (AppEvent) -> Unit
) {
    var retry by remember { mutableIntStateOf(0) }
    val result by produceState<Result<Map<LocalDate, DayAmounts>>?>(null, snapshot, month, retry) {
        value = null
        value = withContext(Dispatchers.Default) {
            runCatching {
                snapshot.transactions.filter { YearMonth.from(it.date) == month }
                    .groupBy { it.date }.mapValues { dayAmounts(it.value) }
            }
        }
    }
    val weeks = remember(month) {
        val offset = month.atDay(1).dayOfWeek.value - 1
        List(((offset + month.lengthOfMonth() + 6) / 7) * 7) { index ->
            (index - offset + 1).takeIf { it in 1..month.lengthOfMonth() }?.let(month::atDay)
        }.chunked(7)
    }
    val locale = Locale.getDefault()
    LazyColumn(state = scrollState, modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item(key = "month-header") {
            Column {
                Text(month.format(DateTimeFormatter.ofPattern("MMMM yyyy", locale)),
                    style = MaterialTheme.typography.headlineSmall)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    IconButton(onClick = { onEvent(AppEvent.ShiftMonth(-1)) }) {
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Previous month")
                    }
                    IconButton(onClick = { onEvent(AppEvent.ShiftMonth(1)) }) {
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Next month")
                    }
                }
                Text("+ Income   − Expenses", style = MaterialTheme.typography.bodySmall)
            }
        }
        item(key = "weekdays") {
            Row(Modifier.fillMaxWidth()) {
                DayOfWeek.entries.forEach {
                    Text(it.getDisplayName(TextStyle.NARROW, locale),
                        modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        items(weeks, key = { "week:${month}:${it.firstOrNull { date -> date != null }}" }) { week ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                week.forEach { date ->
                    if (date == null) Spacer(Modifier.weight(1f))
                    else {
                        val amounts = result?.getOrNull()?.get(date)
                        Surface(
                            modifier = Modifier.weight(1f).heightIn(min = 72.dp)
                                .clickable { onEvent(AppEvent.Open(DetailRoute.Day(date))) }
                                .semantics(mergeDescendants = true) {
                                    contentDescription = "$date, " + when {
                                        result?.isFailure == true -> "totals unavailable"
                                        result == null -> "loading totals"
                                        else -> "income ${ledgerMoney(amounts?.income ?: 0)}, " +
                                            "expenses ${ledgerMoney(amounts?.expense ?: 0)}"
                                    }
                                },
                            shape = RoundedCornerShape(10.dp),
                            color = if (date == LocalDate.now()) MaterialTheme.colorScheme.primaryContainer
                                else MaterialTheme.colorScheme.surface
                        ) {
                            Column(Modifier.padding(3.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(date.dayOfMonth.toString(), fontWeight = FontWeight.SemiBold)
                                if (amounts != null) {
                                    if (amounts.income > 0) Text("+${calendarAmount(amounts.income)}",
                                        style = MaterialTheme.typography.labelSmall)
                                    if (amounts.expense > 0) Text("−${calendarAmount(amounts.expense)}",
                                        style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                }
            }
        }
        item(key = "calendar-status") {
            when {
                result == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
                result?.isFailure == true -> TextButton(onClick = {
                    retry++
                    onEvent(AppEvent.Retry)
                }) { Text("Couldn't load the calendar. Try again.") }
                result?.getOrNull().isNullOrEmpty() -> Text("No transactions recorded this month.")
            }
        }
    }
}

private data class DayContent(
    val rows: List<Transaction>,
    val totals: DayAmounts,
    val categories: Map<String, Category>,
    val overages: Map<String, Long>
)

@Composable
fun CalendarDayDetailScreen(
    snapshot: LedgerSnapshot,
    date: LocalDate,
    scrollState: LazyListState,
    onEvent: (AppEvent) -> Unit
) {
    var retry by remember { mutableIntStateOf(0) }
    val result by produceState<Result<DayContent>?>(null, snapshot, date, retry) {
        value = null
        value = withContext(Dispatchers.Default) {
            runCatching {
                val rows = snapshot.transactions.filter { it.date == date }
                    .sortedWith(compareByDescending<Transaction> { it.createdAt }.thenBy { it.id })
                DayContent(rows, dayAmounts(rows), snapshot.categories.associateBy { it.id },
                    summarizeMonth(snapshot, YearMonth.from(date)).categories
                        .associate { it.category.id to it.overageCents })
            }
        }
    }
    val content = result?.getOrNull()
    LazyColumn(state = scrollState, modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item(key = "day-summary") {
            Text(date.format(DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.LONG)),
                style = MaterialTheme.typography.titleMedium)
            if (content != null) {
                Text("Income ${ledgerMoney(content.totals.income)}")
                Text("Expenses ${ledgerMoney(content.totals.expense)}",
                    style = MaterialTheme.typography.headlineSmall)
            }
        }
        item(key = "add-for-day") {
            Button(onClick = { onEvent(AppEvent.Open(DetailRoute.Editor(null, date))) }) {
                Text("Add transaction for this day")
            }
        }
        if (content == null) {
            item(key = "day-status") {
                if (result == null) LinearProgressIndicator(Modifier.fillMaxWidth())
                else TextButton(onClick = { retry++; onEvent(AppEvent.Retry) }) {
                    Text("Couldn't load this day. Try again.")
                }
            }
        } else if (content.rows.isEmpty()) {
            item(key = "day-empty") { Text("No transactions on this day.") }
        } else {
            items(content.rows, key = { it.id }) { transaction ->
                val category = content.categories[transaction.categoryId]
                if (category != null) Surface(shape = RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.surface) {
                    TransactionRow(transaction, category,
                        onClick = { onEvent(AppEvent.Open(DetailRoute.Editor(transaction.id, date))) },
                        onDelete = { onEvent(AppEvent.RequestDelete(transaction.id)) },
                        overageCents = content.overages[category.id] ?: 0L)
                }
            }
        }
    }
    // RequestDelete is handled by the host's confirmation dialog and state owner;
    // only ConfirmDelete reaches the repository, with retryable failure feedback.
}
