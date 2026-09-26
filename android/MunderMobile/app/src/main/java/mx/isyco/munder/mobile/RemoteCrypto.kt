package mx.isyco.munder.mobile

import android.util.Base64
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters

/**
 * munder-remote@1, el mismo cable que habla la oficina (tools/munder/lib-remote.cjs)
 * y que habla iOS (Sources/RemoteCrypto.swift).
 *
 * Puerto línea por línea del Swift con CryptoKit a BouncyCastle puro-Java:
 * X25519, HKDF-SHA256, ChaCha20-Poly1305, SHA-256.
 * Tests/vectors.json lo calcula el Node de la oficina; el test Android debe
 * dar los mismos bytes que el test Swift.
 */
object RemoteCrypto {
    const val PROTOCOL = "munder-remote@1"

    private val rng = SecureRandom()

    fun randomBytes(count: Int): ByteArray = ByteArray(count).also { rng.nextBytes(it) }

    /** Primeros 8 bytes de SHA-256(llave pública X25519 cruda), 16 hex. */
    fun deviceId(publicKeyRaw: ByteArray): String {
        val h = MessageDigest.getInstance("SHA-256").digest(publicKeyRaw)
        return h.take(8).joinToString("") { "%02x".format(it) }
    }

    /** Los 6 dígitos que muestran las dos pantallas. El nonce del móvil se comprometió antes. */
    fun sas(officeBoxPub: String, devicePub: String, officeNonce: String, deviceNonce: String): String {
        val text = "$PROTOCOL|sas|$officeBoxPub|$devicePub|$officeNonce|$deviceNonce"
        val h = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        val n = ByteBuffer.wrap(h, 0, 4).int.toLong() and 0xFFFFFFFFL
        return "%06d".format((n % 1_000_000L).toInt())
    }

    /** Lo primero que manda el móvil: el hash de su nonce, nunca el nonce. */
    fun commit(nonce: ByteArray): String {
        val h = MessageDigest.getInstance("SHA-256").digest(nonce)
        return h.toB64u()
    }

    data class KeyPair(val privateRaw: ByteArray, val publicRaw: ByteArray)

    fun generateKeyPair(): KeyPair {
        val priv = X25519PrivateKeyParameters(rng)
        val pub = X25519PublicKeyParameters(priv.encoded, 0)
        return KeyPair(priv.encoded, pub.encoded)
    }

    fun publicOf(privateRaw: ByteArray): ByteArray {
        val priv = X25519PrivateKeyParameters(privateRaw, 0)
        return X25519PublicKeyParameters(priv.encoded, 0).encoded
    }

    /** Llave de sesión: X25519 + HKDF-SHA256(salt="office|device", info="munder-remote@1 key"). */
    fun sessionKey(devicePrivateRaw: ByteArray, officeBoxPubB64u: String, officeId: String, deviceId: String): ByteArray {
        val officeRaw = officeBoxPubB64u.fromB64u()
            ?: throw RemoteError.BadOffice()
        require(officeRaw.size == 32) { "llave de oficina inválida" }
        val priv = X25519PrivateKeyParameters(devicePrivateRaw, 0)
        val pub = X25519PublicKeyParameters(officeRaw, 0)
        val secret = ByteArray(32)
        // BouncyCastle ≥1.72: el acuerdo se calcula con agreement.calculateAgreement.
        val agreement = org.bouncycastle.crypto.agreement.X25519Agreement()
        agreement.init(priv)
        agreement.calculateAgreement(pub, secret, 0)
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(
            HKDFParameters(
                secret,
                "$officeId|$deviceId".toByteArray(Charsets.UTF_8),
                "$PROTOCOL key".toByteArray(Charsets.UTF_8),
            )
        )
        val out = ByteArray(32)
        hkdf.generateBytes(out, 0, 32)
        return out
    }

    fun aad(direction: String, deviceId: String, officeId: String): ByteArray =
        "$PROTOCOL|$direction|$deviceId|$officeId".toByteArray(Charsets.UTF_8)

    /** ciphertext ‖ tag de 16, exactamente lo que produce Node chacha20-poly1305. */
    fun seal(plaintext: ByteArray, key: ByteArray, iv: ByteArray, direction: String, deviceId: String, officeId: String): ByteArray {
        val aead = ChaCha20Poly1305()
        aead.init(true, AEADParameters(KeyParameter(key), 128, iv, aad(direction, deviceId, officeId)))
        val out = ByteArray(aead.getOutputSize(plaintext.size))
        var off = aead.processBytes(plaintext, 0, plaintext.size, out, 0)
        off += aead.doFinal(out, off)
        return out.copyOf(off)
    }

    fun open(sealed: ByteArray, key: ByteArray, iv: ByteArray, direction: String, deviceId: String, officeId: String): ByteArray {
        if (sealed.size < 16) throw RemoteError.BadReply()
        val aead = ChaCha20Poly1305()
        aead.init(false, AEADParameters(KeyParameter(key), 128, iv, aad(direction, deviceId, officeId)))
        val out = ByteArray(aead.getOutputSize(sealed.size))
        return try {
            var off = aead.processBytes(sealed, 0, sealed.size, out, 0)
            off += aead.doFinal(out, off)
            out.copyOf(off)
        } catch (e: Exception) {
            throw RemoteError.BadReply()
        }
    }

    // ── base64url sin relleno, igual que Node Buffer.toString('base64url') ──

    fun ByteArray.toB64u(): String =
        Base64.encodeToString(this, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    fun String.fromB64u(): ByteArray? = try {
        var s = this.replace('-', '+').replace('_', '/')
        while (s.length % 4 != 0) s += "="
        Base64.decode(s, Base64.DEFAULT)
    } catch (e: Exception) {
        null
    }
}

/** Mismos códigos que RemoteError en Swift: la UI los traduce igual. */
sealed class RemoteError(message: String) : Exception(message) {
    open val code: String = "error"
    class Http(val status: Int, override val code: String, msg: String) : RemoteError(msg)
    class Remote(override val code: String, msg: String) : RemoteError(msg)
    class BadReply : RemoteError("La respuesta de la oficina no corresponde a esta llamada.") {
        override val code = "bad_reply"
    }
    class BadOffice : RemoteError("Esa no parece una oficina Munder.") {
        override val code = "bad_office"
    }
    class Unreachable(why: String) : RemoteError("No alcanzo la oficina ($why). ¿Está encendido el enlace y estás en tu red o en Tailscale?") {
        override val code = "unreachable"
    }
    class NotPaired : RemoteError("Este celular no está emparejado.") {
        override val code = "not_paired"
    }
}
