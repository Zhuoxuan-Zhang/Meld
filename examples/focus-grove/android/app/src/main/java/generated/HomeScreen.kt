package generated

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Reference-one composition: utility controls above one prominent growth circle. */
@Composable
fun HomeScreen(model: GroveViewModel, modifier: Modifier = Modifier) {
    val state by model.state.collectAsStateWithLifecycle()
    val ui by model.ui.collectAsStateWithLifecycle()
    val goal by model.goal.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val loaded by model.loaded.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    var picker by rememberSaveable { mutableStateOf(false) }
    var addAttempted by rememberSaveable { mutableStateOf(false) }
    var quickAddExpanded by rememberSaveable { mutableStateOf(false) }
    val scroll = rememberScrollState()
    val result = ui.terminalResult
    val focus = LocalFocusManager.current
    val draft = ui.drafts.quickTask
    val invalidName = draft.trim().length !in 1..80
    val task = state.activeTask
    val running = state.runningSession != null
    val canPlant = loaded && !busy && task != null && !running
    val submitTask = {
        addAttempted = true
        if (!invalidName && loaded && !busy) {
            model.addTask(draft, quick = true)
            focus.clearFocus()
        }
    }
    LaunchedEffect(draft) {
        if (draft.isEmpty()) {
            addAttempted = false
            quickAddExpanded = false
        }
    }
    // Runs on Home remount as well as when a newly resolved session arrives.
    // A restored scroll offset must never conceal retained terminal feedback.
    LaunchedEffect(result?.sessionId) {
        if (result != null) {
            focus.clearFocus()
            picker = false
            scroll.scrollTo(0)
        }
    }

    // The host owns Scaffold/system/IME insets. This screen owns one scroll viewport.
    BoxWithConstraints(modifier.fillMaxSize()) {
        val viewportHeight = with(LocalDensity.current) { maxHeight.roundToPx() }
        HomeFocusLayout(
            viewportHeight = viewportHeight,
            modifier = Modifier.fillMaxSize().verticalScroll(scroll),
            header = {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
            GroveUtilityHeader(goal.streakDays,
                onForest = { model.navigate(Route.Forest()) },
                onSettings = { model.navigate(Route.TasksGoal()) })
            Column(
                Modifier.widthIn(max = 600.dp).fillMaxWidth().padding(horizontal = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                result?.let { terminal ->
                    val collected = terminal.status == SessionStatus.COMPLETED
                    Surface(shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.primaryContainer) {
                        Column(Modifier.fillMaxWidth().padding(12.dp)) {
                            Text(if (collected) "Tree collected! Added to your forest."
                                else "Your tree withered. You can plant again.",
                                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                        }
                    }
                }
                if (result == null) {
                    Text("Let’s stay focused!", style = MaterialTheme.typography.titleMedium,
                        textAlign = TextAlign.Center)
                }
            }
                }
            },
            tree = {
                TreeGrowthVisual(
                    progressFraction = if (result != null) 1f else 0.12f,
                    withered = result?.status == SessionStatus.ABANDONED,
                    modifier = Modifier.fillMaxSize()
                )
            },
            controls = {
                Column(
                    Modifier.widthIn(max = 600.dp).fillMaxWidth().padding(horizontal = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                if (result != null) {
                    Button(onClick = model::acknowledgeResult,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text("Continue")
                    }
                } else {
                Text("${goal.focusedMinutes} / ${goal.goalMinutes} min today" +
                    if (goal.isMet) " · Goal met" else "",
                    style = MaterialTheme.typography.bodySmall)
                LinearProgressIndicator(progress = { goal.fraction },
                    modifier = Modifier.fillMaxWidth().height(6.dp).semantics {
                        contentDescription = "Daily focus goal"
                    })
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    OutlinedButton(onClick = { picker = true }, enabled = loaded && !busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(task?.let { "Active task: ${it.name}" } ?: "Choose a study task",
                            modifier = Modifier.weight(1f), maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                        Icon(Icons.Outlined.ExpandMore, contentDescription = null)
                    }
                    DropdownMenu(expanded = picker, onDismissRequest = { picker = false }) {
                        val available = state.tasks.filterNot { it.isCompleted }
                        if (available.isEmpty()) {
                            DropdownMenuItem(text = { Text("Add an incomplete task below") },
                                onClick = { picker = false })
                        }
                        available.forEach { item ->
                            key(item.id) {
                                DropdownMenuItem(text = { Text(item.name) },
                                    modifier = Modifier.semantics { selected = item.isActive },
                                    onClick = {
                                        picker = false
                                        model.task(TaskCommand.Select(item.id))
                                    })
                            }
                        }
                    }
                }
                if (task != null) {
                    IconButton(onClick = { quickAddExpanded = !quickAddExpanded },
                        enabled = loaded && !busy,
                        modifier = Modifier.semantics {
                            stateDescription = if (quickAddExpanded) "Expanded" else "Collapsed"
                        }) {
                        Icon(Icons.Outlined.Add, contentDescription = "Quick add a task")
                    }
                }
                }
                if (task == null || quickAddExpanded || draft.isNotEmpty()) {
                OutlinedTextField(value = draft,
                    onValueChange = { value -> model.editDraft { it.copy(quickTask = value) } },
                    label = { Text("Quick add a task…") }, singleLine = true,
                    enabled = loaded && !busy,
                    isError = addAttempted && invalidName,
                    supportingText = if (addAttempted && invalidName) {
                        { Text("Enter a task name between 1 and 80 characters.",
                            Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
                    } else null,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { submitTask() }),
                    modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { submitTask() }, enabled = loaded && !busy,
                    modifier = Modifier.align(Alignment.End)) { Text("Add task") }
                }
                Text("Duration: ${ui.drafts.durationMinutes} min")
                Slider(value = ui.drafts.durationMinutes.toFloat(),
                    onValueChange = { model.setDuration(it.toInt()) },
                    valueRange = 1f..120f, steps = 118, enabled = loaded && !busy && !running,
                    modifier = Modifier.fillMaxWidth().semantics {
                        contentDescription = "Session duration"
                        stateDescription = "${ui.drafts.durationMinutes} minutes"
                    })
                if (task == null) Text("Add a task above before planting.",
                    style = MaterialTheme.typography.bodySmall)
                if (running) Text("Finish or give up your current session before planting another.")
                error?.let { message ->
                    Text(message, color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    TextButton(onClick = model::retry, enabled = !busy) { Text("Try again") }
                }
                Button(onClick = { focus.clearFocus(); model.plant() }, enabled = canPlant,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
                        liveRegion = LiveRegionMode.Polite
                        stateDescription = if (canPlant) "Ready to plant" else "Plant unavailable"
                    }) { Text(if (busy) "Saving…" else "Plant") }
                }
                Spacer(Modifier.height(12.dp))
                }
            }
        )
    }
}

/** Measure the real controls first; give the artwork the remaining viewport.
 * When text, editors or the keyboard require more space, the single parent
 * scroll owner exposes the entire composition without shrinking touch targets.
 */
@Composable
private fun HomeFocusLayout(
    viewportHeight: Int,
    modifier: Modifier,
    header: @Composable () -> Unit,
    tree: @Composable () -> Unit,
    controls: @Composable () -> Unit
) {
    Layout(
        modifier = modifier,
        content = {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { header() }
            Box(contentAlignment = Alignment.Center) { tree() }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { controls() }
        }
    ) { measurables, constraints ->
        val width = constraints.maxWidth
        val natural = Constraints(minWidth = width, maxWidth = width)
        val headerPlaceable = measurables[0].measure(natural)
        val controlsPlaceable = measurables[2].measure(natural)
        val gap = 4.dp.roundToPx()
        val availableWidth = (width - 48.dp.roundToPx()).coerceAtLeast(0)
        val maximumTree = minOf(availableWidth, 300.dp.roundToPx())
        val minimumTree = minOf(maximumTree, 180.dp.roundToPx())
        val remaining = viewportHeight - headerPlaceable.height - controlsPlaceable.height - gap * 2
        val treeSize = remaining.coerceIn(minimumTree, maximumTree)
        val treePlaceable = measurables[1].measure(Constraints.fixed(treeSize, treeSize))
        val contentHeight = headerPlaceable.height + treeSize + controlsPlaceable.height + gap * 2
        layout(width, constraints.constrainHeight(contentHeight)) {
            headerPlaceable.placeRelative(0, 0)
            treePlaceable.placeRelative((width - treeSize) / 2, headerPlaceable.height + gap)
            controlsPlaceable.placeRelative(0, headerPlaceable.height + gap + treeSize + gap)
        }
    }
}
