package com.meld.minefield

import org.json.JSONArray
import org.json.JSONObject

/** One versioned transaction includes the board, undo, preferences and outcomes. */
object SessionCodec {
  fun encode(session: Session): String {
    Game.validate(session)
    return JSONObject().put("version", 1).put("board", boardJson(session.board))
      .put("undo", session.undo?.let { boardJson(it) } ?: JSONObject.NULL)
      .put("outcomes", JSONArray().apply { session.outcomes.forEach {
        put(JSONObject().put("gameId", it.gameId).put("won", it.won).put("seconds", it.seconds))
      } }).put("preferences", JSONObject().put("appearance", session.preferences.appearance.name)
        .put("defaultFlag", session.preferences.defaultFlag)).toString()
  }

  fun decode(text: String): Session {
    val json = JSONObject(text)
    require(integer(json, "version") == 1) { "Unsupported save version" }
    require(json.has("undo")) { "Missing undo field" }
    val preferences = json.getJSONObject("preferences")
    val outcomes = json.getJSONArray("outcomes")
    val result = Session(
      board = readBoard(json.getJSONObject("board")),
      undo = if (json.isNull("undo")) null else readBoard(json.getJSONObject("undo")),
      outcomes = List(outcomes.length()) { i -> outcomes.getJSONObject(i).let {
        Outcome(it.getString("gameId"), boolean(it, "won"), integer(it, "seconds"))
      } },
      preferences = Preferences(Appearance.valueOf(preferences.getString("appearance")), boolean(preferences, "defaultFlag"))
    )
    Game.validate(result)
    return result
  }

  private fun boardJson(b: Board) = JSONObject().put("id", b.id).put("seed", b.seed)
    .put("phase", b.phase.name).put("seconds", b.seconds).put("paused", b.paused).put("mode", b.mode.name)
    .put("cells", JSONArray().apply { b.cells.forEach {
      put(JSONObject().put("mine", it.mine).put("revealed", it.revealed).put("flagged", it.flagged).put("mark", it.mark))
    } })

  private fun readBoard(j: JSONObject): Board {
    val cells = j.getJSONArray("cells")
    require(cells.length() == 81) { "Expected 81 cells" }
    return Board(
      id = j.getString("id"), seed = long(j, "seed"),
      cells = List(81) { i -> cells.getJSONObject(i).let {
        Cell(boolean(it, "mine"), boolean(it, "revealed"), boolean(it, "flagged"), integer(it, "mark"))
      } },
      phase = Phase.valueOf(j.getString("phase")), seconds = integer(j, "seconds"),
      paused = boolean(j, "paused"), mode = InputMode.valueOf(j.getString("mode"))
    )
  }

  private fun long(j: JSONObject, key: String): Long {
    val value = j.get(key)
    require(value is Int || value is Long) { "$key must be an integer" }
    return (value as Number).toLong()
  }

  private fun integer(j: JSONObject, key: String): Int {
    val value = long(j, key)
    require(value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) { "$key out of range" }
    return value.toInt()
  }

  private fun boolean(j: JSONObject, key: String): Boolean {
    val value = j.get(key)
    require(value is Boolean) { "$key must be boolean" }
    return value
  }
}
