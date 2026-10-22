package generated

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/** Window policy stays adjustResize, as declared by the supplied launcher manifest. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val dark = isSystemInDarkTheme()
            // The gradient's upper and lower ends both follow this palette. Choose
            // icon brightness from the rendered palette rather than the manifest theme.
            SideEffect {
                val transparent = Color.Transparent.toArgb()
                val navigationScrim = if (dark) 0xFF0F1B15.toInt() else 0xFFF4FBF6.toInt()
                enableEdgeToEdge(
                    statusBarStyle = if (dark) SystemBarStyle.dark(transparent)
                        else SystemBarStyle.light(transparent, navigationScrim),
                    navigationBarStyle = if (dark) SystemBarStyle.dark(navigationScrim)
                        else SystemBarStyle.light(navigationScrim, navigationScrim)
                )
            }
            GroveTheme {
                val model: GroveViewModel = viewModel()
                GroveHost(model)
            }
        }
    }
}

@Composable
private fun GroveHost(model: GroveViewModel) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val ui by model.ui.collectAsStateWithLifecycle()
    val state by model.state.collectAsStateWithLifecycle()
    val loaded by model.loaded.collectAsStateWithLifecycle()
    val error by model.error.collectAsStateWithLifecycle()
    val savedScreens = rememberSaveableStateHolder()

    // One cancellable ticker per visible Activity. Each activation reconciles the
    // persisted deadline immediately, including returns from sleep or another app.
    // No abandonment follows onStop, and no countdown ticks are written to disk.
    LaunchedEffect(model, lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                model.tick()
                delay(1_000L)
            }
        }
    }

    // A running operation owns navigation even while its route is being restored.
    // Terminal feedback remains in the model until explicitly acknowledged at Home.
    val route = when {
        state.runningSession != null -> Route.Session
        ui.navigation.current == Route.Session -> Route.Home
        else -> ui.navigation.current
    }
    val screenKey = when (route) {
        Route.Home -> "home"
        Route.Session -> "session"
        is Route.Forest -> "forest"
        is Route.TasksGoal -> "tasks"
        Route.Stats -> "stats"
    }

    // Screen-specific BackHandlers are composed later and take precedence. This
    // guard also covers the brief interval before SessionScreen mounts on recovery.
    BackHandler(enabled = loaded && (state.runningSession != null || route != Route.Home)) {
        model.back()
    }

    GroveBackground(Modifier.fillMaxSize()) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            containerColor = Color.Transparent,
            contentColor = MaterialTheme.colorScheme.onBackground,
            // Exclude IME here: it is handled once, after consuming Scaffold padding.
            contentWindowInsets = WindowInsets.systemBars.union(WindowInsets.displayCutout)
        ) { innerPadding ->
            Box(
                Modifier.fillMaxSize()
                    .padding(innerPadding)
                    .consumeWindowInsets(innerPadding)
                    .imePadding()
            ) {
                if (!loaded) {
                    Column(
                        Modifier.fillMaxSize().padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        CircularProgressIndicator(Modifier.semantics {
                            contentDescription = "Loading Focus Grove"
                        })
                        Spacer(Modifier.height(16.dp))
                        Text("Opening your grove…")
                        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    }
                } else {
                    savedScreens.SaveableStateProvider(screenKey) {
                        when (route) {
                            Route.Home -> HomeScreen(model, Modifier.fillMaxSize())
                            Route.Session -> SessionScreen(model, Modifier.fillMaxSize())
                            is Route.Forest -> ForestScreen(model, Modifier.fillMaxSize())
                            is Route.TasksGoal -> TasksGoalScreen(model, Modifier.fillMaxSize())
                            Route.Stats -> StatsScreen(model, Modifier.fillMaxSize())
                        }
                    }
                }
            }
        }
    }
}
