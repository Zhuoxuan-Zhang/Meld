package generated

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.*

private val LightGrove = lightColorScheme(
    primary = Color(0xFF1D6E55), onPrimary = Color.White,
    primaryContainer = Color(0xFFD8F1E2), onPrimaryContainer = Color(0xFF1B2A22),
    secondary = Color(0xFF8A6240), onSecondary = Color.White,
    background = Color(0xFFF4FBF6), onBackground = Color(0xFF1B2A22),
    surface = Color.White, onSurface = Color(0xFF1B2A22),
    surfaceVariant = Color(0xFFE4F0E8), onSurfaceVariant = Color(0xFF46594D),
    outline = Color(0xFF6F8376), error = Color(0xFFB3261E), onError = Color.White
)
private val DarkGrove = darkColorScheme(
    primary = Color(0xFF5FCF9E), onPrimary = Color(0xFF0B2318),
    primaryContainer = Color(0xFF214D39), onPrimaryContainer = Color(0xFFE7F3EC),
    secondary = Color(0xFFC79A6E), onSecondary = Color(0xFF302013),
    background = Color(0xFF0F1B15), onBackground = Color(0xFFE7F3EC),
    surface = Color(0xFF17251D), onSurface = Color(0xFFE7F3EC),
    surfaceVariant = Color(0xFF26392D), onSurfaceVariant = Color(0xFFBED0C3),
    outline = Color(0xFF899D8F), error = Color(0xFFFFB4AB), onError = Color(0xFF690005)
)
private val GroveTypography = Typography(
    headlineSmall = androidx.compose.ui.text.TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleLarge = androidx.compose.ui.text.TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleMedium = androidx.compose.ui.text.TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = androidx.compose.ui.text.TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodySmall = androidx.compose.ui.text.TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    displaySmall = androidx.compose.ui.text.TextStyle(fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold, fontFeatureSettings = "tnum")
)

@Composable
fun GroveTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkGrove else LightGrove,
        typography = GroveTypography,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(4.dp),
            medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(24.dp),
            extraLarge = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        ),
        content = content
    )
}

/** Draw behind system bars; the Activity/Scaffold owns content insets exactly once. */
@Composable
fun GroveBackground(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val background = MaterialTheme.colorScheme.background
    val mint = MaterialTheme.colorScheme.primaryContainer
    val gradient = remember(background, mint) { Brush.verticalGradient(listOf(background, mint)) }
    Box(modifier.background(gradient), content = content)
}

@Composable
fun GroveUtilityHeader(
    streakDays: Int,
    onForest: () -> Unit,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier.fillMaxWidth()) {
        Text("Focus Grove", style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() })
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            IconButton(onClick = onForest) {
                Icon(Icons.Outlined.Forest, contentDescription = "Your Forest")
            }
            TextButton(onClick = onSettings,
                modifier = Modifier.semantics { contentDescription = "Streak: $streakDays days. Tasks and daily goal" }) {
                Icon(Icons.Outlined.LocalFireDepartment, contentDescription = null)
                Spacer(Modifier.width(4.dp))
                Text("${streakDays}d")
            }
            IconButton(onClick = onSettings) {
                Icon(Icons.Outlined.Settings, contentDescription = "Tasks and daily goal settings")
            }
        }
    }
}

/** Modal overview hierarchy follows the forest reference; sharing is excluded. */
@Composable
fun GrovePeriodHeader(
    title: String,
    periodLabel: String,
    onClose: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    nextEnabled: Boolean,
    modifier: Modifier = Modifier
) {
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer),
            verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, "Close") }
            Text(title, style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f).semantics { heading() },
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.width(48.dp))
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onPrevious) { Icon(Icons.Outlined.ChevronLeft, "Previous period") }
            Text(periodLabel, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            IconButton(onClick = onNext, enabled = nextEnabled) {
                Icon(Icons.Outlined.ChevronRight, "Next period")
            }
        }
    }
}

@Composable
fun GrovePeriodSelector(selected: PeriodType, onSelect: (PeriodType) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PeriodType.entries.forEach { type ->
            TextButton(onClick = { onSelect(type) }, modifier = Modifier.weight(1f)
                .heightIn(min = 48.dp).semantics {
                    this.selected = selected == type
                    role = Role.Tab
                }, contentPadding = PaddingValues(horizontal = 2.dp),
                colors = ButtonDefaults.textButtonColors(
                    containerColor = if (selected == type) MaterialTheme.colorScheme.primaryContainer else Color.Transparent
                )) {
                Text(type.name.lowercase().replaceFirstChar { it.uppercase() },
                    style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
