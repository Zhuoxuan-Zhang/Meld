package generated

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class ForestDisplay(
    val label: String,
    val trees: List<Pair<Tree, String>>
)

/** Reference overview hierarchy, without social or sharing controls. Host owns insets. */
@Composable
fun ForestScreen(model: GroveViewModel, modifier: Modifier = Modifier) {
    val state by model.state.collectAsStateWithLifecycle()
    val ui by model.ui.collectAsStateWithLifecycle()
    val now by model.now.collectAsStateWithLifecycle()
    val loaded by model.loaded.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val route = ui.navigation.current as? Route.Forest ?: Route.Forest()
    val index = route.periodIndex.coerceAtMost(0)
    val zone = ZoneId.systemDefault()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    var menuOpen by rememberSaveable { mutableStateOf(false) }
    val grid = rememberLazyGridState()
    val close = { model.navigate(Route.Home) }
    BackHandler(onBack = close)

    // Sorting, filtering and date formatting happen once per snapshot/period off-main.
    val display by produceState<ForestDisplay?>(null,
        state.trees, state.sessions, route.periodType, index, today, zone) {
        value = null
        value = withContext(Dispatchers.Default) {
            val range = periodRange(route.periodType, index, today, zone)
            val date = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
            val stamp = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
            val label = when (route.periodType) {
                PeriodType.DAY -> range.startDate.format(date)
                PeriodType.WEEK -> "${range.startDate.format(date)} – ${range.endDateExclusive.minusDays(1).format(date)}"
                PeriodType.MONTH -> range.startDate.format(DateTimeFormatter.ofPattern("MMMM yyyy"))
                PeriodType.YEAR -> range.startDate.year.toString()
            }
            val completed = state.sessions.filter { it.status == SessionStatus.COMPLETED }
                .mapTo(hashSetOf()) { it.id }
            ForestDisplay(label, state.trees.asSequence()
                .filter { it.sessionId in completed && range.contains(it.collectedAt) }
                .sortedWith(compareBy<Tree> { it.collectedAt }.thenBy { it.id })
                .map { it to Instant.ofEpochMilli(it.collectedAt).atZone(zone).format(stamp) }
                .toList())
        }
    }

    // One bounded scroll owner keeps every tree and every header control reachable.
    LazyVerticalGrid(
        columns = GridCells.Adaptive(144.dp), state = grid,
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item(key = "overview-header", span = { GridItemSpan(maxLineSpan) }) {
            Column {
                Surface(color = MaterialTheme.colorScheme.primaryContainer) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = close) { Icon(Icons.Outlined.Close, "Close forest") }
                        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                            TextButton(onClick = { menuOpen = true },
                                modifier = Modifier.semantics {
                                    contentDescription = "Your Forest, ${route.periodType.name.lowercase()}. Choose period"
                                }) {
                                Text("Your Forest", style = MaterialTheme.typography.titleMedium)
                                Icon(Icons.Outlined.ExpandMore, contentDescription = null)
                            }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                PeriodType.entries.forEach { type ->
                                    DropdownMenuItem(
                                        text = { Text(type.name.lowercase().replaceFirstChar { it.uppercase() }) },
                                        modifier = Modifier.semantics { selected = type == route.periodType },
                                        onClick = {
                                            menuOpen = false
                                            model.navigate(Route.Forest(type, 0))
                                        })
                                }
                            }
                        }
                        Spacer(Modifier.width(48.dp))
                    }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = {
                        model.navigate(Route.Forest(route.periodType, index - 1))
                    }, enabled = index > -10000) {
                        Icon(Icons.Outlined.ChevronLeft, "Previous period")
                    }
                    Text(display?.label ?: "Loading period…", Modifier.weight(1f),
                        textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall)
                    IconButton(onClick = {
                        model.navigate(Route.Forest(route.periodType, (index + 1).coerceAtMost(0)))
                    }, enabled = index < 0) { Icon(Icons.Outlined.ChevronRight, "Next period") }
                }
            }
        }
        if (error != null) item(key = "error", span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.padding(16.dp)) {
                Text(error ?: "Couldn't load your forest.", color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                TextButton(onClick = { model.tick(); model.retry() }, enabled = !busy) { Text("Try again") }
            }
        }
        when {
            !loaded || display == null -> item(key = "loading", span = { GridItemSpan(maxLineSpan) }) {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading forest" })
                }
            }
            display!!.trees.isEmpty() -> item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("No trees yet this period. Start a session to grow one.", textAlign = TextAlign.Center)
                    TextButton(onClick = close) { Text("Back to focus") }
                }
            }
            else -> items(display!!.trees, key = { it.first.id }) { (_, date) ->
                Column(Modifier.padding(horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    ForestTreeTile(Modifier.fillMaxWidth().aspectRatio(1f)
                        .clearAndSetSemantics { contentDescription = "Tree collected $date" })
                    Text(date, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center,
                        modifier = Modifier.padding(bottom = 8.dp))
                }
            }
        }
    }
}
