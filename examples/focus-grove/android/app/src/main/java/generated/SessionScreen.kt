package generated

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Headphones
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale

/** Extends the reference's centered growth circle; the host owns window insets. */
@Composable
fun SessionScreen(model: GroveViewModel, modifier: Modifier = Modifier) {
    val state by model.state.collectAsStateWithLifecycle()
    val ui by model.ui.collectAsStateWithLifecycle()
    val now by model.now.collectAsStateWithLifecycle()
    val sound by model.sound.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    val soundError by model.soundError.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val running = state.runningSession
    val result = ui.terminalResult
    val session = running ?: state.sessions.firstOrNull { it.id == result?.sessionId }
    var soundsOpen by rememberSaveable(session?.id) { mutableStateOf(false) }

    BackHandler(enabled = running != null) {
        if (ui.showGiveUpDialog) model.giveUpDialog(false)
    }

    BoxWithConstraints(modifier.fillMaxSize()) {
        val treeSize = minOf(maxWidth - 32.dp, maxHeight * 0.46f)
            .coerceIn(128.dp, 360.dp)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (session == null) {
                Text("No session in progress", style = MaterialTheme.typography.titleLarge)
                Button(onClick = { model.navigate(Route.Home) }) { Text("Back to focus") }
            } else {
                val seconds = remainingSeconds(session, now)
                val progress = if (session.status == SessionStatus.COMPLETED) 1f else
                    ((now - session.startedAt).toDouble() /
                        (session.durationMinutes * 60_000L)).toFloat().coerceIn(0f, 1f)
                val taskName = state.tasks.firstOrNull { it.id == session.taskId }?.name
                    ?: session.taskName.ifBlank { "Study task" }
                Text("Focus Grove", style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.semantics { heading() })
                Text("Focusing on $taskName", textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyLarge)
                Text(
                    String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60),
                    style = MaterialTheme.typography.displaySmall,
                    modifier = Modifier.clearAndSetSemantics {
                        contentDescription = "${(seconds + 59) / 60} minutes remaining"
                        liveRegion = LiveRegionMode.Polite
                    }
                )
                Spacer(Modifier.height(8.dp))
                TreeGrowthVisual(progress, session.status == SessionStatus.ABANDONED,
                    Modifier.size(treeSize))
                Spacer(Modifier.height(8.dp))
                Column(Modifier.widthIn(max = 560.dp).fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    when (session.status) {
                        SessionStatus.COMPLETED -> Text("Tree collected! Added to your forest.",
                            Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                        SessionStatus.ABANDONED -> Text("Your tree withered. You can plant again.",
                            Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                        SessionStatus.RUNNING -> {
                            if (seconds == 0L) Text(
                                if (busy) "Collecting your tree…" else "Your tree is ready to collect.")
                            OutlinedButton(onClick = { soundsOpen = !soundsOpen },
                                modifier = Modifier.heightIn(min = 48.dp).semantics {
                                    stateDescription = if (soundsOpen) "Expanded" else "Collapsed"
                                }) {
                                Icon(Icons.Outlined.Headphones, contentDescription = null)
                                Spacer(Modifier.width(8.dp))
                                Text("Focus sounds")
                            }
                            if (soundsOpen) {
                                Surface(shape = MaterialTheme.shapes.medium,
                                    color = MaterialTheme.colorScheme.surface,
                                    modifier = Modifier.fillMaxWidth()) {
                                    Column(Modifier.padding(16.dp),
                                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Text("Focus sounds", style = MaterialTheme.typography.titleMedium)
                                        // Two columns keep each target usable on narrow screens.
                                        SoundLoop.entries.chunked(2).forEach { pair ->
                                            Row(Modifier.fillMaxWidth(),
                                                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                                pair.forEach { loop ->
                                                    OutlinedButton(
                                                        onClick = { model.selectSound(loop) },
                                                        modifier = Modifier.weight(1f).heightIn(min = 48.dp)
                                                            .semantics {
                                                                selected = sound.selectedSound == loop
                                                            }) {
                                                        Text(loop.name.lowercase().replaceFirstChar { it.uppercase() })
                                                    }
                                                }
                                            }
                                        }
                                        Text("Volume ${(sound.volume * 100).toInt()}%",
                                            style = MaterialTheme.typography.bodySmall)
                                        Slider(value = sound.volume, onValueChange = model::volume,
                                            modifier = Modifier.semantics { contentDescription = "Sound volume" })
                                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                            TextButton(
                                                onClick = {
                                                    if (sound.isPlaying) model.stopSound() else model.resumeSound()
                                                }, enabled = sound.selectedSound != SoundLoop.NONE) {
                                                Text(if (sound.isPlaying) "Pause" else "Play")
                                            }
                                            TextButton(onClick = { model.selectSound(SoundLoop.NONE) }) {
                                                Text("Stop")
                                            }
                                        }
                                        soundError?.let {
                                            Text(it, color = MaterialTheme.colorScheme.error,
                                                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                                        }
                                    }
                                }
                            }
                            OutlinedButton(onClick = { model.giveUpDialog(true) },
                                enabled = !busy && seconds > 0L,
                                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                                Text("Give Up")
                            }
                        }
                    }
                    error?.let {
                        Text(it, color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                        TextButton(onClick = model::retry, enabled = !busy) { Text("Try again") }
                    }
                    if (session.isTerminal) Button(onClick = {
                        model.acknowledgeResult()
                        model.navigate(Route.Home)
                    }, modifier = Modifier.fillMaxWidth()) { Text("Continue") }
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }

    if (ui.showGiveUpDialog && running != null) {
        AlertDialog(
            onDismissRequest = { model.giveUpDialog(false) },
            title = { Text("Give up this session?") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text("Your tree will wither and won’t be saved.")
                    error?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(it, color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = model::confirmGiveUp, enabled = !busy) {
                    Text(if (busy) "Saving…" else "Give Up")
                }
            },
            dismissButton = {
                TextButton(onClick = { model.giveUpDialog(false) }) { Text("Keep focusing") }
            }
        )
    }
}
