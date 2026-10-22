package generated

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/** Periods use local calendar boundaries, never fixed-length millisecond days. */
fun periodRange(
    type: PeriodType,
    index: Int,
    today: LocalDate,
    zone: ZoneId
): PeriodRange {
    val offset = index.coerceAtMost(0)
    val start = when (type) {
        PeriodType.DAY -> today.plusDays(offset.toLong())
        PeriodType.WEEK -> today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
            .plusWeeks(offset.toLong())
        PeriodType.MONTH -> today.withDayOfMonth(1).plusMonths(offset.toLong())
        PeriodType.YEAR -> today.withDayOfYear(1).plusYears(offset.toLong())
    }
    val end = when (type) {
        PeriodType.DAY -> start.plusDays(1)
        PeriodType.WEEK -> start.plusWeeks(1)
        PeriodType.MONTH -> start.plusMonths(1)
        PeriodType.YEAR -> start.plusYears(1)
    }
    return PeriodRange(
        start.atStartOfDay(zone).toInstant().toEpochMilli(),
        end.atStartOfDay(zone).toInstant().toEpochMilli(),
        start, end, type, offset
    )
}

/** Whole completed-session minutes belong to the calendar bucket of completion. */
fun summarize(state: GroveState, range: PeriodRange, zone: ZoneId): FocusSummary {
    val sessions = state.sessions.filter {
        it.status == SessionStatus.COMPLETED && it.endedAt?.let(range::contains) == true
    }
    val count = when (range.type) {
        PeriodType.DAY -> 24
        PeriodType.WEEK -> 7
        PeriodType.MONTH -> range.startDate.lengthOfMonth()
        PeriodType.YEAR -> 12
    }
    val minutes = IntArray(count)
    val tasks = state.tasks.associateBy { it.id }
    val byTask = linkedMapOf<String, Int>()
    val taskNames = linkedMapOf<String, String>()
    for (session in sessions) {
        val local = Instant.ofEpochMilli(requireNotNull(session.endedAt)).atZone(zone)
        val bucket = when (range.type) {
            PeriodType.DAY -> local.hour
            PeriodType.WEEK -> java.time.temporal.ChronoUnit.DAYS
                .between(range.startDate, local.toLocalDate()).toInt()
            PeriodType.MONTH -> local.dayOfMonth - 1
            PeriodType.YEAR -> local.monthValue - 1
        }
        if (bucket in minutes.indices) minutes[bucket] += session.durationMinutes
        byTask[session.taskId] = (byTask[session.taskId] ?: 0) + session.durationMinutes
        taskNames.putIfAbsent(session.taskId,
            tasks[session.taskId]?.name?.takeIf { it.isNotBlank() }
                ?: session.taskName.takeIf { it.isNotBlank() }
                ?: "Deleted task")
    }
    val dayFormat = DateTimeFormatter.ofPattern("EEE", Locale.getDefault())
    val monthFormat = DateTimeFormatter.ofPattern("MMM", Locale.getDefault())
    val buckets = minutes.mapIndexed { bucket, value ->
        val label = when (range.type) {
            PeriodType.DAY -> String.format(Locale.ROOT, "%02d:00", bucket)
            PeriodType.WEEK -> range.startDate.plusDays(bucket.toLong()).format(dayFormat)
            PeriodType.MONTH -> (bucket + 1).toString()
            PeriodType.YEAR -> range.startDate.plusMonths(bucket.toLong()).format(monthFormat)
        }
        label to value
    }
    return FocusSummary(
        totalMinutes = sessions.sumOf { it.durationMinutes },
        minutesByBucket = buckets,
        // Group by identity: separate tasks may legitimately have identical names.
        minutesByTask = byTask.entries.sortedWith(
            compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key }
        ).map { taskNames.getValue(it.key) to it.value },
        completedSessionCount = sessions.size
    )
}

/** Today may still be in progress; yesterday must be met to retain a streak. */
fun goalProgress(state: GroveState, today: LocalDate, zone: ZoneId): GoalProgress {
    val dailyMinutes = mutableMapOf<LocalDate, Int>()
    state.sessions.forEach { session ->
        if (session.status == SessionStatus.COMPLETED) {
            session.endedAt?.let { ended ->
                val day = Instant.ofEpochMilli(ended).atZone(zone).toLocalDate()
                dailyMinutes[day] = (dailyMinutes[day] ?: 0) + session.durationMinutes
            }
        }
    }
    val goal = state.dailyGoal.goalMinutes
    val focused = dailyMinutes[today] ?: 0
    var cursor = if (focused >= goal) today else today.minusDays(1)
    var streak = 0
    while ((dailyMinutes[cursor] ?: 0) >= goal && goal > 0) {
        streak++
        cursor = cursor.minusDays(1)
    }
    return GoalProgress(focusedMinutes = focused, goalMinutes = goal, streakDays = streak)
}

fun saveGoal(state: GroveState, draft: String, now: Long): GroveState {
    val text = draft.trim()
    val minutes = text.takeIf { it.isNotEmpty() && it.all { char -> char in '0'..'9' } }
        ?.toIntOrNull()
    if (minutes == null || minutes !in 1..1440) {
        throw GroveRuleException("Enter a whole number between 1 and 1440.")
    }
    if (minutes == state.dailyGoal.goalMinutes) return state
    val changed = state.copy(dailyGoal = state.dailyGoal.copy(
        goalMinutes = minutes, updatedAt = now
    ))
    val zone = ZoneId.systemDefault()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return changed.copy(dailyGoal = changed.dailyGoal.copy(
        currentStreakDays = goalProgress(changed, today, zone).streakDays
    ))
}
