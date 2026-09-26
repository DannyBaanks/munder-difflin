package mx.isyco.munder.mobile

import android.content.Context
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Date
import kotlin.coroutines.resume

/**
 * Quien tenga este móvil desbloqueado no debe poder ver ni manejar la oficina.
 *
 * Dos puertas, las mismas que AppLock.swift:
 *   1. Ver. La app abre bloqueada y se vuelve a bloquear al volver tras
 *      `relockAfter` en segundo plano. Nada de la oficina en pantalla bloqueada.
 *   2. Actuar. Cada acción que cambia algo (hablarle a Michael, responder,
 *      delegar, tocar direcciones, olvidar) pide de nuevo, salvo que el dueño
 *      se comprobó en los últimos `actionWindow` segundos.
 *
 * Munder jamás ve la biometría ni el PIN: Android contesta sí o no.
 */

enum class SensitiveAction {
    ASK, ANSWER, DELEGATE, ADD_ADDRESS, REMOVE_ADDRESS, FORGET, PANEL;

    val reason: String get() = when (this) {
        ASK -> "Confirma que eres tú para mandarle algo a tu oficina"
        ANSWER -> "Confirma que eres tú para responder en tu oficina"
        DELEGATE -> "Confirma que eres tú para delegar a otra oficina"
        ADD_ADDRESS -> "Confirma que eres tú para agregar una dirección"
        REMOVE_ADDRESS -> "Confirma que eres tú para quitar una dirección"
        FORGET -> "Confirma que eres tú para olvidar esta oficina"
        PANEL -> "Confirma que eres tú para manejar la computadora"
    }
}

/** Reglas de tiempo, puras para poder manejar el reloj en tests. */
data class LockPolicy(
    val relockAfterSec: Long = 60,
    val actionWindowSec: Long = 30,
) {
    fun mustRelock(backgroundedAt: Date?, now: Date): Boolean {
        if (backgroundedAt == null) return false
        return (now.time - backgroundedAt.time) / 1000 >= relockAfterSec
    }

    fun actionNeedsAuth(lastAuth: Date?, now: Date): Boolean {
        if (lastAuth == null) return true
        val age = (now.time - lastAuth.time) / 1000
        return age < 0 || age >= actionWindowSec
    }
}

class AppLock(
    val enabled: Boolean = true,
    private val policy: LockPolicy = LockPolicy(),
    private val now: () -> Date = { Date() },
) {
    var locked: Boolean = enabled
        private set
    /** El móvil no tiene PIN: Munder no se puede proteger y lo dice. */
    var unprotected: Boolean = false
        private set
    var checking: Boolean = false
        private set

    private var lastAuth: Date? = null
    private var backgroundedAt: Date? = null

    fun hasOwnerCheck(context: Context): Boolean {
        val mgr = BiometricManager.from(context)
        return mgr.canAuthenticate(BiometricManager.Authenticators.DEVICE_CREDENTIAL) ==
            BiometricManager.BIOMETRIC_SUCCESS
    }

    suspend fun unlock(activity: FragmentActivity): Boolean {
        if (!enabled || !locked || checking) return !locked
        checking = true
        try {
            when (authenticate(activity, "Desbloquea Munder para ver tu oficina")) {
                true -> {
                    lastAuth = now()
                    unprotected = false
                    locked = false
                }
                false -> {
                    // Sin PIN en el móvil: no hay dueño a quien preguntar. Abre, pero avisa.
                    if (!hasOwnerCheck(activity)) {
                        unprotected = true
                        locked = false
                    }
                }
            }
        } finally {
            checking = false
        }
        return !locked
    }

    fun didEnterBackground() {
        if (!enabled) return
        backgroundedAt = now()
    }

    /** De vuelta al frente. True cuando sí estuvo fuera y sigue bloqueada. */
    fun willEnterForeground(): Boolean {
        if (!enabled) return false
        val wasAway = backgroundedAt != null
        if (policy.mustRelock(backgroundedAt, now())) locked = true
        backgroundedAt = null
        return wasAway && locked
    }

    /** Puerta de una acción que cambia la oficina. True = adelante. */
    suspend fun authorize(activity: FragmentActivity?, action: SensitiveAction): Boolean {
        if (!enabled) return true
        if (locked) return false
        if (unprotected) return true
        if (!policy.actionNeedsAuth(lastAuth, now())) return true
        if (activity == null) return false
        return if (authenticate(activity, action.reason)) {
            lastAuth = now()
            true
        } else {
            if (!hasOwnerCheck(activity)) {
                unprotected = true
                true
            } else false
        }
    }

    /** Solo para demo/tests: abre sin biometría. */
    fun unlockForDemo() {
        locked = false
    }

    fun lockNow() {
        if (enabled) locked = true
    }

    private suspend fun authenticate(activity: FragmentActivity, reason: String): Boolean =
        suspendCancellableCoroutine { cont ->
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(true)
                    }
                    override fun onAuthenticationFailed() { /* sigue intentando */ }
                    override fun onAuthenticationError(code: Int, msg: CharSequence) {
                        if (cont.isActive) cont.resume(false)
                    }
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Munder")
                .setSubtitle(reason)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build()
            try {
                prompt.authenticate(info)
            } catch (e: Exception) {
                if (cont.isActive) cont.resume(false)
            }
        }
}
