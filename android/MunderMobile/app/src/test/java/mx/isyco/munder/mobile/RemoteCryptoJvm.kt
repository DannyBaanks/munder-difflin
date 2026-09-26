package mx.isyco.munder.mobile

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Base64

/**
 * La misma matemática que RemoteCrypto.kt pero sin android.util.Base64,
 * para que el test unitario JVM corra sin Robolectric.
 * Si esta copia y el .kt real divergen, el test de vectores lo grita.
 */
object RemoteCryptoJvm {
    const val PROTOCOL = "munder-remote@1"

    fun ByteArray.toB64u(): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(this)

    fun String.fromB64uJvm(): ByteArray {
        var s = replace('-', '+').replace('_', '/')
        while (s.length % 4 != 0) s += "="
        return Base64.getDecoder().decode(s)
    }

    fun deviceId(pubRaw: ByteArray): String {
        val h = MessageDigest.getInstance("SHA-256").digest(pubRaw)
        return h.take(8).joinToString("") { "%02x".format(it) }
    }

    fun sas(officeBoxPub: String, devicePub: String, officeNonce: String, deviceNonce: String): String {
        val text = "$PROTOCOL|sas|$officeBoxPub|$devicePub|$officeNonce|$deviceNonce"
        val h = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        val n = ByteBuffer.wrap(h, 0, 4).int.toLong() and 0xFFFFFFFFL
        return "%06d".format((n % 1_000_000L).toInt())
    }

    fun commit(nonce: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(nonce).toB64u()

    fun sessionKey(devicePrivRaw: ByteArray, officeBoxPubB64u: String, officeId: String, deviceId: String): ByteArray {
        val officeRaw = officeBoxPubB64u.fromB64uJvm()
        require(officeRaw.size == 32)
        val priv = X25519PrivateKeyParameters(devicePrivRaw, 0)
        val pub = X25519PublicKeyParameters(officeRaw, 0)
        val agreement = org.bouncycastle.crypto.agreement.X25519Agreement()
        agreement.init(priv)
        val secret = ByteArray(32)
        agreement.calculateAgreement(pub, secret, 0)
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(secret, "$officeId|$deviceId".toByteArray(), "$PROTOCOL key".toByteArray()))
        return ByteArray(32).also { hkdf.generateBytes(it, 0, 32) }
    }

    private fun aad(dir: String, deviceId: String, officeId: String) =
        "$PROTOCOL|$dir|$deviceId|$officeId".toByteArray()

    fun seal(pt: ByteArray, key: ByteArray, iv: ByteArray, dir: String, deviceId: String, officeId: String): ByteArray {
        val aead = ChaCha20Poly1305()
        aead.init(true, AEADParameters(KeyParameter(key), 128, iv, aad(dir, deviceId, officeId)))
        val out = ByteArray(aead.getOutputSize(pt.size))
        var off = aead.processBytes(pt, 0, pt.size, out, 0)
        off += aead.doFinal(out, off)
        return out.copyOf(off)
    }

    fun open(sealed: ByteArray, key: ByteArray, iv: ByteArray, dir: String, deviceId: String, officeId: String): ByteArray {
        val aead = ChaCha20Poly1305()
        aead.init(false, AEADParameters(KeyParameter(key), 128, iv, aad(dir, deviceId, officeId)))
        val out = ByteArray(aead.getOutputSize(sealed.size))
        var off = aead.processBytes(sealed, 0, sealed.size, out, 0)
        off += aead.doFinal(out, off)
        return out.copyOf(off)
    }
}

fun String.fromB64uJvm(): ByteArray = RemoteCryptoJvm.run { fromB64uJvm() }
