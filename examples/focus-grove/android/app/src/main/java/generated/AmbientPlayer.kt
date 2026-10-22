package generated

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import java.io.File
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/** Injectable platform boundary; preparation may suspend without owning timer state. */
interface AmbientPlaybackPort {
    suspend fun prepare(loop: SoundLoop)
    fun setLooping(looping: Boolean)
    fun setVolume(volume: Float)
    fun start()
    fun pause()
    fun release()
}

/**
 * Selection owns a candidate until installation succeeds. Pause, replacement and
 * shutdown invalidate that ownership before a suspended preparation can return.
 */
class AmbientPlayer(private val createPlayback: () -> AmbientPlaybackPort) {
    constructor(context: Context) : this({
        MediaPlayerAmbientPort(context.applicationContext)
    })

    private val guard = Any()
    private var player: AmbientPlaybackPort? = null
    private var generation = 0L
    private var closed = false
    private var volume = 0.5f
    private var wantsPlayback = false

    /** Returns successfully only after this selection has actually started. */
    suspend fun select(loop: SoundLoop) {
        val ticket = synchronized(guard) {
            check(!closed) { "Sound player is closed." }
            generation++
            wantsPlayback = loop != SoundLoop.NONE
            releaseLocked()
            generation
        }
        if (loop == SoundLoop.NONE) return

        var candidate: AmbientPlaybackPort? = null
        try {
            withContext(Dispatchers.IO) {
                currentCoroutineContext().ensureActive()
                val audio = createPlayback()
                candidate = audio
                audio.prepare(loop)
                val coroutine = currentCoroutineContext()
                coroutine.ensureActive()
                synchronized(guard) {
                    coroutine.ensureActive()
                    if (closed || ticket != generation || !wantsPlayback) {
                        throw CancellationException("Sound selection no longer requested.")
                    }
                    audio.setLooping(true)
                    audio.setVolume(volume)
                    audio.start()
                    player = audio
                    candidate = null
                }
            }
            // A dispatcher handoff can be cancelled after ownership transfers.
            currentCoroutineContext().ensureActive()
        } catch (failure: Throwable) {
            synchronized(guard) {
                if (ticket == generation) {
                    wantsPlayback = false
                    releaseLocked()
                }
            }
            throw failure
        } finally {
            candidate?.let { runCatching { it.release() } }
        }
    }

    fun setVolume(volume: Float) = synchronized(guard) {
        this.volume = volume.takeIf { it.isFinite() }?.coerceIn(0f, 1f) ?: 0.5f
        player?.setVolume(this.volume)
        Unit
    }

    /** Installed playback remains resumable; pending selections are vetoed. */
    fun pause() = synchronized(guard) {
        generation++
        wantsPlayback = false
        player?.pause()
        Unit
    }

    /** Platform failures propagate instead of reporting false playback success. */
    fun resume() = synchronized(guard) {
        check(!closed) { "Sound player is closed." }
        val audio = player ?: return@synchronized
        try {
            audio.setVolume(volume)
            audio.start()
            wantsPlayback = true
        } catch (failure: Exception) {
            wantsPlayback = false
            releaseLocked()
            throw failure
        }
    }

    fun close() = synchronized(guard) {
        closed = true
        generation++
        wantsPlayback = false
        releaseLocked()
    }

    private fun releaseLocked() {
        val previous = player
        player = null
        previous?.let { runCatching { it.release() } }
    }
}

/** Real app-owned Android media playback, visible to AudioPlaybackConfiguration. */
private class MediaPlayerAmbientPort(private val context: Context) : AmbientPlaybackPort {
    private val media = MediaPlayer()
    private val released = AtomicBoolean(false)
    private var prepared = false
    private var playing = false

    override suspend fun prepare(loop: SoundLoop) {
        require(loop != SoundLoop.NONE)
        withContext(Dispatchers.IO) {
            val coroutine = currentCoroutineContext()
            coroutine.ensureActive()
            val directory = File(context.cacheDir, "ambient_loops")
            check(directory.isDirectory || directory.mkdirs()) { "Cannot create sound cache." }
            val file = File.createTempFile("${loop.name.lowercase()}-", ".wav", directory)
            try {
                file.outputStream().buffered(8192).use { output ->
                    AmbientWavEncoder.encode(loop, output) { coroutine.ensureActive() }
                }
                coroutine.ensureActive()
                check(!released.get()) { "Sound player was released." }
                media.setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
                media.setDataSource(file.absolutePath)
                suspendCancellableCoroutine<Unit> { continuation ->
                    media.setOnPreparedListener {
                        if (continuation.isActive) {
                            prepared = true
                            continuation.resume(Unit)
                        }
                    }
                    media.setOnErrorListener { _, what, extra ->
                        if (continuation.isActive) continuation.resumeWithException(
                            IllegalStateException("Sound preparation failed ($what/$extra)."))
                        true
                    }
                    continuation.invokeOnCancellation { release() }
                    try {
                        if (continuation.isActive && !released.get()) media.prepareAsync()
                    } catch (failure: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(failure)
                    }
                }
                coroutine.ensureActive()
            } finally {
                // MediaPlayer retains its open data-source descriptor, not this path.
                file.delete()
            }
        }
    }

    override fun setLooping(looping: Boolean) {
        check(prepared && !released.get())
        media.isLooping = looping
    }

    override fun setVolume(volume: Float) {
        check(!released.get())
        media.setVolume(volume, volume)
    }

    override fun start() {
        check(prepared && !released.get())
        media.start()
        check(media.isPlaying) { "Sound playback did not start." }
        playing = true
    }

    override fun pause() {
        if (!released.get() && prepared && playing) {
            media.pause()
            playing = false
        }
    }

    override fun release() {
        if (released.compareAndSet(false, true)) {
            playing = false
            media.release()
        }
    }
}

/**
 * Original local six-second sound loops. Pure streaming PCM16/WAV encoding is
 * independently testable on the JVM. Memory is bounded to one 4096-byte block;
 * output is written in bulk rather than performing I/O for individual samples.
 */
object AmbientWavEncoder {
    const val SAMPLE_RATE = 22_050
    const val DURATION_SECONDS = 6
    const val SAMPLE_COUNT = SAMPLE_RATE * DURATION_SECONDS
    const val DATA_BYTES = SAMPLE_COUNT * 2

    fun encode(
        loop: SoundLoop,
        output: OutputStream,
        checkCancellation: () -> Unit = {}
    ) {
        require(loop != SoundLoop.NONE) { "Choose a local sound loop." }
        val header = ByteArray(44)
        fun text(offset: Int, value: String) {
            value.forEachIndexed { index, character -> header[offset + index] = character.code.toByte() }
        }
        fun little(offset: Int, value: Int, bytes: Int) {
            repeat(bytes) { header[offset + it] = (value ushr (it * 8)).toByte() }
        }
        text(0, "RIFF")
        little(4, 36 + DATA_BYTES, 4)
        text(8, "WAVE")
        text(12, "fmt ")
        little(16, 16, 4)
        little(20, 1, 2) // Linear PCM.
        little(22, 1, 2) // Mono.
        little(24, SAMPLE_RATE, 4)
        little(28, SAMPLE_RATE * 2, 4)
        little(32, 2, 2)
        little(34, 16, 2)
        text(36, "data")
        little(40, DATA_BYTES, 4)
        checkCancellation()
        output.write(header)

        val block = ByteArray(4096)
        val random = Random(1097 + loop.ordinal)
        var low = 0.0
        var breeze = 0.0
        var position = 0
        while (position < SAMPLE_COUNT) {
            checkCancellation()
            val count = minOf(block.size / 2, SAMPLE_COUNT - position)
            repeat(count) { offset ->
                val i = position + offset
                val t = i.toDouble() / SAMPLE_RATE
                val noise = random.nextDouble(-1.0, 1.0)
                low += 0.065 * (noise - low)
                breeze += 0.012 * (noise - breeze)
                val sample = when (loop) {
                    SoundLoop.RAIN -> noise * 0.16 + low * 0.48
                    SoundLoop.WIND -> breeze * (1.0 + 0.45 * sin(2.0 * PI * t / DURATION_SECONDS))
                    SoundLoop.FOREST -> {
                        val phase = (t % 2.0) / 0.42
                        val bird = if (phase < 1.0) {
                            val envelope = sin(PI * phase)
                            0.055 * envelope * envelope * sin(
                                2.0 * PI * (1450.0 * t + 65.0 * sin(2.0 * PI * 4.0 * t)))
                        } else 0.0
                        low * 0.26 + bird
                    }
                    SoundLoop.NONE -> 0.0
                }
                val edge = minOf(i, SAMPLE_COUNT - 1 - i).toDouble() / (SAMPLE_RATE * 0.06)
                val gain = if (edge < 1.0) (1.0 - cos(PI * edge)) * 0.5 else 1.0
                val pcm = (sample.coerceIn(-0.85, 0.85) * sqrt(gain) * 32767.0).toInt()
                block[offset * 2] = pcm.toByte()
                block[offset * 2 + 1] = (pcm shr 8).toByte()
            }
            output.write(block, 0, count * 2)
            position += count
        }
    }
}
