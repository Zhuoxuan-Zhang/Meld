package com.meld.minefield

import android.util.AtomicFile
import java.io.File

interface SessionStore {
  fun load(): Session?
  fun save(session: Session)
  fun archive()
}

class FileSessionStore(private val directory: File) : SessionStore {
  private val base = File(directory, "session.json")
  private val atomic = AtomicFile(base)
  override fun load(): Session? {
    if (!base.exists() && !File(directory, "session.json.bak").exists()) return null
    return SessionCodec.decode(atomic.openRead().bufferedReader().use { it.readText() })
  }

  override fun save(session: Session) {
    val bytes = SessionCodec.encode(session).toByteArray(Charsets.UTF_8)
    val stream = atomic.startWrite()
    try {
      stream.write(bytes)
      atomic.finishWrite(stream)
    } catch (e: Exception) {
      atomic.failWrite(stream)
      throw e
    }
  }

  override fun archive() {
    val stamp = System.currentTimeMillis()
    for (name in listOf("session.json", "session.json.bak", "session.json.new")) {
      val file = File(directory, name)
      if (file.exists()) check(file.renameTo(File(directory, "$name.failed-$stamp"))) { "Cannot preserve unreadable save" }
    }
  }
}

/** Replacements become visible only after persistence succeeds. Other edits remain retryable. */
class SessionTransaction(private val store: SessionStore, initial: Session) {
  var session: Session = initial
    private set
  var dirty: Boolean = false
    private set

  fun update(replacement: Boolean = false, change: (Session) -> Session) {
    val candidate = change(session)
    Game.validate(candidate)
    if (candidate == session && !dirty) return
    if (!replacement) { session = candidate; dirty = true }
    store.save(candidate)
    session = candidate
    dirty = false
  }

  fun retry() { store.save(session); dirty = false }
}
