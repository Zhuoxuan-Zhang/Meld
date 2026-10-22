package generated

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Rounded configuration panels; the host consumes Scaffold and keyboard insets. */
@Composable
fun TasksGoalScreen(model: GroveViewModel, modifier: Modifier = Modifier) {
    val state by model.state.collectAsStateWithLifecycle()
    val ui by model.ui.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val loaded by model.loaded.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    val progress by model.goal.collectAsStateWithLifecycle()
    val draft = ui.drafts
    val enabled = loaded && !busy
    var addAttempt by rememberSaveable { mutableStateOf(false) }
    val invalidName = draft.newTask.trim().length !in 1..80
    val validGoal = draft.goal.isNotEmpty() && draft.goal.all { it in '0'..'9' } &&
        draft.goal.toIntOrNull()?.let { it in 1..1440 } == true
    val add = {
        addAttempt = true
        if (!invalidName && enabled) model.addTask(draft.newTask)
    }
    LaunchedEffect(draft.newTask) { if (draft.newTask.isEmpty()) addAttempt = false }
    BackHandler { model.back() }

    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item(key = "header") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { model.back() }) { Icon(Icons.Outlined.ArrowBack, "Back to focus") }
                Text("Tasks & Goal", style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f).semantics { heading() })
                TextButton(onClick = { model.navigate(Route.Stats) }) { Text("Stats") }
            }
        }
        item(key = "add") {
            Surface(shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(16.dp)) {
                    OutlinedTextField(draft.newTask,
                        onValueChange = { value -> model.editDraft { it.copy(newTask = value) } },
                        label = { Text("New task name") }, enabled = enabled,
                        singleLine = true, isError = addAttempt && invalidName,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { add() }),
                        modifier = Modifier.fillMaxWidth())
                    if (addAttempt && invalidName) EditorError("Enter a task name between 1 and 80 characters.")
                    Button(onClick = { add() }, enabled = enabled,
                        modifier = Modifier.fillMaxWidth()) { Text("Add") }
                }
            }
        }
        if (state.tasks.isEmpty()) item(key = "empty") {
            Text(if (loaded) "No tasks yet. Add your first task above." else "Loading tasks…")
        }
        items(state.tasks, key = { it.id }) { task ->
            Surface(shape = MaterialTheme.shapes.medium) {
                Column(Modifier.fillMaxWidth().padding(8.dp)) {
                    Row(Modifier.fillMaxWidth().clickable(enabled = enabled && !task.isCompleted) {
                        model.task(TaskCommand.Select(task.id))
                    }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = task.isActive,
                            onClick = { model.task(TaskCommand.Select(task.id)) },
                            enabled = enabled && !task.isCompleted,
                            modifier = Modifier.semantics { contentDescription = "Select ${task.name} as active task" })
                        Text(task.name, Modifier.weight(1f).padding(end = 8.dp))
                    }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(task.isCompleted, onCheckedChange = {
                            model.task(TaskCommand.SetCompleted(task.id, it))
                        }, enabled = enabled, modifier = Modifier.semantics {
                            contentDescription = "Mark ${task.name} complete"
                        })
                        Text(if (task.isCompleted) "Complete" else "Incomplete",
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                        IconButton(onClick = {
                            model.dismissError()
                            model.editDraft { it.copy(renameTaskId = task.id, renameText = task.name) }
                        }, enabled = enabled) { Icon(Icons.Outlined.Edit, "Rename ${task.name}") }
                        IconButton(onClick = {
                            model.dismissError(); model.requestDelete(task.id)
                        }, enabled = enabled) { Icon(Icons.Outlined.DeleteOutline, "Delete task ${task.name}") }
                    }
                }
            }
        }
        item(key = "goal") {
            Surface(shape = MaterialTheme.shapes.medium) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Daily focus goal", style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.semantics { heading() })
                    Text("${progress.focusedMinutes} / ${progress.goalMinutes} min today · ${progress.streakDays} day streak")
                    OutlinedTextField(draft.goal, onValueChange = { value ->
                        model.editDraft { it.copy(goal = value.take(4)) }
                    }, label = { Text("Daily goal (minutes)") }, enabled = enabled,
                        singleLine = true, isError = !validGoal,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (enabled && validGoal) model.saveDailyGoal() }),
                        modifier = Modifier.fillMaxWidth())
                    if (!validGoal) EditorError("Enter a whole number between 1 and 1440.")
                    Button(onClick = model::saveDailyGoal, enabled = enabled && validGoal,
                        modifier = Modifier.fillMaxWidth()) { Text("Save") }
                }
            }
        }
        error?.let { message -> item(key = "error") {
            EditorError(message)
            TextButton(onClick = model::retry, enabled = enabled) { Text("Try again") }
        } }
    }

    draft.renameTaskId?.let { id ->
        TaskEditorDialog(onDismiss = {
            model.editDraft { it.copy(renameTaskId = null, renameText = "") }
        }) {
            Text("Rename task", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(draft.renameText, onValueChange = { value ->
                model.editDraft { it.copy(renameText = value) }
            }, label = { Text("Task name") }, modifier = Modifier.fillMaxWidth(), enabled = enabled,
                isError = draft.renameText.trim().length !in 1..80)
            if (draft.renameText.trim().length !in 1..80) EditorError("Enter 1–80 characters.")
            error?.let { EditorError(it) }
            Button(onClick = { model.task(TaskCommand.Rename(id, draft.renameText)) },
                enabled = enabled && draft.renameText.trim().length in 1..80,
                modifier = Modifier.fillMaxWidth()) { Text("Save") }
            TextButton(onClick = { model.editDraft { it.copy(renameTaskId = null, renameText = "") } },
                enabled = !busy) { Text("Cancel") }
        }
    }
    if (ui.deleteTaskId != null) TaskEditorDialog({ if (!busy) model.requestDelete(null) }) {
        Text("Delete this task?", style = MaterialTheme.typography.titleMedium)
        Text("This can’t be undone. Previous focus time will be retained.")
        error?.let { EditorError(it) }
        Button(onClick = model::confirmDelete, enabled = enabled) { Text("Delete") }
        TextButton(onClick = { model.requestDelete(null) }, enabled = !busy) { Text("Cancel") }
    }
    if (ui.showUnsavedDialog) TaskEditorDialog(model::keepEditing) {
        Text("Discard unsaved changes?", style = MaterialTheme.typography.titleMedium)
        Text("Your unfinished task and goal edits will be discarded.")
        Button(onClick = model::discardChanges, enabled = !busy) { Text("Discard") }
        TextButton(onClick = model::keepEditing) { Text("Keep editing") }
    }
}

@Composable
private fun EditorError(message: String) {
    Text(message, color = MaterialTheme.colorScheme.error,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}

/** One bounded scroll viewport includes heading, fields and actions above the IME. */
@Composable
private fun TaskEditorDialog(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(16.dp),
            contentAlignment = Alignment.Center) {
            Surface(shape = MaterialTheme.shapes.large,
                modifier = Modifier.widthIn(max = 560.dp).fillMaxWidth()) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
            }
        }
    }
}
