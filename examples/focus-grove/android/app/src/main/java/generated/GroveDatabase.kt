package generated

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "tasks", indices = [Index(value = ["activeSlot"], unique = true)])
data class TaskRow(
    @PrimaryKey val id: String,
    val name: String,
    val isCompleted: Boolean,
    val isActive: Boolean,
    val createdAt: Long,
    // SQLite permits multiple NULLs in a unique index.
    val activeSlot: Int? = if (isActive) 1 else null
)

// taskId intentionally has no foreign key: deleting a task retains its history.
@Entity(tableName = "sessions", indices = [
    Index("taskId"), Index("endedAt"),
    Index(value = ["runningSlot"], unique = true)
])
data class SessionRow(
    @PrimaryKey val id: String,
    val taskId: String,
    val durationMinutes: Int,
    val status: SessionStatus,
    val startedAt: Long,
    val endedAt: Long?,
    val taskName: String,
    val runningSlot: Int? = if (status == SessionStatus.RUNNING) 1 else null
)

@Entity(
    tableName = "trees",
    foreignKeys = [ForeignKey(
        entity = SessionRow::class,
        parentColumns = ["id"], childColumns = ["sessionId"],
        onDelete = ForeignKey.RESTRICT
    )],
    indices = [Index(value = ["sessionId"], unique = true), Index("collectedAt")]
)
data class TreeRow(
    @PrimaryKey val id: String,
    val sessionId: String,
    val collectedAt: Long
)

@Entity(tableName = "daily_goal")
data class DailyGoalRow(
    @PrimaryKey val id: String = "singleton",
    val goalMinutes: Int = 60,
    val currentStreakDays: Int = 0,
    val updatedAt: Long = 0L
)

class GroveConverters {
    @TypeConverter fun statusToString(value: SessionStatus): String = value.name
    @TypeConverter fun stringToStatus(value: String): SessionStatus = SessionStatus.valueOf(value)
}

@Dao
abstract class GroveDao {
    @Query("SELECT * FROM tasks ORDER BY createdAt, id")
    abstract suspend fun tasks(): List<TaskRow>

    @Query("SELECT * FROM sessions ORDER BY startedAt, id")
    abstract suspend fun sessions(): List<SessionRow>

    @Query("SELECT * FROM trees ORDER BY collectedAt, id")
    abstract suspend fun trees(): List<TreeRow>

    @Query("SELECT * FROM daily_goal WHERE id = 'singleton'")
    abstract suspend fun goal(): DailyGoalRow?

    // Every supported mutation touches this singleton, invalidating the snapshot.
    // The repository maps each emission to readState(), which is transactional.
    @Query("SELECT * FROM daily_goal WHERE id = 'singleton'")
    abstract fun observeChanges(): Flow<DailyGoalRow?>

    @Query("SELECT * FROM sessions WHERE status = 'RUNNING' LIMIT 1")
    abstract suspend fun runningSession(): SessionRow?

    @Query("SELECT * FROM trees WHERE collectedAt >= :start AND collectedAt < :end ORDER BY collectedAt, id")
    abstract suspend fun treesInPeriod(start: Long, end: Long): List<TreeRow>

    @Query("SELECT * FROM sessions WHERE status = 'COMPLETED' AND endedAt >= :start AND endedAt < :end ORDER BY endedAt, id")
    abstract suspend fun completedInPeriod(start: Long, end: Long): List<SessionRow>

    @Insert protected abstract suspend fun insertTasks(rows: List<TaskRow>)
    @Insert protected abstract suspend fun insertSessions(rows: List<SessionRow>)
    @Insert protected abstract suspend fun insertTrees(rows: List<TreeRow>)
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    protected abstract suspend fun insertGoal(row: DailyGoalRow)
    @Query("DELETE FROM trees") protected abstract suspend fun clearTrees()
    @Query("DELETE FROM sessions") protected abstract suspend fun clearSessions()
    @Query("DELETE FROM tasks") protected abstract suspend fun clearTasks()

    @Transaction
    open suspend fun readState(): GroveState = GroveState(
        tasks = tasks().map { Task(it.id, it.name, it.isCompleted, it.isActive, it.createdAt) },
        sessions = sessions().map {
            Session(it.id, it.taskId, it.durationMinutes, it.status,
                it.startedAt, it.endedAt, it.taskName)
        },
        trees = trees().map { Tree(it.id, it.sessionId, it.collectedAt) },
        dailyGoal = goal()?.let {
            DailyGoal(it.id, it.goalMinutes, it.currentStreakDays, it.updatedAt)
        } ?: DailyGoal()
    )

    /** Call inside the repository's read-rule-write database transaction. */
    @Transaction
    open suspend fun writeState(state: GroveState) {
        require(state.tasks.count { it.isActive } <= 1)
        require(state.tasks.none { it.isActive && it.isCompleted })
        require(state.sessions.count { it.status == SessionStatus.RUNNING } <= 1)
        require(state.sessions.all {
            it.durationMinutes in 1..120 &&
                ((it.status == SessionStatus.RUNNING) == (it.endedAt == null))
        })
        val sessions = state.sessions.associateBy { it.id }
        require(state.trees.map { it.sessionId }.distinct().size == state.trees.size)
        require(state.trees.all { tree ->
            sessions[tree.sessionId]?.let {
                it.status == SessionStatus.COMPLETED && it.endedAt == tree.collectedAt
            } == true
        })
        require(state.dailyGoal.id == "singleton")
        require(state.dailyGoal.goalMinutes in 1..1440)
        require(state.dailyGoal.currentStreakDays >= 0)
        // Snapshot replacement is atomic; failures roll back all deletions.
        clearTrees()
        clearSessions()
        clearTasks()
        insertTasks(state.tasks.map {
            TaskRow(it.id, it.name, it.isCompleted, it.isActive, it.createdAt)
        })
        insertSessions(state.sessions.map {
            SessionRow(it.id, it.taskId, it.durationMinutes, it.status,
                it.startedAt, it.endedAt, it.taskName)
        })
        insertTrees(state.trees.map { TreeRow(it.id, it.sessionId, it.collectedAt) })
        state.dailyGoal.let {
            insertGoal(DailyGoalRow(it.id, it.goalMinutes, it.currentStreakDays, it.updatedAt))
        }
    }
}

@Database(
    entities = [TaskRow::class, SessionRow::class, TreeRow::class, DailyGoalRow::class],
    version = 1,
    exportSchema = true
)
@TypeConverters(GroveConverters::class)
abstract class GroveDatabase : RoomDatabase() {
    abstract fun dao(): GroveDao

    companion object {
        // Register real migrations here when introducing a later schema version.
        private val migrations: Array<Migration> = emptyArray()
        @Volatile private var instance: GroveDatabase? = null

        fun getInstance(context: Context): GroveDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, GroveDatabase::class.java, "focus_grove.db"
            ).addMigrations(*migrations).build().also { instance = it }
        }
    }
}
