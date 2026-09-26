package mx.isyco.munder.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import mx.isyco.munder.mobile.RemoteCrypto.fromB64u
import mx.isyco.munder.mobile.RemoteCrypto.toB64u

/**
 * Habla munder-remote@1 con una oficina emparejada.
 *
 * Espejo de Sources/RemoteClient.swift: la oficina se alcanza en varias
 * direcciones (su IP LAN en casa, su IP Tailscale desde fuera). Cada llamada
 * las prueba en orden, la que contestó última primero, y la ganadora sube al
 * frente. En casa la LAN contesta directo y fuera la LAN muerta cuesta un
 * timeout corto antes de que Tailscale conteste. `hello` entrega las direcciones
 * actuales, así que emparejar una vez en casa basta.
 */

val MunderJson = Json { ignoreUnknownKeys = true; isLenient = true }

class RemoteClient(
    var office: PairedOffice,
    private val key: ByteArray,
    private val http: OkHttpClient = makeSession(),
) {
    var onOfficeChanged: ((PairedOffice) -> Unit)? = null

    companion object {
        /** Timeouts cortos a propósito: la que no está (la LAN fuera de casa)
         *  debe fallar rápido para que la siguiente tenga su turno. */
        fun makeSession(timeoutSec: Double = 3.5): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout((timeoutSec * 1000).toLong(), TimeUnit.MILLISECONDS)
                .readTimeout((timeoutSec * 3 * 1000).toLong(), TimeUnit.MILLISECONDS)
                .writeTimeout((timeoutSec * 3 * 1000).toLong(), TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(false)
                .build()

        fun pairingSession(): OkHttpClient = makeSession(8.0)
    }

    suspend fun callRaw(op: String, args: Map<String, Any?> = emptyMap()): String {
        var lastError: Exception = RemoteError.Unreachable("no hay direcciones guardadas")
        for (address in office.addresses.toList()) {
            val iv = RemoteCrypto.randomBytes(12)
            val payload = buildJsonObject {
                put("ts", System.currentTimeMillis())
                put("op", op)
                put("args", Json.encodeToString(argsToJson(args)))
            }.toString().toByteArray(Charsets.UTF_8)
            val ct: ByteArray
            try {
                ct = RemoteCrypto.seal(payload, key, iv, "req", office.deviceId, office.officeId)
            } catch (e: Exception) {
                throw RemoteError.BadReply()
            }
            val envelope = """{"v":1,"dev":"${office.deviceId}","iv":"${iv.toB64u()}","ct":"${ct.toB64u()}"}"""

            val (status, body) = try {
                post(address, "/remote/v1/call", envelope)
            } catch (e: Exception) {
                lastError = RemoteError.Unreachable(describe(e))
                continue // esta dirección no está ahorita: a la siguiente
            }
            promote(address)

            val obj = try {
                MunderJson.parseToJsonElement(body) as? JsonObject ?: JsonObject(emptyMap())
            } catch (e: Exception) {
                JsonObject(emptyMap())
            }
            if (status != 200) {
                val code = obj["code"]?.toString()?.trim('"') ?: "http_$status"
                val msg = obj["error"]?.toString()?.trim('"') ?: "HTTP $status"
                throw RemoteError.Http(status, code, msg)
            }
            val rivText = obj["iv"]?.toString()?.trim('"')
            val rctText = obj["ct"]?.toString()?.trim('"')
            val riv = rivText?.fromB64u()
            val rct = rctText?.fromB64u()
            if (riv == null || rct == null) throw RemoteError.BadReply()
            val opened: ByteArray
            try {
                opened = RemoteCrypto.open(rct, key, riv, "res", office.deviceId, office.officeId)
            } catch (e: RemoteError) {
                throw e
            }
            val msg = try {
                MunderJson.parseToJsonElement(opened.toString(Charsets.UTF_8)) as? JsonObject
                    ?: throw RemoteError.BadReply()
            } catch (e: RemoteError) {
                throw e
            } catch (e: Exception) {
                throw RemoteError.BadReply()
            }
            // `re` amarra la respuesta a ESTA petición: una grabada no se reusa como otra.
            if (msg["re"]?.toString()?.trim('"') != iv.toB64u()) throw RemoteError.BadReply()
            val ok = msg["ok"]?.toString() == "true"
            if (!ok) {
                val code = msg["code"]?.toString()?.trim('"') ?: "error"
                val emsg = msg["error"]?.toString()?.trim('"') ?: "error"
                throw RemoteError.Remote(code, emsg)
            }
            return msg["result"]?.toString() ?: "null"
        }
        throw lastError
    }

    suspend inline fun <reified T> call(op: String, args: Map<String, Any?> = emptyMap()): T {
        val raw = callRaw(op, args)
        return MunderJson.decodeFromString(raw)
    }

    /** Adopta la lista de la oficina: la que funciona primero se queda, se suma el resto. */
    fun learn(addresses: List<OfficeAddress>) {
        var changed = false
        for (a in addresses) {
            if (office.addresses.size >= 8) break
            val norm = Address.normalize(a.address) ?: continue
            if (!office.addresses.contains(norm)) {
                office.addresses.add(norm)
                changed = true
            }
            if (office.via[norm] == null) {
                office.via[norm] = a.via ?: (if (Address.looksTailscale(norm)) "tailscale" else "lan")
                changed = true
            }
        }
        if (changed) onOfficeChanged?.invoke(office)
    }

    fun add(address: String, via: String) {
        if (office.addresses.contains(address)) return
        office.addresses.add(0, address)
        office.via[address] = via
        onOfficeChanged?.invoke(office)
    }

    fun remove(address: String) {
        office.addresses.remove(address)
        office.via.remove(address)
        onOfficeChanged?.invoke(office)
    }

    private fun promote(address: String) {
        if (office.addresses.firstOrNull() == address) return
        val i = office.addresses.indexOf(address)
        if (i < 0) return
        office.addresses.removeAt(i)
        office.addresses.add(0, address)
        onOfficeChanged?.invoke(office)
    }

    // ── emparejar (JSON plano: nada se confía hasta que un humano acepta el código) ──

    data class PairingResult(val office: PairedOffice, val key: ByteArray, val code: String)

    // ── HTTP ──

    private suspend fun post(address: String, path: String, json: String): Pair<Int, String> {
        // Bloqueante por diseño de OkHttp: fuera del hilo principal, como el
        // URLSession en segundo plano de iOS. Sin esto, Android mata la llamada
        // con NetworkOnMainThreadException en el móvil real (en demo no se nota
        // porque no hay red).
        return withContext(Dispatchers.IO) {
            val url = "http://$address$path"
            val req = Request.Builder()
                .url(url)
                .post(json.toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(req).execute().use { res ->
                Pair(res.code, res.body?.string() ?: "")
            }
        }
    }

    private fun argsToJson(args: Map<String, Any?>): JsonObject = buildJsonObject {
        for ((k, v) in args) {
            when (v) {
                null -> put(k, "")
                is String -> put(k, v)
                is Number -> put(k, v.toLong())
                is Boolean -> put(k, v)
                // panel.action manda {"action": nombre, "args": {k: texto}}: el objeto
                // anidado viaja como objeto, igual que en Swift y en la PWA.
                is Map<*, *> -> put(k, mapToJson(v))
                else -> put(k, v.toString())
            }
        }
    }

    private fun mapToJson(m: Map<*, *>): JsonObject = buildJsonObject {
        for ((k, v) in m) {
            val key = k.toString()
            when (v) {
                null -> put(key, "")
                is String -> put(key, v)
                is Number -> put(key, v.toLong())
                is Boolean -> put(key, v)
                else -> put(key, v.toString())
            }
        }
    }

    private fun describe(e: Exception): String {
        val m = e.message ?: ""
        return when {
            "timeout" in m.lowercase() || "timed out" in m.lowercase() -> "no contesta"
            "refused" in m.lowercase() -> "conexión rechazada"
            "unable to resolve" in m.lowercase() -> "no encuentro ese nombre"
            else -> m.ifEmpty { "sin red" }
        }
    }
}

/** Emparejar fuera de la clase para poder usar otro OkHttp con timeout de 8 s. */
suspend fun pairOffice(address: String, deviceName: String, http: OkHttpClient = RemoteClient.pairingSession()): RemoteClient.PairingResult {
    suspend fun post(address: String, path: String, json: String): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("http://$address$path")
                .post(json.toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(req).execute().use { res ->
                Pair(res.code, res.body?.string() ?: "")
            }
        }
    fun check(reply: Pair<Int, String>): JsonObject {
        val obj = try {
            MunderJson.parseToJsonElement(reply.second) as? JsonObject ?: JsonObject(emptyMap())
        } catch (e: Exception) {
            JsonObject(emptyMap())
        }
        if (reply.first != 200) {
            val code = obj["code"]?.toString()?.trim('"') ?: "http_${reply.first}"
            val msg = obj["error"]?.toString()?.trim('"') ?: "HTTP ${reply.first}"
            throw RemoteError.Http(reply.first, code, msg)
        }
        return obj
    }

    val kp = RemoteCrypto.generateKeyPair()
    val nonce = RemoteCrypto.randomBytes(16)
    val deviceId = RemoteCrypto.deviceId(kp.publicRaw)

    // 1) commit: solo el hash del nonce sale antes de ver el de la oficina
    val first = try {
        post(address, "/remote/v1/pair",
            """{"name":${Json.encodeToString(deviceName)},"pub":"${kp.publicRaw.toB64u()}","commit":"${RemoteCrypto.commit(nonce)}"}""")
    } catch (e: RemoteError) {
        throw e
    } catch (e: Exception) {
        throw RemoteError.Unreachable(e.message ?: "sin red")
    }
    val o = check(first)
    if (o["protocol"]?.toString()?.trim('"') != RemoteCrypto.PROTOCOL) throw RemoteError.BadOffice()
    if (o["device_id"]?.toString()?.trim('"') != deviceId) throw RemoteError.BadOffice()
    val boxPub = o["box_pub"]?.toString()?.trim('"') ?: throw RemoteError.BadOffice()
    val officeId = o["office_id"]?.toString()?.trim('"') ?: throw RemoteError.BadOffice()
    val officeNonce = o["nonce"]?.toString()?.trim('"') ?: throw RemoteError.BadOffice()

    // 2) reveal
    val second = try {
        post(address, "/remote/v1/reveal",
            """{"device_id":"$deviceId","nonce":"${nonce.toB64u()}"}""")
    } catch (e: RemoteError) {
        throw e
    } catch (e: Exception) {
        throw RemoteError.Unreachable(e.message ?: "sin red")
    }
    check(second)

    val key = try {
        RemoteCrypto.sessionKey(kp.privateRaw, boxPub, officeId, deviceId)
    } catch (e: RemoteError) {
        throw e
    } catch (e: Exception) {
        throw RemoteError.BadOffice()
    }
    val code = RemoteCrypto.sas(boxPub, kp.publicRaw.toB64u(), officeNonce, nonce.toB64u())
    val office = PairedOffice(
        officeId = officeId,
        name = o["name"]?.toString()?.trim('"') ?: "oficina",
        boxPub = boxPub,
        deviceId = deviceId,
        deviceName = deviceName,
        addresses = mutableListOf(address),
        via = mutableMapOf(address to if (Address.looksTailscale(address)) "tailscale" else "lan"),
    )
    return RemoteClient.PairingResult(office, key, code)
}
