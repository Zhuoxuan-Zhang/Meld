package generated

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The host owns safe-area/IME padding and discard confirmation. Preview is read-only. */
@Composable
fun PurchaseSandboxScreen(
    state: AppUiState,
    today: LocalDate,
    onEvent: (AppEvent) -> Unit
) {
    val session = state.session.draft ?: return
    if (!session.isSandbox) return
    val draft = session.current
    val snapshot = state.snapshot ?: return
    val category = snapshot.categories.find { it.id == draft.categoryId }
    val hasBudget = category?.monthlyLimitCents != null
    val errors = remember(draft, snapshot.categories) {
        validateDraft(draft, snapshot.categories)
    }
    // Key the result as well as the producer so a previous amount's comparison
    // cannot enable Record for a newly entered amount while calculation runs.
    val preview by produceState<Result<Comparison>?>(
        initialValue = null, key1 = snapshot, key2 = draft, key3 = today
    ) {
        value = null
        if (hasBudget && errors.isEmpty()) {
            value = withContext(Dispatchers.Default) {
                previewPurchase(snapshot, draft, today)
            }
        }
    }
    val comparison = if (hasBudget && errors.isEmpty()) preview?.getOrNull() else null
    val change: (TransactionDraft) -> Unit = {
        if (!state.pending) onEvent(AppEvent.ChangeDraft(it))
    }
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("See how it fits", style = MaterialTheme.typography.headlineSmall)
        Text("Nothing is saved until you tap Record. Purchases are recorded as expenses for today.",
            style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = draft.title, onValueChange = { change(draft.copy(title = it)) },
            label = { Text("Title") }, enabled = !state.pending, maxLines = 2,
            isError = draft.title.isNotEmpty() && errors.containsKey("title"),
            supportingText = {
                if (draft.title.isNotEmpty()) errors["title"]?.let { Text(it) }
            },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = draft.amountText, onValueChange = { change(draft.copy(amountText = it)) },
            label = { Text("Amount") }, prefix = { Text("$") },
            enabled = !state.pending, singleLine = true,
            isError = draft.amountText.isNotEmpty() && errors.containsKey("amount"),
            supportingText = {
                Text(if (draft.amountText.isNotEmpty()) errors["amount"]
                    ?: "USD · up to two decimal places" else "USD · up to two decimal places")
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal,
                imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth().semantics {
                contentDescription = "Amount in dollars"
            }
        )
        Text("Category", style = MaterialTheme.typography.titleSmall)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            snapshot.categories.forEach { item ->
                FilterChip(
                    selected = item.id == draft.categoryId, enabled = !state.pending,
                    onClick = { change(draft.copy(categoryId = item.id)) },
                    leadingIcon = { CategoryIcon(item, Modifier.size(28.dp)) },
                    label = { Text(item.name) }
                )
            }
        }
        if (!hasBudget) {
            Card(shape = RoundedCornerShape(18.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("This category has no budget yet. Set one first.")
                    Button(enabled = category != null && !state.pending, onClick = {
                        category?.let { onEvent(AppEvent.Open(DetailRoute.Budget(it.id))) }
                    }) { Text("Set monthly budget") }
                }
            }
        } else if (comparison != null) {
            SandboxComparisonCard("${category?.name} budget remaining",
                comparison.beforeRemainingCents, comparison.afterRemainingCents)
            SandboxComparisonCard("Daily allowance",
                comparison.beforeAllowanceCents, comparison.afterAllowanceCents)
            Text("Daily allowance uses all category limits minus this month's expenses, divided by days remaining including today.",
                style = MaterialTheme.typography.bodySmall)
            if (comparison.afterRemainingCents < 0 || comparison.afterAllowanceCents < 0) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Default.Warning, null, tint = MaterialTheme.colorScheme.error)
                    Text("This purchase goes over budget. You can still explicitly record it.",
                        color = MaterialTheme.colorScheme.error)
                }
            }
        } else if (hasBudget && errors.isEmpty()) {
            if (preview == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            else Text(preview?.exceptionOrNull()?.message ?: "Couldn't calculate this preview.",
                color = MaterialTheme.colorScheme.error)
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            enabled = !state.pending && comparison != null && errors.isEmpty(),
            onClick = { onEvent(AppEvent.Record) }, modifier = Modifier.fillMaxWidth()
                .semantics { liveRegion = LiveRegionMode.Polite }
        ) { Text(if (state.pending) "Recording…" else "Record") }
        OutlinedButton(enabled = !state.pending, onClick = { onEvent(AppEvent.Cancel) },
            modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
    }
}

@Composable
private fun SandboxComparisonCard(label: String, before: Long, after: Long) {
    Card(shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()
        .semantics(mergeDescendants = true) {
            contentDescription = "$label. Before ${ledgerMoney(before)}. After ${ledgerMoney(after)}."
        }, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.titleMedium)
            Text("Before · ${ledgerMoney(before)}")
            Text("After · ${ledgerMoney(after)}", style = MaterialTheme.typography.headlineSmall,
                color = if (after < 0) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.primary)
        }
    }
}
