package com.meld.minefield

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AppState(
  val session: Session? = null,
  val loading: Boolean = true,
  val busy: Boolean = false,
  val dirty: Boolean = false,
  val error: String? = null
)

class GameViewModel(application: Application) : AndroidViewModel(application) {
  private val store: SessionStore = FileSessionStore(application.filesDir)
  private var transaction: SessionTransaction? = null
  private val mutable = MutableStateFlow(AppState())
  val state = mutable.asStateFlow()
  private val commands = Channel<() -> Unit>(Channel.UNLIMITED)
  @Volatile var clockVisible = false

  init {
    viewModelScope.launch(Dispatchers.IO) { for (command in commands) command() }
    load()
    viewModelScope.launch {
      while (true) {
        delay(1000)
        if (clockVisible && !mutable.value.dirty && !mutable.value.busy) update { Game.tick(it) }
      }
    }
  }

  fun load() {
    commands.trySend {
      mutable.value = mutable.value.copy(loading = true, error = null)
      try {
        val saved = store.load() ?: Session().also { store.save(it) }
        transaction = SessionTransaction(store, saved)
        mutable.value = AppState(session = saved, loading = false)
      } catch (_: Exception) {
        transaction = null
        mutable.value = AppState(loading = false, error = "Your saved game couldn't be opened. Retry, or preserve it and start fresh.")
      }
    }
  }

  fun recover() {
    commands.trySend {
      mutable.value = mutable.value.copy(busy = true)
      try {
        store.archive()
        val fresh = Session()
        store.save(fresh)
        transaction = SessionTransaction(store, fresh)
        mutable.value = AppState(session = fresh, loading = false)
      } catch (_: Exception) {
        mutable.value = mutable.value.copy(busy = false, error = "Couldn't create a new save. Free some space and retry.")
      }
    }
  }

  fun update(replacement: Boolean = false, change: (Session) -> Session) {
    commands.trySend {
      val current = transaction ?: return@trySend
      mutable.value = mutable.value.copy(busy = true)
      try {
        current.update(replacement, change)
        mutable.value = AppState(session = current.session, loading = false)
      } catch (_: Exception) {
        mutable.value = AppState(session = current.session, loading = false, dirty = current.dirty,
          error = if (replacement) "Couldn't save the new game. Your previous board is still here." else "Progress isn't saved yet. Free some space, then retry.")
      }
    }
  }

  fun retrySave() {
    commands.trySend {
      val current = transaction ?: return@trySend
      try {
        current.retry()
        mutable.value = AppState(session = current.session, loading = false)
      } catch (_: Exception) {
        mutable.value = mutable.value.copy(error = "Still couldn't save. Keep the app open and free some space.")
      }
    }
  }
}
