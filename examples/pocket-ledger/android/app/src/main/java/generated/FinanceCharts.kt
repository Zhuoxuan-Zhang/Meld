package generated

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.util.Locale

/** Real cumulative daily expenses, with paths rebuilt only when data or size changes. */
@Composable
fun SpendingTrendChart(summary: MonthSummary, modifier: Modifier = Modifier) {
    val points = summary.cumulativeExpenseCents
    val accent = MaterialTheme.colorScheme.primary
    val grid = MaterialTheme.colorScheme.onSurface.copy(alpha = .12f)
    val peak = remember(points) { points.maxOrNull()?.coerceAtLeast(0L) ?: 0L }
    val description = remember(summary.month, points) {
        if (peak == 0L) "Spending trend. No spending recorded in ${summary.month}."
        else buildString {
            append("Cumulative spending for ${summary.month}. ")
            points.forEachIndexed { index, cents ->
                append("Day ${index + 1}: ${ledgerMoney(cents)}. ")
            }
        }
    }
    Column(
        modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = description },
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text("Spending trend", style = MaterialTheme.typography.titleMedium)
        if (peak == 0L) {
            Text("No spending yet this month.", style = MaterialTheme.typography.bodyMedium)
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(ledgerMoney(0), style = MaterialTheme.typography.bodySmall)
                Text(ledgerMoney(peak), style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.fillMaxWidth().height(156.dp).drawWithCache {
                val inset = 4.dp.toPx()
                val width = (size.width - inset * 2).coerceAtLeast(0f)
                val height = (size.height - inset * 2).coerceAtLeast(0f)
                val baseline = inset + height
                val line = Path()
                val area = Path()
                val denominator = (points.size - 1).coerceAtLeast(1)
                area.moveTo(inset, baseline)
                points.forEachIndexed { index, value ->
                    val x = inset + width * index / denominator
                    val y = baseline - height * (value.toDouble() / peak).toFloat().coerceIn(0f, 1f)
                    if (index == 0) line.moveTo(x, y) else line.lineTo(x, y)
                    area.lineTo(x, y)
                }
                val lastX = inset + width * points.lastIndex / denominator
                // A one-day series still has a visible horizontal stroke and area.
                if (points.size == 1) {
                    line.lineTo(inset + width, inset)
                    area.lineTo(inset + width, inset)
                }
                area.lineTo(if (points.size == 1) inset + width else lastX, baseline)
                area.close()
                val fill = Brush.verticalGradient(
                    listOf(accent.copy(alpha = .26f), accent.copy(alpha = .01f)),
                    startY = inset, endY = baseline
                )
                val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round)
                onDrawBehind {
                    for (step in 0..4) {
                        val y = inset + height * step / 4
                        drawLine(grid, Offset(inset, y), Offset(inset + width, y), 1.dp.toPx())
                    }
                    drawPath(area, fill)
                    drawPath(line, accent, style = stroke)
                }
            })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${summary.month.month.name.lowercase(Locale.US).replaceFirstChar { it.uppercase() }} 1",
                    style = MaterialTheme.typography.bodySmall)
                Text("${summary.month.lengthOfMonth()}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** The label retains the actual percentage when the visible ring reaches capacity. */
@Composable
fun BudgetDonutRing(
    spentCents: Long,
    limitCents: Long?,
    modifier: Modifier = Modifier,
    label: String = "Monthly budget"
) {
    val configured = limitCents != null && limitCents > 0L
    val fraction = if (configured) spentCents.coerceAtLeast(0L).toDouble() / limitCents!! else 0.0
    val progress = fraction.coerceIn(0.0, 1.0).toFloat()
    val percentage = remember(fraction) { String.format(Locale.US, "%.0f%%", fraction * 100) }
    val over = configured && spentCents > limitCents!!
    val color = if (over) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    val track = MaterialTheme.colorScheme.onSurface.copy(alpha = .12f)
    val description = when {
        !configured -> "$label. No budget set. ${ledgerMoney(spentCents)} spent."
        over -> "$label. $percentage used. ${ledgerMoney(spentCents - limitCents!!)} over budget."
        else -> "$label. $percentage used. ${ledgerMoney(limitCents!! - spentCents)} remaining."
    }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(88.dp).clearAndSetSemantics {
            contentDescription = description
            if (configured) progressBarRangeInfo = ProgressBarRangeInfo(progress, 0f..1f)
        }, contentAlignment = Alignment.Center) {
            Spacer(Modifier.fillMaxSize().drawWithCache {
                val thickness = 6.dp.toPx()
                val diameter = (size.minDimension - thickness).coerceAtLeast(0f)
                val topLeft = Offset((size.width - diameter) / 2, (size.height - diameter) / 2)
                val arcSize = Size(diameter, diameter)
                val stroke = Stroke(thickness, cap = StrokeCap.Round)
                onDrawBehind {
                    drawArc(track, -90f, 360f, false, topLeft, arcSize, style = stroke)
                    if (progress > 0f) drawArc(color, -90f, progress * 360f,
                        false, topLeft, arcSize, style = stroke)
                }
            })
            // Percentage sits below the ring so large text never collides with it.
        }
        Text(if (configured) percentage else "No budget",
            color = color, fontWeight = FontWeight.Bold,
            style = MaterialTheme.typography.bodyMedium)
        if (over) Text("Over budget", color = color, style = MaterialTheme.typography.bodySmall)
        else if (spentCents == 0L) Text("No spending yet", style = MaterialTheme.typography.bodySmall)
    }
}
