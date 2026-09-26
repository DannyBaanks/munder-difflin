package mx.isyco.munder.mobile

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * El Swift produce los mismos bytes que la oficina: el Kotlin también.
 * Vectores calculados por tools/munder/lib-remote.cjs
 * (ios/MunderMobile/scripts/make-assets.cjs), copiados a test/resources.
 *
 * OJO: sin org.json aquí — en tests JVM locales las clases de Android
 * (android.jar) no están simuladas y lanzan "not mocked". Solo
 * kotlinx.serialization + JUnit puro.
 */
class RemoteCryptoTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun vectors(): JsonObject {
        val candidates = listOf(
            File("app/src/test/resources/vectors.json"),
            File("src/test/resources/vectors.json"),
            File(System.getProperty("user.dir") + "/app/src/test/resources/vectors.json"),
        )
        val f = candidates.firstOrNull { it.exists() }
            ?: throw AssertionError("vectors.json no encontrado (probé: ${candidates.joinToString()})")
        return json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun JsonObject.str(key: String): String = this[key]!!.jsonPrimitive.content

    @Test
    fun deviceId_matchesNode() {
        val v = vectors()
        val pub = v.str("device_pub").fromB64uJvm()
        assertEquals(v.str("device_id"), RemoteCryptoJvm.deviceId(pub))
    }

    @Test
    fun commit_matchesNode() {
        val v = vectors()
        val deviceNonce = v.str("device_nonce").fromB64uJvm()
        assertEquals(v.str("commit"), RemoteCryptoJvm.commit(deviceNonce))
    }

    @Test
    fun sas_matchesNode() {
        val v = vectors()
        assertEquals(
            v.str("sas"),
            RemoteCryptoJvm.sas(
                v.str("office_box_pub"),
                v.str("device_pub"),
                v.str("office_nonce"),
                v.str("device_nonce"),
            ),
        )
    }

    @Test
    fun sessionKey_matchesNode() {
        val v = vectors()
        val priv = v.str("device_priv").fromB64uJvm()
        val key = RemoteCryptoJvm.sessionKey(priv, v.str("office_box_pub"), v.str("office_id"), v.str("device_id"))
        assertArrayEquals(v.str("session_key").fromB64uJvm(), key)
    }

    @Test
    fun sealOpen_roundTrip_matchesNodeVectors() {
        val v = vectors()
        val key = v.str("session_key").fromB64uJvm()
        val deviceId = v.str("device_id")
        val officeId = v.str("office_id")

        val req = v["request"]!!.jsonObject
        val reqIv = req.str("iv").fromB64uJvm()
        val reqCt = req.str("ct").fromB64uJvm()
        // El sobre de Node se abre con la misma llave e IV.
        assertEquals(req.str("plaintext"), RemoteCryptoJvm.open(reqCt, key, reqIv, "req", deviceId, officeId).toString(Charsets.UTF_8))
        // Y lo que sella Kotlin lo abre Node (mismo AAD, mismo formato ct‖tag).
        val sealed = RemoteCryptoJvm.seal(req.str("plaintext").toByteArray(Charsets.UTF_8), key, reqIv, "req", deviceId, officeId)
        assertArrayEquals(reqCt, sealed)

        val res = v["response"]!!.jsonObject
        val resIv = res.str("iv").fromB64uJvm()
        val resCt = res.str("ct").fromB64uJvm()
        assertEquals(res.str("plaintext"), RemoteCryptoJvm.open(resCt, key, resIv, "res", deviceId, officeId).toString(Charsets.UTF_8))
    }
}
