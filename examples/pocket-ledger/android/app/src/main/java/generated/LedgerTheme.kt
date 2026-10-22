package generated

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private data class AccentSwatch(val token: String, val label: String, val color: Color)

private val ledgerSwatches = listOf(
    AccentSwatch("green", "Green", Color(0xFF2E7D46)),
    AccentSwatch("teal", "Teal", Color(0xFF008577)),
    AccentSwatch("cyan", "Cyan", Color(0xFF007E91)),
    AccentSwatch("blue", "Blue", Color(0xFF2567BB)),
    AccentSwatch("indigo", "Indigo", Color(0xFF484BB2)),
    AccentSwatch("purple", "Purple", Color(0xFF7951B0)),
    AccentSwatch("magenta", "Magenta", Color(0xFF9D339F)),
    AccentSwatch("pink", "Pink", Color(0xFFB52D69)),
    AccentSwatch("red", "Red", Color(0xFFC62828)),
    AccentSwatch("orange", "Orange", Color(0xFFAA5700)),
    AccentSwatch("yellow", "Yellow", Color(0xFF806900))
)

private val ledgerTypography = Typography(
    headlineLarge = TextStyle(fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold),
    headlineMedium = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
    headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
    titleLarge = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
    titleMedium = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp)
)

@Composable
fun PocketLedgerTheme(
    accentToken: String = "green",
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val base = ledgerSwatches.firstOrNull { it.token == accentToken } ?: ledgerSwatches.first()
    val accent = if (darkTheme) {
        if (base.token == "green") Color(0xFF6FCF8F)
        else androidx.compose.ui.graphics.lerp(base.color, Color.White, 0.48f)
    } else base.color
    // Accent containers supply FABs, selected navigation and progress tracks.
    // Keep the default mint palette; tint other selections without purple defaults.
    val lightContainer = if (base.token == "green") Color(0xFFD7EAD3)
        else androidx.compose.ui.graphics.lerp(Color.White, base.color, 0.16f)
    val darkContainer = if (base.token == "green") Color(0xFF283E2B)
        else androidx.compose.ui.graphics.lerp(Color(0xFF1C2A1D), base.color, 0.28f)
    val colors = if (darkTheme) darkColorScheme(
        primary = accent,
        onPrimary = if (base.token == "green") Color(0xFF07210E) else Color(0xFF101710),
        primaryContainer = darkContainer,
        onPrimaryContainer = Color(0xFFEAF3E8),
        secondary = accent,
        onSecondary = Color(0xFF101710),
        secondaryContainer = darkContainer,
        onSecondaryContainer = Color(0xFFEAF3E8),
        tertiary = Color(0xFFA9D5B2),
        onTertiary = Color(0xFF102B19),
        tertiaryContainer = Color(0xFF294532),
        onTertiaryContainer = Color(0xFFD2EED8),
        background = Color(0xFF10170F),
        onBackground = Color(0xFFEAF3E8),
        surface = Color(0xFF1C2A1D),
        onSurface = Color(0xFFEAF3E8),
        surfaceVariant = Color(0xFF2C3B2E),
        onSurfaceVariant = Color(0xFFBECDBE),
        surfaceDim = Color(0xFF10170F),
        surfaceBright = Color(0xFF354437),
        surfaceContainerLowest = Color(0xFF0C120C),
        surfaceContainerLow = Color(0xFF172219),
        surfaceContainer = Color(0xFF1C2A1D),
        surfaceContainerHigh = Color(0xFF263428),
        surfaceContainerHighest = Color(0xFF304032),
        surfaceTint = accent,
        inverseSurface = Color(0xFFEAF3E8),
        inverseOnSurface = Color(0xFF1B2A1E),
        inversePrimary = base.color,
        outline = Color(0xFF8D9E90),
        outlineVariant = Color(0xFF455747),
        scrim = Color.Black,
        error = Color(0xFFEF9A9A),
        onError = Color(0xFF3F0000),
        errorContainer = Color(0xFF642020),
        onErrorContainer = Color(0xFFFFDAD6)
    ) else lightColorScheme(
        primary = accent,
        onPrimary = Color.White,
        primaryContainer = lightContainer,
        onPrimaryContainer = Color(0xFF1B2A1E),
        secondary = accent,
        onSecondary = Color.White,
        secondaryContainer = lightContainer,
        onSecondaryContainer = Color(0xFF1B2A1E),
        tertiary = Color(0xFF386748),
        onTertiary = Color.White,
        tertiaryContainer = Color(0xFFD2EED8),
        onTertiaryContainer = Color(0xFF102B19),
        background = Color(0xFFE7F3E8),
        onBackground = Color(0xFF1B2A1E),
        surface = Color.White,
        onSurface = Color(0xFF1B2A1E),
        surfaceVariant = Color(0xFFD7EAD3),
        onSurfaceVariant = Color(0xFF455747),
        surfaceDim = Color(0xFFD7E3D8),
        surfaceBright = Color.White,
        surfaceContainerLowest = Color.White,
        surfaceContainerLow = Color(0xFFF4FAF3),
        surfaceContainer = Color(0xFFEDF5EB),
        surfaceContainerHigh = Color(0xFFE5EFE3),
        surfaceContainerHighest = Color(0xFFDCE8DA),
        surfaceTint = accent,
        inverseSurface = Color(0xFF29382C),
        inverseOnSurface = Color(0xFFEAF3E8),
        inversePrimary = if (base.token == "green") Color(0xFF6FCF8F)
            else androidx.compose.ui.graphics.lerp(base.color, Color.White, 0.48f),
        outline = Color(0xFF6E8071),
        outlineVariant = Color(0xFFBDCFBD),
        scrim = Color.Black,
        error = Color(0xFFC62828),
        onError = Color.White,
        errorContainer = Color(0xFFFFDAD6),
        onErrorContainer = Color(0xFF410002)
    )
    MaterialTheme(
        colorScheme = colors,
        typography = ledgerTypography,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(10.dp), small = RoundedCornerShape(12.dp),
            medium = RoundedCornerShape(18.dp), large = RoundedCornerShape(20.dp),
            extraLarge = RoundedCornerShape(28.dp)
        ),
        content = content
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThemePickerSheet(
    selectedToken: String,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("Select Color", style = MaterialTheme.typography.titleLarge)
            Column(Modifier.horizontalScroll(rememberScrollState())) {
                ledgerSwatches.chunked(6).forEach { row ->
                    Row {
                        row.forEach { swatch ->
                            val selected = selectedToken == swatch.token
                            Box(
                                Modifier.size(48.dp)
                                    .selectable(selected, role = Role.RadioButton,
                                        onClick = { onSelect(swatch.token) })
                                    .semantics { contentDescription = "${swatch.label} accent" },
                                contentAlignment = Alignment.Center
                            ) {
                                Box(
                                    Modifier.size(36.dp).background(swatch.color, CircleShape)
                                        .then(if (selected) Modifier.border(
                                            2.dp, MaterialTheme.colorScheme.onSurface, CircleShape
                                        ) else Modifier),
                                    contentAlignment = Alignment.Center
                                ) {
                                    if (selected) Icon(
                                        Icons.Default.Check, contentDescription = null,
                                        tint = if (swatch.color.luminance() > 0.179f) Color.Black else Color.White,
                                        modifier = Modifier.size(22.dp)
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Text("Preview applies live to cards behind this sheet.",
                style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) {
                Text("Done")
            }
        }
    }
}
