package generated

import android.app.DatePickerDialog
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.YearMonth

/** Separate modal window owns its insets; the host consumes its Scaffold insets. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransactionEditorSheet(state: AppUiState, onEvent: (AppEvent) -> Unit) {
    val draft = state.session.draft?.current ?: return
    val snapshot = state.snapshot ?: return
    val errors = remember(draft, snapshot.categories) {
        validateDraft(draft, snapshot.categories)
    }
    val context = LocalContext.current
    val pending by rememberUpdatedState(state.pending)
    val dispatch by rememberUpdatedState(onEvent)
    val sheetState = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        confirmValueChange = { target ->
            if (target == SheetValue.Hidden) {
                // The navigation owner closes clean drafts or asks about unsaved edits.
                // Keep the sheet visible until that decision removes its route.
                if (!pending) dispatch(AppEvent.Back)
                false
            } else {
                true
            }
        }
    )
    ModalBottomSheet(
        onDismissRequest = { if (!state.pending) onEvent(AppEvent.Back) },
        sheetState = sheetState,
        dragHandle = null,
        containerColor = MaterialTheme.colorScheme.surface,
        contentWindowInsets = { WindowInsets.safeDrawing }
    ) {
        Column(
            Modifier.fillMaxWidth().imePadding()
                .verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(if (draft.transactionId == null) "Add transaction" else "Edit transaction",
                style = MaterialTheme.typography.headlineSmall)
            EditorCategories(snapshot.categories, draft.categoryId, !state.pending) {
                onEvent(AppEvent.ChangeDraft(draft.copy(categoryId = it)))
            }
            OutlinedTextField(
                value = draft.title,
                onValueChange = { onEvent(AppEvent.ChangeDraft(draft.copy(title = it))) },
                label = { Text("Title") }, maxLines = 2,
                enabled = !state.pending, isError = errors.containsKey("title"),
                supportingText = { errors["title"]?.let { Text(it) } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth()
            )
            MoneyEditor(draft.amountText, "Amount in dollars", errors["amount"], !state.pending) {
                onEvent(AppEvent.ChangeDraft(draft.copy(amountText = it)))
            }
            Row(Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TransactionType.entries.forEach { type ->
                    FilterChip(selected = draft.type == type, enabled = !state.pending,
                        onClick = { onEvent(AppEvent.ChangeDraft(draft.copy(type = type))) },
                        label = { Text(if (type == TransactionType.EXPENSE) "Expense" else "Income") })
                }
            }
            OutlinedTextField(
                value = draft.dateText,
                onValueChange = { onEvent(AppEvent.ChangeDraft(draft.copy(dateText = it))) },
                label = { Text("Date · YYYY-MM-DD") }, singleLine = true,
                enabled = !state.pending, isError = errors.containsKey("date"),
                supportingText = { errors["date"]?.let { Text(it) } },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth()
            )
            TextButton(enabled = !state.pending, onClick = {
                val date = parseLedgerDate(draft.dateText) ?: LocalDate.now()
                DatePickerDialog(context, { _, year, month, day ->
                    onEvent(AppEvent.ChangeDraft(draft.copy(
                        dateText = LocalDate.of(year, month + 1, day).toString())))
                }, date.year, date.monthValue - 1, date.dayOfMonth).show()
            }) { Text("Choose date") }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                enabled = !state.pending && errors.isEmpty(),
                onClick = { onEvent(AppEvent.Save) }, modifier = Modifier.fillMaxWidth()
            ) { Text(if (state.pending) "Saving…" else "Save") }
            OutlinedButton(enabled = !state.pending, onClick = { onEvent(AppEvent.Cancel) },
                modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
            draft.transactionId?.let { id ->
                TextButton(enabled = !state.pending,
                    onClick = { onEvent(AppEvent.RequestDelete(id)) },
                    modifier = Modifier.fillMaxWidth()) {
                    Text("Delete transaction", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

/** Host supplies safe area and IME padding; this bounded form has one scroll owner. */
@Composable
fun BudgetSetupScreen(state: AppUiState, onEvent: (AppEvent) -> Unit) {
    val draft = state.session.budget ?: return
    val categories = state.snapshot?.categories ?: return
    val category = categories.find { it.id == draft.categoryId } ?: return
    val amount = remember(draft.limitText) { parsePositiveCents(draft.limitText) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Reference-three grouping: category chips above prominent monthly amount.
        EditorCategories(listOf(category), category.id, false) {}
        Text(category.name, style = MaterialTheme.typography.titleLarge)
        Card(shape = RoundedCornerShape(18.dp), colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primary.copy(alpha = .12f))) {
            Column(Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Monthly budget", style = MaterialTheme.typography.titleMedium)
                Text(amount?.let(::ledgerMoney) ?: "Set a limit",
                    style = MaterialTheme.typography.headlineSmall)
                Text("Per calendar month · USD")
                Text("${YearMonth.now().atDay(1)} – ${YearMonth.now().atEndOfMonth()}",
                    style = MaterialTheme.typography.bodySmall)
            }
        }
        MoneyEditor(draft.limitText, "Monthly limit in dollars for ${category.name}",
            if (amount == null) "Limit must be a positive amount." else null,
            !state.pending) { onEvent(AppEvent.ChangeLimit(it)) }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = amount != null && !state.pending,
            onClick = { onEvent(AppEvent.Save) }, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.pending) "Saving…" else "Save")
        }
        OutlinedButton(enabled = !state.pending, onClick = { onEvent(AppEvent.Cancel) },
            modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
    }
}

@Composable
private fun EditorCategories(
    categories: List<Category>, selectedId: String, enabled: Boolean,
    onSelect: (String) -> Unit
) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        categories.forEach { category ->
            FilterChip(selected = selectedId == category.id, enabled = enabled,
                onClick = { onSelect(category.id) },
                leadingIcon = { CategoryIcon(category, Modifier.size(28.dp)) },
                label = { Text(category.name) })
        }
    }
}

@Composable
private fun MoneyEditor(
    value: String, label: String, error: String?, enabled: Boolean,
    onChange: (String) -> Unit
) {
    OutlinedTextField(value = value, onValueChange = onChange,
        label = { Text(label) }, prefix = { Text("$") },
        singleLine = true, enabled = enabled, isError = error != null,
        supportingText = { Text(error ?: "USD · up to two decimal places") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal,
            imeAction = ImeAction.Next),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = label })
}
