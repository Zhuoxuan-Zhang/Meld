package generated

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Reference-three modal hierarchy. Window and keyboard insets belong to the host. */
@Composable
fun StatsScreen(model: GroveViewModel, modifier: Modifier = Modifier) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val summary by model.summary.collectAsStateWithLifecycle()
    val loaded by model.loaded.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    val now by model.now.collectAsStateWithLifecycle()
    val type = ui.statsPeriodType
    val index = ui.statsPeriodIndex.coerceAtMost(0)
    val zone = ZoneId.systemDefault()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val label = remember(type, index, today, zone) {
        val range = periodRange(type, index, today, zone)
        val date = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
        when (type) {
            PeriodType.DAY -> range.startDate.format(date)
            PeriodType.WEEK -> "${range.startDate.format(date)} – ${range.endDateExclusive.minusDays(1).format(date)}"
            PeriodType.MONTH -> range.startDate.format(DateTimeFormatter.ofPattern("MMMM yyyy"))
            PeriodType.YEAR -> range.startDate.year.toString()
        }
    }
    var selectedBar by rememberSaveable(type, index) { mutableStateOf(-1) }
    val close = { model.navigate(Route.TasksGoal()) }
    BackHandler(onBack = close)

    // One vertical owner: task rows and all controls remain reachable at large text sizes.
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item(key = "header") {
            GrovePeriodHeader(
                title = "Focus Time Stats", periodLabel = label, onClose = close,
                onPrevious = { model.statsPeriod(type, index - 1) },
                onNext = { model.statsPeriod(type, index + 1) }, nextEnabled = index < 0
            )
        }
        item(key = "periods") {
            GrovePeriodSelector(type, { model.statsPeriod(it) }, Modifier.padding(horizontal = 16.dp))
        }
        if (error != null) item(key = "error") {
            Column(Modifier.padding(horizontal = 16.dp)) {
                Text(error.orEmpty(), color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                TextButton(onClick = model::retry, enabled = !busy) { Text("Try again") }
            }
        }
        if (!loaded) {
            item(key = "loading") {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading focus statistics" })
                }
            }
        } else {
            item(key = "distribution") {
                Surface(modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth(),
                    color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(12.dp)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Focused Time Distribution", style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.semantics { heading() })
                        HorizontalDivider()
                        Text("Total focused time: ${summary.totalMinutes} min",
                            style = MaterialTheme.typography.bodySmall)
                        if (summary.isEmpty) {
                            Text("No focus time recorded yet for this period.",
                                modifier = Modifier.padding(vertical = 24.dp)
                                    .semantics { liveRegion = LiveRegionMode.Polite })
                        } else {
                            summary.minutesByBucket.getOrNull(selectedBar)?.let { (bucket, minutes) ->
                                Surface(color = MaterialTheme.colorScheme.primaryContainer,
                                    shape = RoundedCornerShape(4.dp)) {
                                    Text("$bucket: $minutes min", Modifier.padding(8.dp)
                                        .semantics { liveRegion = LiveRegionMode.Polite })
                                }
                            }
                            MinuteBars(summary.minutesByBucket, selectedBar, type, index) {
                                selectedBar = if (selectedBar == it) -1 else it
                            }
                        }
                    }
                }
            }
            if (!summary.isEmpty) {
                item(key = "tasks-title") {
                    Text("Time by task", style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp)
                            .semantics { heading() })
                }
                itemsIndexed(summary.minutesByTask, key = { position, _ -> "task-$position" }) { _, pair ->
                    Surface(Modifier.padding(horizontal = 16.dp).fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp)) {
                        Row(Modifier.padding(16.dp).semantics(mergeDescendants = true) {},
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text(pair.first, Modifier.weight(1f), maxLines = 2,
                                overflow = TextOverflow.Ellipsis)
                            Text("${pair.second} min", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MinuteBars(
    buckets: List<Pair<String, Int>>,
    selected: Int,
    type: PeriodType,
    index: Int,
    onSelect: (Int) -> Unit
) {
    val maximum = remember(buckets) { (buckets.maxOfOrNull { it.second } ?: 0).coerceAtLeast(1) }
    Text("Tap a bar for exact minutes · Scroll for more",
        style = MaterialTheme.typography.bodySmall)
    // Native focusable click targets provide keyboard and screen-reader access to every value.
    key(type, index) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            buckets.forEachIndexed { position, (label, minutes) ->
                Column(Modifier.width(52.dp).clickable { onSelect(position) }
                    .semantics(mergeDescendants = true) {
                        contentDescription = "$label: $minutes focused minutes"
                        this.selected = selected == position
                        role = Role.Button
                    }.padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.height(160.dp).fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
                        Box(Modifier.fillMaxWidth()
                            .height((160f * minutes.coerceAtLeast(0) / maximum).dp.coerceAtLeast(1.dp))
                            .background(if (selected == position) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.primary.copy(alpha = 0.65f),
                                RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp)))
                    }
                    Text(label, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
