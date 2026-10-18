package com.meld.minefield

import java.io.IOException
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StorageTest {
  private fun initial() = Session(board = Board(id = "storage-game", seed = 5))
  private fun assertRejected(change: (JSONObject) -> Unit) {
    val json = JSONObject(SessionCodec.encode(initial()))
    change(json)
    assertThrows(Exception::class.java) { SessionCodec.decode(json.toString()) }
  }

  @Test fun exactRoundTripIncludesUndoTimerNotesAndPreferences() {
    var s = Game.mark(initial(), 4, 7)
    s = Game.flag(s, 3)
    s = Game.reveal(s, 40)
    s = Game.tick(s)
    s = s.copy(board = s.board.copy(paused = true, mode = InputMode.MARK), preferences = Preferences(Appearance.DARK, true))
    assertEquals(s, SessionCodec.decode(SessionCodec.encode(s)))
  }
  @Test fun unknownVersionRejected() = assertRejected { it.put("version", 2) }
  @Test fun fractionalTimeRejected() = assertRejected { it.getJSONObject("board").put("seconds", 0.5) }
  @Test fun overflowingTimeRejected() = assertRejected { it.getJSONObject("board").put("seconds", 4294967296L) }
  @Test fun stringBooleansRejected() = assertRejected { it.getJSONObject("board").put("paused", "false") }
  @Test fun missingUndoRejected() = assertRejected { it.remove("undo") }
  @Test fun incompleteSaveRejected() = assertRejected { it.remove("board") }
  @Test fun truncatedJsonRejected() { assertThrows(Exception::class.java) { SessionCodec.decode("{\"version\":1,") } }
  @Test fun missingCellsRejected() = assertRejected { it.getJSONObject("board").getJSONArray("cells").remove(0) }
  @Test fun negativeTimeRejected() = assertRejected { it.getJSONObject("board").put("seconds", -1) }
  @Test fun invalidPhaseRejected() = assertRejected { it.getJSONObject("board").put("phase", "OTHER") }
  @Test fun hiddenMinesOnReadyBoardRejected() = assertRejected { it.getJSONObject("board").getJSONArray("cells").getJSONObject(0).put("mine", true) }
  @Test fun impossibleWonBoardRejected() = assertRejected { it.getJSONObject("board").put("phase", "WON") }
  @Test fun invalidMarksRejected() = assertRejected { it.getJSONObject("board").getJSONArray("cells").getJSONObject(0).put("mark", 9) }
  @Test fun mismatchedUndoRejected() = assertRejected {
    it.put("undo", JSONObject(it.getJSONObject("board").toString()).put("id", "other-game"))
  }
  @Test fun duplicateOutcomesRejected() {
    val result = Outcome("old-game", false, 2)
    assertThrows(IllegalArgumentException::class.java) { SessionCodec.encode(initial().copy(outcomes = listOf(result, result))) }
  }
  @Test fun terminalOutcomeMustMatchBoard() {
    val s = Game.reveal(initial(), 40)
    val lost = Game.reveal(s, s.board.cells.indexOfFirst { it.mine })
    assertThrows(IllegalArgumentException::class.java) { SessionCodec.encode(lost.copy(outcomes = emptyList())) }
    assertThrows(IllegalArgumentException::class.java) { SessionCodec.encode(lost.copy(outcomes = listOf(Outcome(lost.board.id, true, 0)))) }
  }

  private class FailingStore : SessionStore {
    var saved: Session? = null
    var fail = false
    override fun load() = saved
    override fun save(session: Session) { if(fail) throw IOException("Full disk"); saved = SessionCodec.decode(SessionCodec.encode(session)) }
    override fun archive() { saved = null }
  }
  @Test fun failedSaveRetainsLatestMoveAndRetryCommitsWholeSession() {
    val store = FailingStore()
    val before = initial()
    store.save(before)
    val transaction = SessionTransaction(store, before)
    store.fail = true
    assertThrows(IOException::class.java) { transaction.update { Game.reveal(it, 40) } }
    assertTrue(transaction.dirty)
    assertEquals(before, store.saved)
    assertNotEquals(before, transaction.session)
    store.fail = false
    transaction.retry()
    assertEquals(transaction.session, store.saved)
    assertFalse(transaction.dirty)
  }
  @Test fun failedNewGameDoesNotReplaceAcceptedBoard() {
    val store = FailingStore()
    val before = Game.reveal(initial(), 40)
    store.save(before)
    val transaction = SessionTransaction(store, before)
    store.fail = true
    assertThrows(IOException::class.java) { transaction.update(replacement = true) { Game.newGame(it) } }
    assertEquals(before, transaction.session)
    assertEquals(before, store.saved)
    assertFalse(transaction.dirty)
  }
  @Test fun invalidCandidateNeverTouchesSave() {
    val store = FailingStore()
    val before = initial()
    store.save(before)
    val transaction = SessionTransaction(store, before)
    assertThrows(IllegalArgumentException::class.java) { transaction.update { it.copy(board = it.board.copy(seconds = -1)) } }
    assertEquals(before, transaction.session)
    assertEquals(before, store.saved)
  }
}
