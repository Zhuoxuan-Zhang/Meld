package com.meld.minefield

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.view.WindowCompat

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent { MinefieldApp() }
  }
}

private val LightColors = lightColorScheme(
  primary = Color(0xFF1565C0), onPrimary = Color.White,
  background = Color(0xFFFAFAF7), onBackground = Color(0xFF1B1B1B),
  surface = Color.White, onSurface = Color(0xFF1B1B1B),
  primaryContainer = Color(0xFFE3EFFF), onPrimaryContainer = Color(0xFF123B66),
  secondaryContainer = Color(0xFFE3EFFF), onSecondaryContainer = Color(0xFF123B66),
  outlineVariant = Color(0xFF7D8792),
  surfaceVariant = Color(0xFFEBEEF1), onSurfaceVariant = Color(0xFF455463),
  error = Color(0xFFC62828)
)
private val DarkColors = darkColorScheme(
  primary = Color(0xFF90CAF9), onPrimary = Color(0xFF0D1B2A),
  background = Color(0xFF121212), onBackground = Color(0xFFF2F2F2),
  surface = Color(0xFF1E1E1E), onSurface = Color(0xFFF2F2F2),
  primaryContainer = Color(0xFF173C60), onPrimaryContainer = Color(0xFFD1E6FF),
  secondaryContainer = Color(0xFF173C60), onSecondaryContainer = Color(0xFFD1E6FF),
  outlineVariant = Color(0xFF7B8794),
  surfaceVariant = Color(0xFF2B323A), onSurfaceVariant = Color(0xFFD1D9E1),
  error = Color(0xFFFFB4AB)
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MinefieldApp(model: GameViewModel = viewModel()) {
  val state by model.state.collectAsStateWithLifecycle()
  val session = state.session
  val dark = when (session?.preferences?.appearance) {
    Appearance.DARK -> true
    Appearance.LIGHT -> false
    else -> isSystemInDarkTheme()
  }
  var page by rememberSaveable { mutableStateOf("Game") }
  var selected by rememberSaveable { mutableIntStateOf(40) }
  var restart by rememberSaveable { mutableStateOf(false) }
  var marking by rememberSaveable { mutableStateOf<Int?>(null) }
  var exitWarning by remember { mutableStateOf(false) }
  var recover by remember { mutableStateOf(false) }
  val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
  val activity = LocalActivity.current
  val view = LocalView.current
  val pageScroll = rememberScrollState()
  LaunchedEffect(state.error) {
    if (state.error != null) pageScroll.animateScrollTo(0)
  }
  SideEffect {
    model.clockVisible = lifecycle == Lifecycle.State.RESUMED && page == "Game" && !restart && marking == null && !exitWarning
    activity?.window?.let { window ->
      WindowCompat.getInsetsController(window, view).apply {
        isAppearanceLightStatusBars = !dark
        isAppearanceLightNavigationBars = !dark
      }
    }
  }
  DisposableEffect(model) { onDispose { model.clockVisible = false } }
  BackHandler(enabled = page != "Game" || state.dirty || state.busy) {
    if (page != "Game") page = "Game" else exitWarning = true
  }
  MaterialTheme(colorScheme = if (dark) DarkColors else LightColors) {
    Scaffold(
      containerColor = MaterialTheme.colorScheme.background,
      bottomBar = {
        if (session != null) NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
          listOf("Game" to Icons.Outlined.GridOn, "Statistics" to Icons.Outlined.BarChart, "Settings" to Icons.Outlined.Settings).forEach { (name, icon) ->
            NavigationBarItem(selected = page == name, onClick = { page = name }, icon = { Icon(icon, null) }, label = { Text(name) })
          }
        }
      }
    ) { padding ->
      Column(Modifier.padding(padding).fillMaxSize().verticalScroll(pageScroll).padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(12.dp))
        Text(if (page == "Game") "Minefield Plus" else page, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        if (page != "Game") Text(if (page == "Statistics") "Your progress, kept on this device." else "Make room for your way to play.",
          color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(12.dp))
        if (state.loading) {
          CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading saved game" })
        } else if (session == null) {
          Text(state.error ?: "Couldn't open the saved game.")
          Button(onClick = model::load, enabled = !state.busy) { Text("Retry loading") }
          OutlinedButton(onClick = { recover = true }, enabled = !state.busy) { Text("Start fresh") }
        } else {
          val saveError = state.error
          if (saveError != null) {
            ElevatedCard(Modifier.fillMaxWidth()) {
              Column(Modifier.padding(16.dp)) {
                Text(saveError, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                TextButton(onClick = model::retrySave, enabled = !state.busy) { Text("Retry save") }
              }
            }
            Spacer(Modifier.height(12.dp))
          }
          when (page) {
            "Game" -> GamePage(session, selected, { selected = it }, dark, !state.busy && !state.dirty,
              { model.update(change = it) }, { restart = true }, { marking = it })
            "Statistics" -> StatisticsPage(session)
            else -> SettingsPage(session.preferences, !state.busy && !state.dirty) { preferences ->
              model.update { it.copy(preferences = preferences) }
            }
          }
        }
        Spacer(Modifier.height(24.dp))
      }
    }
    if (restart) AlertDialog(
      onDismissRequest = { restart = false }, title = { Text("Start a new game?") },
      text = { Text("Your current board and undo will be replaced. Completed game statistics stay.") },
      confirmButton = { TextButton(enabled = !state.busy && !state.dirty, onClick = {
        restart = false; selected = 40; model.update(replacement = true) { Game.newGame(it) }
      }) { Text("New game") } },
      dismissButton = { TextButton(onClick = { restart = false }) { Text("Cancel") } }
    )
    val markIndex = marking
    if (markIndex != null) AlertDialog(
      onDismissRequest = { marking = null },
      title = { Text("Pencil mark") },
      text = {
        Column {
          Text("Row ${markIndex / 9 + 1}, column ${markIndex % 9 + 1}. A personal guess, not a hint.")
          Spacer(Modifier.height(12.dp))
          FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            (1..8).forEach { digit ->
              OutlinedButton(enabled = !state.busy && !state.dirty, onClick = {
                marking = null; model.update { Game.mark(it, markIndex, digit) }
              }, modifier = Modifier.semantics { contentDescription = "Mark $digit" }) { Text("$digit") }
            }
          }
          TextButton(enabled = !state.busy && !state.dirty, onClick = {
            marking = null; model.update { Game.mark(it, markIndex, 0) }
          }) { Text("Clear mark") }
        }
      },
      confirmButton = { TextButton(onClick = { marking = null }) { Text("Cancel") } }
    )
    if (exitWarning) AlertDialog(
      onDismissRequest = { exitWarning = false }, title = { Text("Keep your progress safe") },
      text = { Text(if (state.dirty) "Some progress hasn't been saved. Stay here and retry before closing the app." else "Saving your latest move. Please wait a moment.") },
      confirmButton = { TextButton(onClick = { model.retrySave(); exitWarning = false }) { Text("Retry save") } },
      dismissButton = { TextButton(onClick = { exitWarning = false }) { Text("Stay") } }
    )
    if (recover) AlertDialog(
      onDismissRequest = { recover = false }, title = { Text("Preserve save and start fresh?") },
      text = { Text("The unreadable save will be kept on this device for recovery. Your new game starts with empty statistics and default settings.") },
      confirmButton = { TextButton(onClick = { recover = false; model.recover() }) { Text("Preserve and start") } },
      dismissButton = { TextButton(onClick = { recover = false }) { Text("Cancel") } }
    )
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GamePage(
  session: Session, selected: Int, select: (Int) -> Unit, dark: Boolean, enabled: Boolean,
  update: ((Session) -> Session) -> Unit, restart: () -> Unit, mark: (Int) -> Unit
) {
  val b = session.board
  val playable = enabled && !b.complete && !b.paused
  ElevatedCard(Modifier.fillMaxWidth(), colors = CardDefaults.elevatedCardColors(containerColor = MaterialTheme.colorScheme.surface)) {
    Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
      Column { Text("MINES LEFT", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("${b.remaining.toString().padStart(2, '0')}", style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold) }
      Column(horizontalAlignment = Alignment.End) { Text("TIME", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(formatTime(b.seconds), style = MaterialTheme.typography.titleLarge, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold) }
    }
  }
  Spacer(Modifier.height(8.dp))
  val heading = when {
    b.paused -> "Take a breather"
    b.phase == Phase.WON -> "Field cleared. Nicely done!"
    b.phase == Phase.LOST -> "A mine! Take another look."
    b.phase == Phase.READY -> "Your first tap is always safe."
    else -> "Find the quiet path."
  }
  Text(heading, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
  if (b.complete) Text("Undo your last move, or start a new game.", style = MaterialTheme.typography.bodySmall)
  Spacer(Modifier.height(8.dp))
  if (b.paused) {
    Surface(Modifier.fillMaxWidth().height(320.dp), shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
      Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Outlined.Pause, null, Modifier.size(40.dp))
        Text("Game paused", style = MaterialTheme.typography.titleLarge)
        Text("Your board is saved.")
        Button(enabled = enabled, onClick = { update { it.copy(board = it.board.copy(paused = false)) } }) { Text("Resume") }
      }
    }
  } else {
    BoardGrid(b, selected, dark, playable, { index ->
      select(index)
      when (b.mode) {
        InputMode.REVEAL -> update { Game.reveal(it, index) }
        InputMode.FLAG -> update { Game.flag(it, index) }
        InputMode.MARK -> if (!b.cells[index].revealed && !b.cells[index].flagged) mark(index)
      }
    }, { index -> select(index); update { Game.flag(it, index) } })
  }
  Spacer(Modifier.height(8.dp))
  FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    InputMode.entries.forEach { mode ->
      FilterChip(selected = b.mode == mode, enabled = playable, onClick = { update { it.copy(board = it.board.copy(mode = mode)) } },
        label = { Text(when (mode) { InputMode.REVEAL -> "Reveal"; InputMode.FLAG -> "Flag"; InputMode.MARK -> "Pencil" }) },
        leadingIcon = { Icon(when (mode) { InputMode.REVEAL -> Icons.Outlined.TouchApp; InputMode.FLAG -> Icons.Outlined.Flag; InputMode.MARK -> Icons.Outlined.Edit }, null, Modifier.size(18.dp)) })
    }
  }
  FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    OutlinedButton(enabled = enabled && session.undo != null && !b.paused, onClick = { update(Game::undo) }) {
      Icon(Icons.AutoMirrored.Outlined.Undo, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Undo")
    }
    OutlinedButton(enabled = enabled && b.phase == Phase.PLAYING, onClick = { update { it.copy(board = it.board.copy(paused = !it.board.paused)) } }) {
      Icon(if (b.paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(if (b.paused) "Resume" else "Pause")
    }
    OutlinedButton(enabled = enabled, onClick = restart) { Text("New game") }
  }
  Spacer(Modifier.height(12.dp))
  HorizontalDivider()
  Spacer(Modifier.height(12.dp))
  Text("Selected: row ${selected / 9 + 1}, column ${selected % 9 + 1}", style = MaterialTheme.typography.labelLarge)
  Text("Use these larger controls, or tap the board. Long-press to flag.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    OutlinedButton(enabled = !b.paused && selected > 0, onClick = { select(selected - 1) }, modifier = Modifier.semantics { contentDescription = "Previous cell" }) { Text("Previous") }
    OutlinedButton(enabled = !b.paused && selected < 80, onClick = { select(selected + 1) }, modifier = Modifier.semantics { contentDescription = "Next cell" }) { Text("Next") }
    Button(enabled = playable && !b.cells[selected].revealed && !b.cells[selected].flagged,
      onClick = { update { Game.reveal(it, selected) } }, modifier = Modifier.semantics { contentDescription = "Reveal selected cell" }) { Text("Reveal cell") }
    OutlinedButton(enabled = playable && !b.cells[selected].revealed && (b.cells[selected].flagged || b.remaining > 0),
      onClick = { update { Game.flag(it, selected) } }, modifier = Modifier.semantics { contentDescription = "Flag selected cell" }) { Text(if (b.cells[selected].flagged) "Unflag cell" else "Flag cell") }
    OutlinedButton(enabled = playable && !b.cells[selected].revealed && !b.cells[selected].flagged,
      onClick = { mark(selected) }, modifier = Modifier.semantics { contentDescription = "Mark selected cell" }) { Text("Mark cell") }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BoardGrid(b: Board, selected: Int, dark: Boolean, enabled: Boolean, tap: (Int) -> Unit, longPress: (Int) -> Unit) {
  BoxWithConstraints(Modifier.fillMaxWidth()) {
    // Keep the whole board in view on normal phones; narrow windows scroll rather than shrink to illegibility.
    val size = ((maxWidth - 16.dp) / 9).coerceIn(32.dp, 36.dp)
    val numberSize = minOf(18f, (size.value - 4f) / LocalDensity.current.fontScale / 1.4f).sp
    Column(Modifier.align(Alignment.Center).horizontalScroll(rememberScrollState()).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).padding(8.dp)) {
      repeat(9) { row ->
        Row {
          repeat(9) { col ->
            val index = row * 9 + col
            val cell = b.cells[index]
            val showMine = cell.mine && b.complete
            val count = b.adjacent(index)
            val cellState = when {
              showMine -> "mine"
              cell.revealed -> if (count == 0) "empty" else "$count adjacent mines"
              cell.flagged -> if (b.complete && !cell.mine) "incorrect flag" else "flagged"
              cell.mark > 0 -> "covered, pencil mark ${cell.mark}"
              else -> "covered"
            }
            val background = when {
              cell.mine && cell.revealed -> MaterialTheme.colorScheme.errorContainer
              cell.revealed -> MaterialTheme.colorScheme.surfaceVariant
              else -> MaterialTheme.colorScheme.surface
            }
            Box(Modifier.size(size).padding(1.dp)
              .background(background, RoundedCornerShape(4.dp))
              .border(if (index == selected) 2.dp else 0.5.dp,
                if (index == selected) MaterialTheme.colorScheme.primary else if (cell.revealed) Color.Transparent else MaterialTheme.colorScheme.outlineVariant,
                RoundedCornerShape(4.dp))
              .combinedClickable(enabled = enabled, role = Role.Button, onClick = { tap(index) }, onLongClickLabel = "Toggle flag", onLongClick = { longPress(index) })
              .semantics { contentDescription = "Row ${row + 1}, column ${col + 1}, $cellState" }, contentAlignment = Alignment.Center) {
              when {
                showMine -> Icon(Icons.Outlined.BrightnessHigh, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.error)
                cell.flagged -> Icon(if (b.complete && !cell.mine) Icons.Outlined.Close else Icons.Outlined.Flag, null, Modifier.size(20.dp), tint = if (dark) Color(0xFFFFCA28) else Color(0xFF805600))
                cell.revealed && count > 0 -> Text("$count", fontSize = numberSize, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                  color = if (dark) Color(0xFFB8D9FF) else when(count) { 1 -> Color(0xFF1565C0); 2 -> Color(0xFF216B38); else -> Color(0xFFAD2727) })
                cell.mark > 0 -> Text("${cell.mark}", Modifier.align(Alignment.TopEnd).padding(3.dp), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun StatisticsPage(session: Session) {
  val outcomes = session.outcomes
  val wins = outcomes.count { it.won }
  val best = outcomes.filter { it.won }.minOfOrNull { it.seconds }
  if (outcomes.isEmpty()) {
    Icon(Icons.Outlined.BarChart, null, Modifier.size(44.dp), tint = MaterialTheme.colorScheme.primary)
    Spacer(Modifier.height(12.dp))
    Text("Your next small victory starts here.", style = MaterialTheme.typography.titleLarge)
    Text("No completed games yet. Head to Game to play your first round.")
    Spacer(Modifier.height(24.dp))
  }
  listOf("Games played" to "${outcomes.size}", "Wins" to "$wins", "Win rate" to if (outcomes.isEmpty()) "—" else "${wins * 100 / outcomes.size}%",
    "Best time" to (best?.let(::formatTime) ?: "—")).forEach { (label, value) ->
    OutlinedCard(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
      Column(Modifier.padding(20.dp).semantics(mergeDescendants = true) {}) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
      }
    }
  }
  Text("Finished games count once. Undoing a finish removes that result. Abandoned boards don't count.", style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun SettingsPage(preferences: Preferences, enabled: Boolean, change: (Preferences) -> Unit) {
  Text("Appearance", style = MaterialTheme.typography.titleLarge)
  Spacer(Modifier.height(8.dp))
  Appearance.entries.forEach { appearance ->
    Row(Modifier.fillMaxWidth().selectable(selected = preferences.appearance == appearance, enabled = enabled, role = Role.RadioButton,
      onClick = { change(preferences.copy(appearance = appearance)) }).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
      RadioButton(selected = preferences.appearance == appearance, onClick = null, enabled = enabled)
      Spacer(Modifier.width(12.dp)); Text(appearance.name.lowercase().replaceFirstChar { it.uppercase() })
    }
  }
  Spacer(Modifier.height(20.dp)); HorizontalDivider(); Spacer(Modifier.height(20.dp))
  Text("Starting mode", style = MaterialTheme.typography.titleLarge)
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f).padding(end = 12.dp)) {
      Text("Start new games in Flag mode")
      Text("Your current board keeps its selected mode.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Switch(checked = preferences.defaultFlag, enabled = enabled, onCheckedChange = { change(preferences.copy(defaultFlag = it)) },
      modifier = Modifier.semantics { contentDescription = "Start new games in Flag mode" })
  }
  Spacer(Modifier.height(28.dp))
  Text("A quieter kind of puzzle", style = MaterialTheme.typography.titleMedium)
  Text("9 × 9 · 10 mines · Always offline\nNo accounts, ads or network access.\n\nPencil marks are your own guesses. They never reveal hidden information. Marking a cell clears the older undo slot. The timer pauses away from the board.",
    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  Spacer(Modifier.height(16.dp)); Text("Minefield Plus 1.0", style = MaterialTheme.typography.labelMedium)
}

fun formatTime(seconds: Int): String = "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
