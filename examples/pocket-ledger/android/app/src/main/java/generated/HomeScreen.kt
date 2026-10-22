package generated

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class HomeContent(
    val summary: MonthSummary,
    val balance: Long,
    val recent: List<Transaction>,
    val categories: Map<String, Category>
)

/** Reference-one hierarchy: horizontal totals, monthly progress, then ledger detail.
 * No wallet/account management is implied by the summary cards.
 */
@Composable
fun HomeScreen(
    snapshot: LedgerSnapshot,
    month: YearMonth,
    scrollState: LazyListState,
    onEvent: (AppEvent) -> Unit
) {
    val content by produceState<Result<HomeContent>?>(null, snapshot, month) {
        value = withContext(Dispatchers.Default) {
            runCatching {
                val summary = summarizeMonth(snapshot, month)
                HomeContent(
                    summary,
                    Math.subtractExact(summary.incomeCents, summary.expenseCents),
                    snapshot.transactions.sortedWith(
                        compareByDescending<Transaction> { it.date }
                            .thenByDescending { it.createdAt }.thenBy { it.id }
                    ),
                    snapshot.categories.associateBy { it.id }
                )
            }
        }
    }
    val data = content?.getOrNull()
    LazyColumn(
        state = scrollState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item(key = "month") {
            Text(
                month.format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.getDefault())),
                style = MaterialTheme.typography.titleMedium
            )
        }
        if (data == null) {
            item(key = "loading-or-error") {
                if (content == null) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Couldn't load your monthly overview.", color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = { onEvent(AppEvent.Retry) }) { Text("Try again") }
                    }
                }
            }
        } else {
            item(key = "overview-totals") {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item(key = "balance") {
                        HomeTotal("Month balance", data.balance, "Income minus expenses")
                    }
                    item(key = "income") {
                        HomeTotal("Income", data.summary.incomeCents, "This month")
                    }
                    item(key = "expense") {
                        HomeTotal("Expenses", data.summary.expenseCents, "This month")
                    }
                }
            }
            item(key = "monthly-spending") {
                MonthlySpendingCard(data.summary)
            }
        }
        // Keep the signature action ahead of every secondary list, including errors.
        item(key = "try-purchase") {
            Button(
                onClick = { onEvent(AppEvent.Open(DetailRoute.Sandbox)) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                shape = RoundedCornerShape(12.dp),
                contentPadding = PaddingValues(12.dp)
            ) {
                Icon(Icons.Default.ShoppingBag, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Try a purchase", style = MaterialTheme.typography.titleSmall)
            }
        }
        if (data != null) {
            item(key = "recent-heading") {
                Text("Recent transactions", style = MaterialTheme.typography.titleMedium)
            }
            if (data.recent.isEmpty()) {
                item(key = "empty-ledger") {
                    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface) {
                        Column(Modifier.fillMaxWidth().padding(16.dp)) {
                            Text("No transactions yet. Tap + to add your first one.")
                            TextButton(onClick = {
                                onEvent(AppEvent.Open(DetailRoute.Editor(null, LocalDate.now())))
                            }) { Text("Add transaction") }
                        }
                    }
                }
            } else {
                // All saved rows remain reachable; the parent is the only vertical scroller.
                items(data.recent, key = { "transaction:${it.id}" }) { transaction ->
                    val category = data.categories[transaction.categoryId]
                    if (category != null) {
                        val overage = if (YearMonth.from(transaction.date) == month) {
                            data.summary.categories.find { it.category.id == category.id }?.overageCents ?: 0L
                        } else 0L
                        Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface) {
                            TransactionRow(
                                transaction = transaction,
                                category = category,
                                onClick = {
                                    onEvent(AppEvent.Open(DetailRoute.Editor(transaction.id, transaction.date)))
                                },
                                onDelete = { onEvent(AppEvent.RequestDelete(transaction.id)) },
                                overageCents = overage
                            )
                        }
                    }
                }
            }
            item(key = "categories-heading") {
                Text("Category budgets", style = MaterialTheme.typography.titleMedium)
            }
            items(data.summary.categories, key = { "category:${it.category.id}" }) { summary ->
                Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface) {
                    CategoryRow(summary, onClick = {
                        onEvent(AppEvent.Open(DetailRoute.Budget(summary.category.id)))
                    })
                }
            }
            item(key = "spending-trend") {
                Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface) {
                    SpendingTrendChart(data.summary, Modifier.padding(16.dp))
                }
            }
        }
    }
}

@Composable
private fun HomeTotal(label: String, amount: Long, note: String) {
    Card(
        modifier = Modifier.width(172.dp),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = MaterialTheme.typography.titleSmall)
            Text(ledgerMoney(amount), style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold)
            Text(note, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
