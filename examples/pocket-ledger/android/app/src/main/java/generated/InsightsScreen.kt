package generated

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class InsightsContent(
    val current: MonthSummary,
    val previous: MonthSummary
)

/** Reference two: trend first, period rings, then ranked editable category budgets.
 * Insets belong to the application Scaffold; this list owns vertical scrolling.
 */
@Composable
fun InsightsScreen(
    snapshot: LedgerSnapshot,
    month: YearMonth,
    scrollState: LazyListState,
    onEvent: (AppEvent) -> Unit
) {
    var retry by remember { mutableIntStateOf(0) }
    val result by produceState<Result<InsightsContent>?>(null, snapshot, month, retry) {
        value = null
        value = withContext(Dispatchers.Default) {
            runCatching {
                InsightsContent(
                    summarizeMonth(snapshot, month),
                    summarizeMonth(snapshot, month.minusMonths(1))
                )
            }
        }
    }
    val content = result?.getOrNull()
    val monthLabel = remember(month) { insightsMonthLabel(month) }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = scrollState,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item(key = "insights-heading") {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Insights", style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold)
                Text(monthLabel, style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (content == null) {
            item(key = "insights-status") {
                if (result == null) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                } else {
                    Surface(shape = RoundedCornerShape(18.dp),
                        color = MaterialTheme.colorScheme.surface) {
                        Column(Modifier.fillMaxWidth().padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Couldn't load insights. Try again.",
                                color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = {
                                retry++
                                onEvent(AppEvent.Retry)
                            }) { Text("Try again") }
                        }
                    }
                }
            }
        } else {
            item(key = "insights-trend") {
                Surface(shape = RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.surface) {
                    SpendingTrendChart(content.current, Modifier.padding(16.dp))
                }
            }
            item(key = "current-period") {
                InsightsPeriodCard("Current period", content.current)
            }
            item(key = "previous-period") {
                InsightsPeriodCard("Previous month", content.previous)
            }
            if (content.current.expenseCents == 0L) {
                item(key = "insights-empty") {
                    Text("No spending yet this month to show insights for.",
                        style = MaterialTheme.typography.bodyMedium)
                }
            }
            item(key = "insights-categories") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Category budgets", style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold)
                    Text("Tap a category to edit its monthly limit.",
                        style = MaterialTheme.typography.bodySmall)
                }
            }
            items(content.current.categories, key = { "budget:${it.category.id}" }) { summary ->
                Surface(shape = RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.surface) {
                    CategoryRow(summary, onClick = {
                        onEvent(AppEvent.Open(DetailRoute.Budget(summary.category.id)))
                    })
                }
            }
        }
    }
}

private fun insightsMonthLabel(month: YearMonth): String =
    month.format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.getDefault()))

@Composable
private fun InsightsPeriodCard(title: String, summary: MonthSummary) {
    val label = remember(summary.month) { insightsMonthLabel(summary.month) }
    val remaining = summary.limitCents - summary.expenseCents
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface) {
        BoxWithConstraints(Modifier.fillMaxWidth().padding(16.dp)) {
            // Allow money and status text their own full width on narrow windows.
            val stacked = maxWidth < 280.dp ||
                androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.4f
            val details: @Composable () -> Unit = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(title, style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold)
                    Text(label, style = MaterialTheme.typography.bodySmall)
                    Text(ledgerMoney(summary.expenseCents),
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold)
                    if (summary.limitCents == 0L) {
                        Text("No monthly limits set", style = MaterialTheme.typography.bodySmall)
                    } else {
                        Text("of ${ledgerMoney(summary.limitCents)} budget",
                            style = MaterialTheme.typography.bodySmall)
                        if (remaining < 0L) OverageLabel(-remaining)
                        else Text("${ledgerMoney(remaining)} remaining",
                            style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (stacked) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    details()
                    BudgetDonutRing(summary.expenseCents,
                        summary.limitCents.takeIf { it > 0 }, label = "$title, $label")
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Box(Modifier.weight(1f)) { details() }
                    BudgetDonutRing(summary.expenseCents,
                        summary.limitCents.takeIf { it > 0 }, label = "$title, $label")
                }
            }
        }
    }
}
