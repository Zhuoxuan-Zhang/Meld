package generated

import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import org.junit.Assert.*
import org.junit.Test

class LedgerLogicTest {
    private val today = LocalDate.of(2024, 2, 28)
    private val stamp = Instant.parse("2024-02-01T12:00:00Z")
    private val categories = seededCategories().map {
        it.copy(monthlyLimitCents = when (it.id) {
            "food" -> 10000L
            "shopping" -> 5000L
            else -> null
        })
    }

    private fun draft() = TransactionDraft(
        "operation-1", null, "Lunch", "25.00", "food",
        today.toString(), TransactionType.EXPENSE
    )

    private fun tx(
        id: String, amount: Long, category: String = "food",
        date: LocalDate = today, type: TransactionType = TransactionType.EXPENSE
    ) = Transaction(id, id, amount, type, category, date, stamp, stamp)

    private fun snapshot(vararg rows: Transaction) =
        LedgerSnapshot(rows.toList(), categories, "green")

    @Test fun moneyParsingRejectsFractionalCentsAndOverflow() {
        assertEquals(1L, parsePositiveCents("0.01"))
        assertEquals(1230L, parsePositiveCents("12.3"))
        assertEquals(Long.MAX_VALUE, parsePositiveCents("92233720368547758.07"))
        listOf("0", "0.00", "-1", "+1", "1.001", "1e2", "1,000", " 1", "1.",
            "NaN", "92233720368547758.08").forEach {
            assertNull("Accepted invalid input: $it", parsePositiveCents(it))
        }
    }

    @Test fun validationChecksAllFieldsAndLeapDates() {
        assertTrue(validateDraft(draft(), categories).isEmpty())
        assertTrue(validateDraft(draft().copy(title = "  valid  ", dateText = "2024-02-29"),
            categories).isEmpty())
        val invalid = draft().copy(title = " ", amountText = "0", categoryId = "missing",
            dateText = "2023-02-29")
        assertEquals(setOf("title", "amount", "category", "date"),
            validateDraft(invalid, categories).keys)
        assertTrue(validateDraft(draft().copy(title = "x".repeat(81)), categories)
            .containsKey("title"))
        assertNull(parseLedgerDate("2024-2-01"))
    }

    @Test fun monthSummaryFiltersDatesAndExcludesIncomeFromBudgets() {
        val summary = summarizeMonth(snapshot(
            tx("food", 12000), tx("shop", 3000, "shopping"),
            tx("salary", 90000, type = TransactionType.INCOME),
            tx("old", 99999, date = LocalDate.of(2024, 1, 31)),
            tx("next", 99999, date = LocalDate.of(2024, 3, 1))
        ), YearMonth.of(2024, 2))
        assertEquals(90000L, summary.incomeCents)
        assertEquals(15000L, summary.expenseCents)
        assertEquals(15000L, summary.limitCents)
        assertEquals(listOf("food", "shopping", "other", "transport"),
            summary.categories.map { it.category.id })
        val food = summary.categories.first()
        assertEquals(-2000L, food.remainingCents)
        assertEquals(2000L, food.overageCents)
        assertEquals(1, food.transactionCount)
        assertNull(summary.categories.last().remainingCents)
        assertEquals(29, summary.cumulativeExpenseCents.size)
        assertTrue(summary.cumulativeExpenseCents.take(27).all { it == 0L })
        assertEquals(listOf(15000L, 15000L), summary.cumulativeExpenseCents.takeLast(2))
    }

    @Test fun emptyMonthRetainsEveryCategoryWithoutInventedSpending() {
        val summary = summarizeMonth(snapshot(), YearMonth.of(2024, 2))
        assertEquals(4, summary.categories.size)
        assertTrue(summary.categories.all { it.spentCents == 0L && it.transactionCount == 0 })
        assertTrue(summary.cumulativeExpenseCents.all { it == 0L })
    }

    @Test fun previewUsesOverallAllowanceAndInclusiveLeapMonthDaysWithoutMutation() {
        val ledger = snapshot(tx("food", 2000), tx("shopping", 1000, "shopping"))
        val original = ledger.copy(transactions = ledger.transactions.toList(),
            categories = ledger.categories.toList())
        val result = previewPurchase(ledger, draft(), today).getOrThrow()
        assertEquals(Comparison(8000, 5500, 6000, 4750), result)
        assertEquals(original, ledger)
        assertEquals(result, previewPurchase(ledger, draft(), today).getOrThrow())
        val lastDay = today.plusDays(1)
        assertEquals(9500L, previewPurchase(ledger, draft(), lastDay)
            .getOrThrow().afterAllowanceCents)
    }

    @Test fun purchaseOpenedJanuary31UsesFebruaryRecordDateAndSpending() {
        // Exercise both February lengths with fixed dates, independent of device time.
        for (year in listOf(2023, 2024)) {
            val opened = LocalDate.of(year, 1, 31)
            val recorded = LocalDate.of(year, 2, 1)
            val input = draft().copy(dateText = opened.toString(), amountText = "28.00")
            val originalDraft = input.copy()
            val ledger = snapshot(
                tx("january-food", 9000, date = opened),
                tx("january-shopping", 4000, "shopping", opened),
                tx("february-food", 2000, date = recorded),
                tx("february-shopping", 1800, "shopping", recorded),
                tx("february-income", 70000, date = recorded,
                    type = TransactionType.INCOME),
                tx("march-food", 99000, date = recorded.plusMonths(1))
            )
            val originalLedger = ledger.copy(transactions = ledger.transactions.toList(),
                categories = ledger.categories.toList())

            val prepared = preparePurchase(ledger, input, recorded).getOrThrow()
            assertEquals(recorded.toString(), prepared.draft.dateText)
            assertEquals(input.copy(dateText = recorded.toString()), prepared.draft)
            assertEquals(input.operationId, prepared.draft.operationId)
            assertNull(prepared.draft.transactionId)
            assertEquals(TransactionType.EXPENSE, prepared.draft.type)
            // February spending is $38; January spending and income consume none
            // of February's $150 total limits. The purchase day is included.
            val expected = if (year == 2024) Comparison(8000, 5200, 386, 289)
                else Comparison(8000, 5200, 400, 300)
            assertEquals(expected, prepared.comparison)
            assertEquals(expected, previewPurchase(ledger, input, recorded).getOrThrow())
            assertEquals(prepared, preparePurchase(ledger, input, recorded).getOrThrow())
            assertEquals(prepared,
                preparePurchase(ledger, prepared.draft, recorded).getOrThrow())
            assertEquals(originalDraft, input)
            assertEquals(opened.toString(), input.dateText)
            assertEquals(originalLedger, ledger)
        }
    }

    @Test fun purchaseReconcilesAcrossLeapDayAndIntoMarchWithoutMutation() {
        val leapDay = LocalDate.of(2024, 2, 29)
        val marchFirst = LocalDate.of(2024, 3, 1)
        val input = draft().copy(dateText = "2024-02-28")
        val ledger = snapshot(
            tx("february-food", 2000, date = leapDay.minusDays(1)),
            tx("march-food", 3800, date = marchFirst),
            tx("march-shopping", 1900, "shopping", marchFirst)
        )
        val originalLedger = ledger.copy(transactions = ledger.transactions.toList(),
            categories = ledger.categories.toList())
        val originalDraft = input.copy()

        val onLeapDay = preparePurchase(ledger, input, leapDay).getOrThrow()
        assertEquals("2024-02-29", onLeapDay.draft.dateText)
        // Exactly one day remains in February, including leap day itself.
        assertEquals(Comparison(8000, 5500, 13000, 10500), onLeapDay.comparison)

        val inMarch = preparePurchase(ledger, onLeapDay.draft, marchFirst).getOrThrow()
        assertEquals("2024-03-01", inMarch.draft.dateText)
        // March has $57 spent and 31 inclusive days; February is excluded.
        assertEquals(Comparison(6200, 3700, 300, 219), inMarch.comparison)
        assertEquals(input.copy(dateText = marchFirst.toString()), inMarch.draft)
        assertEquals(input.operationId, inMarch.draft.operationId)
        assertEquals(inMarch, preparePurchase(ledger, input, marchFirst).getOrThrow())
        assertEquals(inMarch,
            preparePurchase(ledger, inMarch.draft, marchFirst).getOrThrow())
        assertEquals(originalDraft, input)
        assertEquals(originalLedger, ledger)
    }

    @Test fun overBudgetPreviewStaysSignedAndMissingBudgetFails() {
        val ledger = snapshot(tx("food", 16001))
        assertEquals(Comparison(-6001, -8501, -500, -1750),
            previewPurchase(ledger, draft(), today).getOrThrow())
        assertTrue(previewPurchase(ledger, draft().copy(categoryId = "other"), today).isFailure)
        assertTrue(previewPurchase(ledger, draft().copy(amountText = "-2"), today).isFailure)
        assertEquals(1, ledger.transactions.size)
    }

    @Test fun aggregateOverflowIsReportedInsteadOfWrapping() {
        val ledger = snapshot(tx("large", Long.MAX_VALUE), tx("extra", 1))
        assertThrows(ArithmeticException::class.java) {
            summarizeMonth(ledger, YearMonth.from(today))
        }
        assertTrue(previewPurchase(ledger, draft(), today).isFailure)
        val limits = categories.map { it.copy(monthlyLimitCents = Long.MAX_VALUE) }
        assertThrows(ArithmeticException::class.java) {
            summarizeMonth(LedgerSnapshot(emptyList(), limits, "green"), YearMonth.from(today))
        }
    }

    @Test fun dirtyChecksEditableValuesAndRecognizesRevertingChanges() {
        val original = draft()
        val clean = DraftSession(original, original, true)
        assertFalse(isDirty(clean))
        assertTrue(isDirty(clean.copy(current = original.copy(amountText = "25.0"))))
        assertTrue(isDirty(clean.copy(current = original.copy(type = TransactionType.INCOME))))
        assertFalse(isDirty(clean.copy(current = original.copy(operationId = "different"))))
        assertFalse(isDirty(clean.copy(current = original.copy())))
    }

    @Test fun restoredSessionPreservesNestedReturnRouteInvalidInputAndPendingIdentity() {
        val original = draft()
        val session = SavedSession(
            AppNavState(PrimarySection.CALENDAR, YearMonth.of(2024, 2), listOf(
                DetailRoute.Day(today), DetailRoute.Editor("existing", today),
                DetailRoute.Sandbox, DetailRoute.Budget("food")
            )),
            DraftSession(original.copy(title = "Tea \"special\"\n☕", amountText = "12."),
                original, true),
            BudgetDraft("food", "-", "100.00"), "operation-1",
            mapOf("HOME" to (12 to 37), "day:$today" to (2 to 4))
        )
        val restored = decodeSession(encodeSession(session)).getOrThrow()
        assertEquals(session, restored)
        assertEquals(restored.pendingOperationId, restored.draft!!.current.operationId)
        assertTrue(isDirty(restored.draft))
        assertEquals(session, decodeSession(encodeSession(restored)).getOrThrow())
    }

    @Test fun invalidOrFutureSessionCannotSilentlyRestoreANewOperation() {
        assertTrue(decodeSession("not json").isFailure)
        val session = SavedSession(AppNavState(PrimarySection.HOME, YearMonth.from(today),
            emptyList()), null, null, null, emptyMap())
        assertEquals(session, decodeSession(encodeSession(session)).getOrThrow())
        assertTrue(decodeSession(encodeSession(session).replace("\"version\":1",
            "\"version\":99")).isFailure)
        val mismatched = session.copy(draft = DraftSession(
            draft().copy(operationId = "replacement"), draft(), true))
        assertTrue(decodeSession(encodeSession(mismatched)).isFailure)
    }
}
