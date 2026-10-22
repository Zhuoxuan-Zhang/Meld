package generated

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.math.BigDecimal
import java.time.LocalDate

fun ledgerMoney(cents: Long): String = if (cents < 0) {
    "−$" + BigDecimal.valueOf(cents, 2).abs().toPlainString()
} else "$" + BigDecimal.valueOf(cents, 2).toPlainString()

@Composable
fun CategoryIcon(category: Category, modifier: Modifier = Modifier) {
    val color = when (category.colorToken) {
        "categoryGreen" -> Color(0xFF3B8050)
        "categoryPink" -> Color(0xFFB52D69)
        "categoryBlue" -> Color(0xFF2567BB)
        else -> Color(0xFF65736A)
    }
    Box(modifier.size(40.dp).background(color.copy(alpha = .15f), RoundedCornerShape(10.dp)),
        contentAlignment = Alignment.Center) {
        Icon(when (category.iconKey) {
            "fork-and-knife" -> Icons.Default.Restaurant
            "shopping-bag" -> Icons.Default.ShoppingBag
            "bus" -> Icons.Default.DirectionsBus
            else -> Icons.Default.LocalOffer
        }, contentDescription = null, tint = color, modifier = Modifier.size(24.dp))
    }
}

@Composable
fun OverageLabel(overageCents: Long, modifier: Modifier = Modifier) {
    if (overageCents > 0) Row(modifier, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(16.dp))
        Text("${ledgerMoney(overageCents)} over budget", color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun CategoryRow(summary: CategorySummary, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val limit = summary.category.monthlyLimitCents
    val status = when {
        summary.overageCents > 0 -> "${ledgerMoney(summary.overageCents)} over budget"
        summary.remainingCents != null -> "${ledgerMoney(summary.remainingCents)} remaining"
        else -> "No budget set"
    }
    Row(modifier.fillMaxWidth().clickable(onClick = onClick)
        .semantics(mergeDescendants = true) {
            contentDescription = "${summary.category.name}, ${ledgerMoney(summary.spentCents)} spent, " +
                "${limit?.let { ledgerMoney(it) } ?: "no limit"}, $status. Edit monthly limit"
        }.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        CategoryIcon(summary.category)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(summary.category.name, style = MaterialTheme.typography.titleSmall,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${ledgerMoney(summary.spentCents)} / ${limit?.let { ledgerMoney(it) } ?: "Set limit"}",
                color = if (summary.overageCents > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            LinearProgressIndicator(progress = {
                if (limit == null) 0f else (summary.spentCents.toDouble() / limit).toFloat().coerceIn(0f, 1f)
            }, modifier = Modifier.fillMaxWidth().height(4.dp),
                color = if (summary.overageCents > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            if (summary.overageCents > 0) OverageLabel(summary.overageCents)
            else Text(status, style = MaterialTheme.typography.bodySmall)
            Text("${summary.transactionCount} transactions", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
fun TransactionRow(
    transaction: Transaction,
    category: Category,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onDelete: (() -> Unit)? = null,
    overageCents: Long = 0
) {
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CategoryIcon(category)
        Column(Modifier.weight(1f)) {
            Text(transaction.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.titleSmall)
            Text("${category.name} · ${transaction.date}", style = MaterialTheme.typography.bodySmall)
            Text("${if (transaction.type == TransactionType.INCOME) "+" else "−"}${ledgerMoney(transaction.amountCents)}",
                fontWeight = FontWeight.Bold,
                color = if (overageCents > 0 && transaction.type == TransactionType.EXPENSE)
                    MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
            if (transaction.type == TransactionType.EXPENSE) OverageLabel(overageCents)
        }
        if (onDelete != null) IconButton(onClick = onDelete) {
            Icon(Icons.Default.DeleteOutline, "Delete ${transaction.title}")
        }
    }
}

@Composable
fun MonthlySpendingCard(summary: MonthSummary, modifier: Modifier = Modifier, today: LocalDate = LocalDate.now()) {
    val remaining = summary.limitCents - summary.expenseCents
    val fraction = if (summary.limitCents > 0) summary.expenseCents.toDouble() / summary.limitCents else 0.0
    val marker = when {
        today < summary.month.atDay(1) -> 0f
        today > summary.month.atEndOfMonth() -> 1f
        else -> (today.dayOfMonth - 1f) / (summary.month.lengthOfMonth() - 1)
    }
    Card(modifier.fillMaxWidth(), shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary.copy(alpha = .12f))) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Monthly Spending", style = MaterialTheme.typography.titleMedium)
            Text(ledgerMoney(summary.expenseCents), style = MaterialTheme.typography.headlineSmall)
            Text(if (summary.limitCents == 0L) "Set category limits to start budgeting"
                else "${ledgerMoney(remaining)} left of ${ledgerMoney(summary.limitCents)}")
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                Text("Today", style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(start = ((maxWidth - 48.dp).coerceAtLeast(0.dp) * marker)))
            }
            LinearProgressIndicator(progress = { fraction.toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().height(12.dp).semantics {
                    contentDescription = "Monthly spending ${(fraction * 100).toLong()} percent, ${ledgerMoney(remaining)} left"
                }, color = if (remaining < 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${summary.month.month.name.lowercase().replaceFirstChar { it.uppercase() }} 1",
                    style = MaterialTheme.typography.bodySmall)
                Text("${summary.month.lengthOfMonth()}", style = MaterialTheme.typography.bodySmall)
            }
            if (remaining < 0) OverageLabel(-remaining)
        }
    }
}

@Composable
fun UnsavedChangesDialog(onKeepEditing: () -> Unit, onDiscard: () -> Unit) {
    AlertDialog(onDismissRequest = onKeepEditing,
        title = { Text("Discard unsaved changes?") },
        text = { Text("Your changes have not been recorded.") },
        confirmButton = { TextButton(onClick = onDiscard) { Text("Discard") } },
        dismissButton = { TextButton(onClick = onKeepEditing) { Text("Keep editing") } })
}

@Composable
fun DeleteConfirmationDialog(
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    pending: Boolean = false,
    error: String? = null
) {
    AlertDialog(onDismissRequest = { if (!pending) onCancel() },
        title = { Text("Delete this transaction?") },
        text = { Text(error ?: "This cannot be undone.") },
        confirmButton = { TextButton(enabled = !pending, onClick = onConfirm) {
            Text(if (pending) "Deleting…" else "Delete", color = MaterialTheme.colorScheme.error)
        } },
        dismissButton = { TextButton(enabled = !pending, onClick = onCancel) { Text("Cancel") } })
}
