package generated

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlin.math.min

/** Cached vector artwork, independent of timer cadence and domain persistence. */
@Composable
fun TreeGrowthVisual(
    progressFraction: Float,
    withered: Boolean = false,
    modifier: Modifier = Modifier
) {
    val progress = if (progressFraction.isFinite()) progressFraction.coerceIn(0f, 1f) else 0f
    val description = if (withered) "Withered tree. Session given up."
        else "Growing tree, ${(progress * 100).toInt()} percent grown"
    Box(modifier.semantics { contentDescription = description }.drawWithCache {
        val diameter = min(size.width, size.height)
        val backdrop = Brush.verticalGradient(
            listOf(Color(0xFFE4EDAC), Color(0xFF9ED1A4)),
            startY = 0f, endY = 240f
        )
        val soil = Brush.verticalGradient(
            listOf(Color(0xFF927044), Color(0xFF4E663E)),
            startY = 180f, endY = 242f
        )
        val bowl = Path().apply {
            moveTo(30f, 190f)
            cubicTo(43f, 254f, 197f, 254f, 210f, 190f)
            close()
        }
        val height = 40f + progress * 94f
        val top = 185f - height
        val trunk = Path().apply {
            moveTo(113f, 188f)
            cubicTo(120f, 154f, 115f, top + 26f, 120f, top)
            cubicTo(124f, top + 28f, 124f, 155f, 128f, 188f)
            close()
        }
        val foliage = listOf(
            Triple(-30f, 29f, 25f), Triple(29f, 30f, 26f),
            Triple(-14f, 4f, 27f), Triple(15f, 5f, 25f),
            Triple(0f, -12f, 23f), Triple(0f, 31f, 29f)
        )
        val canopyScale = 0.32f + 0.68f * progress
        val greens = listOf(Color(0xFF3D9655), Color(0xFF58AE59),
            Color(0xFF77C467), Color(0xFF91D774))
        onDrawBehind {
            withTransform({
                translate((size.width - diameter) / 2f, (size.height - diameter) / 2f)
                scale(diameter / 240f, diameter / 240f, Offset.Zero)
            }) {
                drawCircle(backdrop, 119f, Offset(120f, 120f))
                drawPath(bowl, soil)
                drawOval(Color(0xFF80683C), Offset(30f, 177f), Size(180f, 29f))
                drawOval(Color(0xFF695A35), Offset(79f, 185f), Size(82f, 11f))
                drawPath(trunk, if (withered) Color(0xFF78614C) else Color(0xFF8A6240))
                for (side in listOf(-1f, 1f)) {
                    drawLine(Color(0xFF8A6240), Offset(120f, top + 59f),
                        Offset(120f + side * 30f * canopyScale, top + 27f),
                        5f * canopyScale, StrokeCap.Round)
                }
                if (!withered) {
                    foliage.forEachIndexed { index, (x, y, radius) ->
                        val center = Offset(120f + x * canopyScale, top + y * canopyScale)
                        drawCircle(greens[index % greens.size], radius * canopyScale, center)
                        drawOval(Color(0xFFB8E88A).copy(alpha = 0.45f),
                            center - Offset(radius * canopyScale * 0.55f, radius * canopyScale * 0.65f),
                            Size(radius * canopyScale, radius * canopyScale * 0.4f))
                    }
                } else {
                    drawOval(Color(0xFFAB8B4E), Offset(144f, 180f), Size(13f, 6f))
                    drawOval(Color(0xFF997946), Offset(91f, 187f), Size(11f, 5f))
                }
            }
        }
    })
}

/** Grass diamond and exposed soil edge for a collected-tree gallery cell. */
@Composable
fun ForestTreeTile(modifier: Modifier = Modifier, description: String = "Collected tree") {
    TreeGrowthVisual(1f, false, modifier.semantics { contentDescription = description }
        .drawWithCache {
            val grass = Path().apply {
                moveTo(size.width * 0.05f, size.height * 0.76f)
                lineTo(size.width * 0.5f, size.height * 0.59f)
                lineTo(size.width * 0.95f, size.height * 0.76f)
                lineTo(size.width * 0.5f, size.height * 0.96f)
                close()
            }
            onDrawBehind {
                withTransform({ translate(0f, size.height * 0.035f) }) {
                    drawPath(grass, Color(0xFF8A6240))
                }
                drawPath(grass, Color(0xFF76AA45))
            }
        })
}
