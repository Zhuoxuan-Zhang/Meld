package com.meld.minefield

import java.util.Random
import java.util.UUID

enum class Phase { READY, PLAYING, WON, LOST }
enum class InputMode { REVEAL, FLAG, MARK }
enum class Appearance { SYSTEM, LIGHT, DARK }
data class Cell(val mine: Boolean = false, val revealed: Boolean = false, val flagged: Boolean = false, val mark: Int = 0)
data class Board(
  val id: String = UUID.randomUUID().toString(),
  val seed: Long = Random().nextLong(),
  val cells: List<Cell> = List(81) { Cell() },
  val phase: Phase = Phase.READY,
  val seconds: Int = 0,
  val paused: Boolean = false,
  val mode: InputMode = InputMode.REVEAL
) {
  val remaining get() = 10 - cells.count { it.flagged }
  val complete get() = phase == Phase.WON || phase == Phase.LOST
  fun adjacent(index: Int) = neighbors(index).count { cells[it].mine }
}
data class Outcome(val gameId: String, val won: Boolean, val seconds: Int)
data class Preferences(val appearance: Appearance = Appearance.SYSTEM, val defaultFlag: Boolean = false)
data class Session(
  val board: Board = Board(),
  val undo: Board? = null,
  val outcomes: List<Outcome> = emptyList(),
  val preferences: Preferences = Preferences()
)

fun neighbors(index: Int): List<Int> {
  require(index in 0..80)
  val row = index / 9
  val col = index % 9
  return buildList {
    for (dr in -1..1) for (dc in -1..1) {
      if ((dr != 0 || dc != 0) && row + dr in 0..8 && col + dc in 0..8) add((row + dr) * 9 + col + dc)
    }
  }
}

object Game {
  fun reveal(session: Session, index: Int): Session {
    if (index !in 0..80) return session
    val before = session.board
    if (before.complete || before.paused || before.cells[index].revealed || before.cells[index].flagged) return session
    var board = before
    if (board.phase == Phase.READY) {
      val eligible = (0..80).filter { it != index }.toMutableList()
      java.util.Collections.shuffle(eligible, Random(board.seed))
      val mines = eligible.take(10).toSet()
      board = board.copy(cells = board.cells.mapIndexed { i, c -> c.copy(mine = i in mines) }, phase = Phase.PLAYING)
    }
    val cells = board.cells.toMutableList()
    if (cells[index].mine) {
      cells[index] = cells[index].copy(revealed = true, mark = 0)
    } else {
      val pending = ArrayDeque<Int>()
      pending.add(index)
      while (pending.isNotEmpty()) {
        val i = pending.removeFirst()
        val cell = cells[i]
        if (cell.revealed || cell.flagged || cell.mine) continue
        cells[i] = cell.copy(revealed = true, mark = 0)
        if (board.adjacent(i) == 0) neighbors(i).forEach { pending.add(it) }
      }
    }
    val phase = when {
      cells.any { it.mine && it.revealed } -> Phase.LOST
      cells.count { !it.mine && it.revealed } == 71 -> Phase.WON
      else -> Phase.PLAYING
    }
    val after = board.copy(cells = cells.toList(), phase = phase)
    val outcomes = session.outcomes.filterNot { it.gameId == board.id } +
      if (after.complete) listOf(Outcome(board.id, phase == Phase.WON, after.seconds)) else emptyList()
    return session.copy(board = after, undo = before, outcomes = outcomes)
  }

  fun flag(session: Session, index: Int): Session {
    if (index !in 0..80) return session
    val b = session.board
    val cell = b.cells[index]
    if (b.complete || b.paused || cell.revealed || (!cell.flagged && b.remaining == 0)) return session
    return session.copy(board = b.copy(cells = b.cells.mapIndexed { i, c ->
      if (i == index) c.copy(flagged = !c.flagged, mark = 0) else c
    }), undo = b)
  }

  fun mark(session: Session, index: Int, digit: Int): Session {
    if (index !in 0..80 || digit !in 0..8) return session
    val b = session.board
    if (b.complete || b.paused || b.cells[index].revealed || b.cells[index].flagged || b.cells[index].mark == digit) return session
    // An annotation is a new board edit; never let an older undo erase it silently.
    return session.copy(board = b.copy(cells = b.cells.mapIndexed { i, c -> if (i == index) c.copy(mark = digit) else c }), undo = null)
  }

  fun undo(session: Session): Session {
    val previous = session.undo ?: return session
    if (session.board.paused) return session
    return session.copy(
      board = previous.copy(mode = session.board.mode),
      undo = null,
      outcomes = session.outcomes.filterNot { it.gameId == session.board.id }
    )
  }

  fun tick(session: Session): Session {
    val b = session.board
    return if (b.phase == Phase.PLAYING && !b.paused && b.seconds < Int.MAX_VALUE)
      session.copy(board = b.copy(seconds = b.seconds + 1)) else session
  }

  fun newGame(session: Session): Session = session.copy(
    board = Board(mode = if (session.preferences.defaultFlag) InputMode.FLAG else InputMode.REVEAL), undo = null
  )

  fun validate(session: Session) {
    validateBoard(session.board)
    session.undo?.let {
      validateBoard(it)
      require(it.id == session.board.id && it.seed == session.board.seed && !it.complete && !it.paused) { "Invalid undo snapshot" }
      require(it.seconds <= session.board.seconds) { "Invalid undo timer" }
    }
    require(session.outcomes.map { it.gameId }.distinct().size == session.outcomes.size) { "Duplicate outcome" }
    require(session.outcomes.all { it.gameId.isNotBlank() && it.seconds >= 0 }) { "Invalid outcome" }
    val result = session.outcomes.singleOrNull { it.gameId == session.board.id }
    require(if (session.board.complete) result != null && result.won == (session.board.phase == Phase.WON) && result.seconds == session.board.seconds else result == null) { "Outcome disagrees with board" }
  }

  private fun validateBoard(b: Board) {
    require(b.id.isNotBlank() && b.cells.size == 81 && b.seconds >= 0) { "Invalid board dimensions or timer" }
    require(b.cells.count { it.flagged } <= 10) { "Too many flags" }
    require(b.cells.all { it.mark in 0..8 && !(it.flagged && it.revealed) && (!(it.flagged || it.revealed) || it.mark == 0) }) { "Invalid cell state" }
    val lost = b.cells.any { it.mine && it.revealed }
    val won = b.cells.count { !it.mine && it.revealed } == 71
    when (b.phase) {
      Phase.READY -> require(b.cells.none { it.mine || it.revealed } && b.seconds == 0 && !b.paused)
      Phase.PLAYING -> require(b.cells.count { it.mine } == 10 && b.cells.any { it.revealed } && !lost && !won)
      Phase.WON -> require(b.cells.count { it.mine } == 10 && won && !lost && !b.paused)
      Phase.LOST -> require(b.cells.count { it.mine } == 10 && lost && !won && !b.paused)
    }
  }
}
