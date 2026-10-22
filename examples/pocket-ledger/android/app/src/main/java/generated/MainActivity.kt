package generated

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.time.LocalDate
import java.time.YearMonth
import kotlinx.coroutines.flow.distinctUntilChanged

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val dark = isSystemInDarkTheme()
            SideEffect {
                val style = if (dark) SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                else SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            val ledger: LedgerViewModel = viewModel()
            PocketLedgerApp(ledger)
        }
    }
}

@Composable
fun PocketLedgerApp(viewModel: LedgerViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val nav = state.session.navigation
    val route = nav.details.lastOrNull()
    val dispatch: (AppEvent) -> Unit = viewModel::dispatch
    val snackbars = remember { SnackbarHostState() }
    LaunchedEffect(state.feedback) {
        state.feedback?.let {
            snackbars.showSnackbar(it)
            dispatch(AppEvent.FeedbackConsumed)
        }
    }
    BackHandler(state.pending || route != null || state.showThemePicker || state.deleteTargetId != null || state.showUnsavedDialog) {
        if (!state.pending) dispatch(AppEvent.Back)
    }
    PocketLedgerTheme(accentToken = state.snapshot?.accentToken ?: "green") {
        val colors = MaterialTheme.colorScheme
        Scaffold(
            containerColor = colors.background,
            snackbarHost = { SnackbarHost(snackbars) },
            topBar = {
                // Modal quick-add owns its own heading and close controls.
                if (route !is DetailRoute.Editor) {
                    Surface(color = colors.background) {
                        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 8.dp),
                            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            if (route != null) IconButton(
                                enabled = !state.pending,
                                onClick = { dispatch(AppEvent.Back) }
                            ) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                            Text(when (route) {
                                is DetailRoute.Day -> route.date.toString()
                                is DetailRoute.Budget -> "Budget setup"
                                DetailRoute.Sandbox -> "Try a purchase"
                                else -> "Pocket Ledger"
                            }, style = MaterialTheme.typography.titleLarge,
                                modifier = Modifier.weight(1f).padding(8.dp))
                            if (route == null) IconButton(
                                enabled = !state.pending,
                                onClick = { dispatch(AppEvent.OpenTheme) }
                            ) { Icon(Icons.Default.Palette, "Change theme color") }
                        }
                    }
                }
            },
            bottomBar = {
                if (route == null) NavigationBar(containerColor = colors.surface) {
                    PrimarySection.entries.forEach { section ->
                        val label = when (section) {
                            PrimarySection.HOME -> "Home"
                            PrimarySection.INSIGHTS -> "Insights"
                            PrimarySection.CALENDAR -> "Calendar"
                        }
                        NavigationBarItem(
                            selected = nav.primary == section,
                            enabled = !state.pending,
                            onClick = { dispatch(AppEvent.SelectSection(section)) },
                            icon = { Icon(when (section) {
                                PrimarySection.HOME -> Icons.Default.Home
                                PrimarySection.INSIGHTS -> Icons.Default.ShowChart
                                PrimarySection.CALENDAR -> Icons.Default.CalendarMonth
                            }, null) }, label = { Text(label) }
                        )
                    }
                }
            },
            floatingActionButton = {
                if (route == null || route is DetailRoute.Day) FloatingActionButton(
                    onClick = {
                        if (!state.pending) dispatch(AppEvent.Open(DetailRoute.Editor(
                            null, (route as? DetailRoute.Day)?.date ?: LocalDate.now()
                        )))
                    }
                ) { Icon(Icons.Default.Add, "Add transaction") }
            }
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
                if (state.pending || state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { error ->
                    TextButton(enabled = !state.pending, onClick = { dispatch(AppEvent.Retry) }) {
                        Text("$error  Retry", color = colors.error)
                    }
                }
                val snapshot = state.snapshot
                if (snapshot != null) {
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        when (route) {
                            is DetailRoute.Budget -> BudgetSetupScreen(state, dispatch)
                            DetailRoute.Sandbox -> PurchaseSandboxScreen(state, LocalDate.now(), dispatch)
                            else -> {
                                val day = if (route is DetailRoute.Day) route else
                                    nav.details.dropLast(1).lastOrNull() as? DetailRoute.Day
                                val key = if (day != null) "day:${day.date}" else "${nav.primary}:${nav.calendarMonth}"
                                val scroll = hostScrollState(key, state.session, viewModel)
                                if (day != null) CalendarDayDetailScreen(snapshot, day.date, scroll, dispatch)
                                else when (nav.primary) {
                                    PrimarySection.HOME -> HomeScreen(snapshot, YearMonth.now(), scroll, dispatch)
                                    PrimarySection.INSIGHTS -> InsightsScreen(snapshot, YearMonth.now(), scroll, dispatch)
                                    PrimarySection.CALENDAR -> CalendarScreen(snapshot, nav.calendarMonth, scroll, dispatch)
                                }
                                if (route is DetailRoute.Editor) TransactionEditorSheet(state, dispatch)
                            }
                        }
                    }
                }
            }
        }
        if (state.showThemePicker) ThemePickerSheet(
            state.snapshot?.accentToken ?: "green",
            { dispatch(AppEvent.PickAccent(it)) }, { dispatch(AppEvent.CloseTheme) }
        )
        if (state.showUnsavedDialog) AlertDialog(
            onDismissRequest = { dispatch(AppEvent.KeepEditing) },
            title = { Text("Discard unsaved changes?") },
            text = { Text("Your changes have not been recorded.") },
            confirmButton = { TextButton(onClick = { dispatch(AppEvent.Discard) }) { Text("Discard") } },
            dismissButton = { TextButton(onClick = { dispatch(AppEvent.KeepEditing) }) { Text("Keep editing") } }
        )
        if (state.deleteTargetId != null) AlertDialog(
            onDismissRequest = { if (!state.pending) dispatch(AppEvent.DismissDelete) },
            title = { Text("Delete this transaction?") },
            text = { Text(state.error ?: "This cannot be undone.") },
            confirmButton = { TextButton(enabled = !state.pending,
                onClick = { dispatch(AppEvent.ConfirmDelete) }) { Text("Delete", color = colors.error) } },
            dismissButton = { TextButton(enabled = !state.pending,
                onClick = { dispatch(AppEvent.DismissDelete) }) { Text("Cancel") } }
        )
    }
}

@Composable
private fun hostScrollState(key: String, session: SavedSession, owner: LedgerViewModel): LazyListState {
    val scroll = remember(key) {
        val position = session.scrollPositions[key] ?: (0 to 0)
        LazyListState(position.first, position.second)
    }
    LaunchedEffect(key, scroll) {
        snapshotFlow { scroll.firstVisibleItemIndex to scroll.firstVisibleItemScrollOffset }
            .distinctUntilChanged().collect { (index, offset) -> owner.saveScrollPosition(key, index, offset) }
    }
    return scroll
}
