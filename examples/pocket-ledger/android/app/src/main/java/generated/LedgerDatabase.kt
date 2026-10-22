package generated

import android.content.Context
import androidx.room.*
import androidx.sqlite.db.SupportSQLiteDatabase
import java.time.Instant
import java.time.LocalDate
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

@Entity(tableName = "categories")
data class CategoryEntity(
    @PrimaryKey val id: String,
    val name: String,
    val monthlyLimitCents: Long?,
    val colorToken: String,
    val iconKey: String
) {
    fun toDomain() = Category(id, name, monthlyLimitCents, colorToken, iconKey)
}

@Entity(
    tableName = "transactions",
    foreignKeys = [ForeignKey(
        entity = CategoryEntity::class,
        parentColumns = ["id"], childColumns = ["categoryId"],
        onDelete = ForeignKey.RESTRICT, onUpdate = ForeignKey.RESTRICT
    )],
    indices = [Index("categoryId"), Index("date")]
)
data class TransactionEntity(
    @PrimaryKey val id: String,
    val title: String,
    val amountCents: Long,
    val type: TransactionType,
    val categoryId: String,
    val date: LocalDate,
    val createdAt: Instant,
    val updatedAt: Instant
) {
    fun toDomain() = Transaction(
        id, title, amountCents, type, categoryId, date, createdAt, updatedAt
    )
}

fun Transaction.toEntity() = TransactionEntity(
    id, title, amountCents, type, categoryId, date, createdAt, updatedAt
)

fun Category.toEntity() = CategoryEntity(id, name, monthlyLimitCents, colorToken, iconKey)

@Entity(tableName = "settings")
data class SettingEntity(@PrimaryKey val key: String, val value: String)

/** Receipts are retained so an old restored draft cannot replay a committed write. */
@Entity(tableName = "operation_receipts")
data class OperationReceipt(
    @PrimaryKey val operationId: String,
    val committedAt: Instant
)

class LedgerConverters {
    @TypeConverter fun dateToLong(value: LocalDate): Long = value.toEpochDay()
    @TypeConverter fun longToDate(value: Long): LocalDate = LocalDate.ofEpochDay(value)
    @TypeConverter fun instantToLong(value: Instant): Long = value.toEpochMilli()
    @TypeConverter fun longToInstant(value: Long): Instant = Instant.ofEpochMilli(value)
    @TypeConverter fun typeToString(value: TransactionType): String = value.name
    @TypeConverter fun stringToType(value: String): TransactionType = TransactionType.valueOf(value)
}

@Dao
interface LedgerDao {
    @Query("SELECT * FROM transactions ORDER BY date DESC, createdAt DESC, id")
    suspend fun allTransactions(): List<TransactionEntity>

    @Query("SELECT * FROM categories ORDER BY id")
    suspend fun allCategories(): List<CategoryEntity>

    @Query("SELECT * FROM transactions WHERE date >= :start AND date < :end ORDER BY date DESC, createdAt DESC, id")
    fun observeForMonth(start: LocalDate, end: LocalDate): Flow<List<TransactionEntity>>

    @Query("SELECT * FROM transactions WHERE date = :date ORDER BY createdAt DESC, id")
    fun observeForDay(date: LocalDate): Flow<List<TransactionEntity>>

    @Query("SELECT * FROM categories ORDER BY id")
    fun observeCategories(): Flow<List<CategoryEntity>>

    @Query("SELECT * FROM transactions WHERE id = :id")
    suspend fun transaction(id: String): TransactionEntity?

    @Query("SELECT * FROM categories WHERE id = :id")
    suspend fun category(id: String): CategoryEntity?

    @Query("SELECT value FROM settings WHERE `key` = :key")
    suspend fun setting(key: String): String?

    @Query("SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE operationId = :operationId)")
    suspend fun isOperationCommitted(operationId: String): Boolean

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertTransaction(transaction: TransactionEntity)

    /** Deliberately excludes createdAt and id from mutable columns. */
    @Query("UPDATE transactions SET title = :title, amountCents = :amountCents, type = :type, categoryId = :categoryId, date = :date, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updateTransaction(
        id: String, title: String, amountCents: Long, type: TransactionType,
        categoryId: String, date: LocalDate, updatedAt: Instant
    ): Int

    @Query("DELETE FROM transactions WHERE id = :id")
    suspend fun deleteTransaction(id: String): Int

    @Query("UPDATE categories SET monthlyLimitCents = :limitCents WHERE id = :categoryId AND (monthlyLimitCents IS NULL OR monthlyLimitCents != :limitCents)")
    suspend fun updateLimit(categoryId: String, limitCents: Long): Int

    @Upsert suspend fun putSetting(setting: SettingEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertReceipt(receipt: OperationReceipt)
}

@Database(
    entities = [TransactionEntity::class, CategoryEntity::class,
        SettingEntity::class, OperationReceipt::class],
    version = 1,
    exportSchema = true
)
@TypeConverters(LedgerConverters::class)
abstract class LedgerDatabase : RoomDatabase() {
    abstract fun dao(): LedgerDao

    /** Validation and mutation belong inside this boundary, before the receipt.
     * Exceptions/cancellation roll back both the financial change and receipt.
     * Concurrent callers serialize the check with the write, even across instances.
     */
    suspend fun commitOnce(
        operationId: String,
        committedAt: Instant = Instant.now(),
        mutation: suspend LedgerDao.() -> Unit
    ): Boolean {
        require(operationId.isNotBlank())
        return withTransaction {
            val queries = dao()
            if (queries.isOperationCommitted(operationId)) false else {
                queries.mutation()
                queries.insertReceipt(OperationReceipt(operationId, committedAt))
                true
            }
        }
    }

    suspend fun readSnapshot(): LedgerSnapshot = withTransaction {
        val queries = dao()
        LedgerSnapshot(
            queries.allTransactions().map { it.toDomain() },
            queries.allCategories().map { it.toDomain() },
            queries.setting("accentToken") ?: "green"
        )
    }

    /** One transactional read per invalidation avoids mixing old/new query results. */
    fun observeSnapshot(): Flow<LedgerSnapshot> = invalidationTracker.createFlow(
        "transactions", "categories", "settings", "operation_receipts",
        emitInitialState = true
    ).map { readSnapshot() }

    companion object {
        @Volatile private var instance: LedgerDatabase? = null

        fun getInstance(context: Context): LedgerDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, LedgerDatabase::class.java, "pocket-ledger.db"
            ).addCallback(object : Callback() {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    seededCategories().forEach { category ->
                        db.execSQL(
                            "INSERT INTO categories (id,name,monthlyLimitCents,colorToken,iconKey) VALUES (?,?,NULL,?,?)",
                            arrayOf(category.id, category.name, category.colorToken, category.iconKey)
                        )
                    }
                    db.execSQL("INSERT INTO settings (`key`,value) VALUES ('accentToken','green')")
                    // Enforce financial invariants even for accidental direct DAO writes.
                    for (event in listOf("INSERT", "UPDATE")) {
                        db.execSQL("""
                            CREATE TRIGGER validate_transaction_${event.lowercase()}
                            BEFORE $event ON transactions
                            WHEN NEW.amountCents <= 0 OR length(trim(NEW.title)) NOT BETWEEN 1 AND 80
                              OR NEW.type NOT IN ('INCOME','EXPENSE')
                            BEGIN SELECT RAISE(ABORT, 'Invalid transaction'); END
                        """.trimIndent())
                        db.execSQL("""
                            CREATE TRIGGER validate_limit_${event.lowercase()}
                            BEFORE $event ON categories
                            WHEN NEW.monthlyLimitCents IS NOT NULL AND NEW.monthlyLimitCents <= 0
                            BEGIN SELECT RAISE(ABORT, 'Invalid monthly limit'); END
                        """.trimIndent())
                    }
                }
            }).build().also { instance = it }
        }
        // Initial version: future schema changes require explicit registered migrations.
        // No destructive fallback is enabled for financial data.
    }
}
