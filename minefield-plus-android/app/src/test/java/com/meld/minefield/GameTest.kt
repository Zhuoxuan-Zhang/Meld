package com.meld.minefield

import org.junit.Assert.*
import org.junit.Test

class GameTest {
  private fun fresh(seed: Long = 41L) = Session(board = Board(id = "test-game", seed = seed))
  private fun started() = Game.reveal(fresh(), 40)
  private fun mine(s: Session) = s.board.cells.indexOfFirst { it.mine && !it.flagged }
  private fun covered(s: Session) = s.board.cells.indexOfFirst { !it.revealed && !it.flagged }

  @Test fun firstTapSafeAcrossSeedsAndAllCells() {
    for (seed in 0L..39L) for (index in 0..80) {
      val s = Game.reveal(fresh(seed), index)
      assertFalse(s.board.cells[index].mine)
      assertTrue(s.board.cells[index].revealed)
      assertEquals(10, s.board.cells.count { it.mine })
      Game.validate(s)
    }
  }

  @Test fun deterministicPlacementAfterRestartAndUndo() {
    val s = Game.reveal(fresh(), 40)
    assertEquals(s, Game.reveal(Game.undo(s), 40))
    assertEquals(s, Game.reveal(SessionCodec.decode(SessionCodec.encode(fresh())), 40))
  }

  @Test fun neighborsNeverWrapAcrossRows() {
    assertEquals(setOf(1, 9, 10), neighbors(0).toSet())
    assertEquals(setOf(70, 71, 79), neighbors(80).toSet())
    assertEquals(8, neighbors(40).size)
    assertFalse(neighbors(8).contains(9))
  }

  @Test fun floodRevealMatchesIndependentReachability() {
    for (seed in 0L..50L) {
      val s = Game.reveal(fresh(seed), 40)
      val expected = mutableSetOf<Int>()
      val pending = mutableListOf(40)
      while (pending.isNotEmpty()) {
        val i = pending.removeAt(0)
        if (!expected.add(i)) continue
        val adjacent = (0..80).filter { it != i && kotlin.math.abs(it / 9 - i / 9) <= 1 && kotlin.math.abs(it % 9 - i % 9) <= 1 }
        if (adjacent.none { s.board.cells[it].mine }) pending.addAll(adjacent.filter { !s.board.cells[it].mine })
      }
      assertEquals(expected, s.board.cells.indices.filter { s.board.cells[it].revealed }.toSet())
    }
  }

  @Test fun flagStopsRevealAndCountsExactly() {
    val s = Game.flag(fresh(), 40)
    assertEquals(9, s.board.remaining)
    assertEquals(s, Game.reveal(s, 40))
    assertEquals(fresh(), Game.undo(s))
    assertEquals(10, Game.flag(s, 40).board.remaining)
  }

  @Test fun tenFlagsMaximumAndUndoStillWorks() {
    var s = fresh()
    repeat(10) { s = Game.flag(s, it) }
    assertEquals(0, s.board.remaining)
    assertEquals(s, Game.flag(s, 20))
    assertEquals(1, Game.undo(s).board.remaining)
  }

  @Test fun flagProtectsCellFromFlood() {
    val s = Game.reveal(Game.flag(fresh(), 39), 40)
    assertTrue(s.board.cells[39].flagged)
    assertFalse(s.board.cells[39].revealed)
  }

  @Test fun undoRestoresEntireFloodAndTimer() {
    val before = Game.tick(started())
    val target = before.board.cells.indexOfFirst { !it.revealed && !it.mine }
    val after = Game.reveal(before, target)
    assertEquals(before.copy(undo = null), Game.undo(Game.tick(after)))
    assertNull(Game.undo(after).undo)
    assertEquals(Game.undo(after), Game.undo(Game.undo(after)))
  }

  @Test fun firstRevealUndoRestoresUnplantedBoardAndAnnotations() {
    val annotated = Game.mark(fresh(), 40, 3)
    assertEquals(0, Game.reveal(annotated, 40).board.cells[40].mark)
    assertEquals(annotated, Game.undo(Game.reveal(annotated, 40)))
  }

  @Test fun markIsPersonalAndClearsOlderUndo() {
    val s = started()
    val index = covered(s)
    val marked = Game.mark(s, index, 8)
    assertEquals(s.board.cells.map { it.mine }, marked.board.cells.map { it.mine })
    assertEquals(8, marked.board.cells[index].mark)
    assertNull(marked.undo)
    assertEquals(0, Game.mark(marked, index, 0).board.cells[index].mark)
    assertEquals(marked, Game.mark(marked, index, 9))
    assertEquals(s, Game.mark(s, 40, 2))
  }

  @Test fun flagClearsMarkAndUndoRestoresIt() {
    val s = Game.mark(fresh(), 5, 4)
    val flagged = Game.flag(s, 5)
    assertEquals(0, flagged.board.cells[5].mark)
    assertEquals(flagged, Game.mark(flagged, 5, 2))
    assertEquals(s, Game.undo(flagged))
  }

  @Test fun lossIsRecordedOnceAndUndoRetractsIt() {
    val s = started()
    val lost = Game.reveal(s, mine(s))
    assertEquals(Phase.LOST, lost.board.phase)
    assertEquals(1, lost.outcomes.size)
    assertEquals(lost, Game.reveal(lost, mine(s)))
    assertEquals(lost, Game.flag(lost, covered(lost)))
    val undone = Game.undo(SessionCodec.decode(SessionCodec.encode(lost)))
    assertEquals(s.board, undone.board)
    assertTrue(undone.outcomes.isEmpty())
    assertEquals(1, Game.reveal(undone, mine(s)).outcomes.size)
    Game.validate(lost)
  }

  @Test fun winningRequiresAllSafeCellsAndSurvivesReload() {
    var s = started()
    for (i in 0..80) if (!s.board.cells[i].mine) s = Game.reveal(s, i)
    assertEquals(Phase.WON, s.board.phase)
    assertEquals(71, s.board.cells.count { it.revealed })
    assertEquals(listOf(Outcome("test-game", true, 0)), s.outcomes)
    assertEquals(s, SessionCodec.decode(SessionCodec.encode(s)))
    assertEquals(Phase.PLAYING, Game.undo(s).board.phase)
    assertTrue(Game.undo(s).outcomes.isEmpty())
  }

  @Test fun timerOnlyRunsDuringActivePlay() {
    assertEquals(fresh(), Game.tick(fresh()))
    val s = started()
    assertEquals(1, Game.tick(s).board.seconds)
    val paused = s.copy(board = s.board.copy(paused = true))
    assertEquals(paused, Game.tick(paused))
    assertEquals(paused, Game.reveal(paused, mine(s)))
    assertEquals(paused, Game.flag(paused, covered(s)))
    assertEquals(paused, Game.undo(paused))
    val lost = Game.reveal(s, mine(s))
    assertEquals(lost, Game.tick(lost))
  }

  @Test fun newGameKeepsOutcomesPreferencesAndResetsBoard() {
    val s = started()
    val lost = Game.reveal(s, mine(s)).copy(preferences = Preferences(Appearance.DARK, true))
    val fresh = Game.newGame(lost)
    assertNotEquals(lost.board.id, fresh.board.id)
    assertEquals(Phase.READY, fresh.board.phase)
    assertEquals(0, fresh.board.seconds)
    assertEquals(10, fresh.board.remaining)
    assertEquals(InputMode.FLAG, fresh.board.mode)
    assertEquals(lost.preferences, fresh.preferences)
    assertEquals(lost.outcomes, fresh.outcomes)
    assertNull(fresh.undo)
    Game.validate(fresh)
  }

  @Test fun invalidIndicesAreNoOps() {
    val s = started()
    for (i in listOf(-1, 81, Int.MAX_VALUE)) {
      assertEquals(s, Game.reveal(s, i)); assertEquals(s, Game.flag(s, i)); assertEquals(s, Game.mark(s, i, 2))
    }
  }

  @Test fun longActionSequencesMaintainSaveInvariants() {
    val random = java.util.Random(97)
    var s = fresh()
    repeat(2000) {
      val index = random.nextInt(81)
      s = when(random.nextInt(7)) {
        0 -> Game.reveal(s, index)
        1 -> Game.flag(s, index)
        2 -> Game.mark(s, index, random.nextInt(9))
        3 -> Game.undo(s)
        4 -> Game.tick(s)
        5 -> if(s.board.complete) Game.newGame(s) else s
        else -> SessionCodec.decode(SessionCodec.encode(s))
      }
      Game.validate(s)
    }
  }
}
