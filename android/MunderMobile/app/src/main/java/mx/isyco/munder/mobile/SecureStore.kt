package mx.isyco.munder.mobile

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * La llave de sesión vive en el Keystore cifrado, solo este aparato,
 * igual que el Keychain de iOS (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly).
 * El nombre y las direcciones de la oficina no son secreto y van en prefs normales.
 *
 * Espejo de Sources/Keychain.swift.
 */
class SecureStore(context: Context) {
    private val app = context.applicationContext

    private val masterKey = MasterKey.Builder(app)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val secret = EncryptedSharedPreferences.create(
        app,
        "munder_secret",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private val plain = app.getSharedPreferences("munder", Context.MODE_PRIVATE)

    fun saveSessionKey(raw: ByteArray) {
        secret.edit().putString(SESSION_KEY, raw.toB64u()).apply()
    }

    fun loadSessionKey(): ByteArray? =
        secret.getString(SESSION_KEY, null)?.fromB64u()

    fun deleteSessionKey() {
        secret.edit().remove(SESSION_KEY).apply()
    }

    fun saveOffice(json: String) {
        plain.edit().putString(OFFICE, json).apply()
    }

    fun loadOffice(): String? = plain.getString(OFFICE, null)

    fun savePendingCode(code: String) {
        plain.edit().putString(PENDING, code).apply()
    }

    fun loadPendingCode(): String? = plain.getString(PENDING, null)

    fun clearPendingCode() {
        plain.edit().remove(PENDING).apply()
    }

    fun clearOffice() {
        plain.edit().remove(OFFICE).remove(PENDING).apply()
    }

    private fun ByteArray.toB64u(): String =
        android.util.Base64.encodeToString(this, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)

    private fun String.fromB64u(): ByteArray? = try {
        var s = replace('-', '+').replace('_', '/')
        while (s.length % 4 != 0) s += "="
        android.util.Base64.decode(s, android.util.Base64.DEFAULT)
    } catch (e: Exception) {
        null
    }

    companion object {
        private const val SESSION_KEY = "session-key"
        private const val OFFICE = "munder.office"
        private const val PENDING = "munder.pendingCode"
    }
}
