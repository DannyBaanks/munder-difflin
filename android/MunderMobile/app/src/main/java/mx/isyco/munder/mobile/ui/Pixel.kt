package mx.isyco.munder.mobile.ui

import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.Normalizer
import mx.isyco.munder.mobile.Agent
import mx.isyco.munder.mobile.R
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * El look de la app, de src/renderer/src/design/tokens.css: los colores --cth
 * en claro y oscuro, Press Start 2P para etiquetas en versalitas, esquinas
 * cuadradas, líneas de 1 px, sombra dura y los retratos pixel del elenco
 * (generados por avatar-engine.cjs vía scripts/make-assets.cjs).
 *
 * Espejo de App/Pixel.swift.
 */

object Px {
    @Composable fun cream50() = dyn(0xFFFDF5, 0x17171B)
    @Composable fun cream100() = dyn(0xFFF8E7, 0x1D1D22)
    @Composable fun cream200() = dyn(0xF4E9C7, 0x26262C)
    @Composable fun cream300() = dyn(0xE8D9A0, 0x313139)
    @Composable fun paper100() = dyn(0xFCFAF0, 0x1A1A1F)
    @Composable fun ink900() = dyn(0x1A1320, 0xDEDBD6)
    @Composable fun ink700() = dyn(0x3D2E4A, 0xB3B0AC)
    @Composable fun ink500() = dyn(0x6B5878, 0x96919F)
    @Composable fun ink300() = dyn(0xA899B5, 0x787684)
    @Composable fun ink100() = dyn(0xD9CFE0, 0x3E3D46)
    @Composable fun coral() = dyn(0xD96A62, 0xE08C82)
    @Composable fun coralLight() = dyn(0xF3D3CD, 0x3B2724)
    @Composable fun mint() = dyn(0x5CA97A, 0x74C096)
    @Composable fun lemon() = dyn(0xDCAB3C, 0xCFAA57)
    @Composable fun lemonLight() = dyn(0xF3E4BC, 0x332C1D)
    @Composable fun sky() = dyn(0x4F9FAF, 0x6FB3C4)
    @Composable fun idle() = dyn(0xA199AB, 0x6F6C77)
    val onAccent = Color(0xFF1A1320)
    @Composable fun shadow() =
        if (isSystemInDarkTheme()) Color.Black.copy(alpha = 0.45f)
        else Color(0xFF1A1320).copy(alpha = 0.14f)

    @Composable
    private fun dyn(light: Long, dark: Long) =
        if (isSystemInDarkTheme()) Color(dark or 0xFF000000) else Color(light or 0xFF000000)
}

val PixelFont: FontFamily = try {
    FontFamily(Font(R.font.press_start_2p))
} catch (e: Exception) {
    FontFamily.Monospace
}

/** Press Start 2P no trae mayúsculas acentuadas: las etiquetas pierden el acento, el cuerpo lo guarda. */
fun pixelCaps(s: String): String {
    val flat = Normalizer.normalize(s, Normalizer.Form.NFD).replace("\\p{Mn}+".toRegex(), "")
    return flat.uppercase()
}

@Composable
fun PixelLabel(text: String, sizeSp: Int = 8, color: Color = Px.ink500()) {
    Text(
        text = pixelCaps(text),
        fontFamily = PixelFont,
        fontSize = sizeSp.sp,
        lineHeight = (sizeSp + sizeSp / 2).sp,
        color = color,
    )
}

@Composable
fun PixelCard(
    fill: Color = Px.paper100(),
    border: Color = Px.ink300(),
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .background(Px.shadow())
            .padding(start = 0.dp, top = 0.dp, end = 3.dp, bottom = 3.dp),
    ) {
        Box(
            modifier = Modifier
                .background(fill)
                .border(1.dp, border, RectangleShape)
                .padding(14.dp),
        ) { content() }
    }
}

enum class PixelKind { PRIMARY, GHOST, DANGER }

@Composable
fun PixelButton(
    text: String,
    kind: PixelKind = PixelKind.PRIMARY,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val dark = isSystemInDarkTheme()
    val fill = when {
        !enabled -> Px.cream300()
        kind == PixelKind.PRIMARY -> Px.ink900()
        kind == PixelKind.DANGER -> Px.coral()
        else -> Px.cream100()
    }
    val fg = when {
        !enabled -> Px.ink500()
        kind == PixelKind.PRIMARY -> Px.cream50()
        kind == PixelKind.DANGER -> Px.onAccent
        else -> Px.ink900()
    }
    val border = if (kind == PixelKind.PRIMARY) Px.ink900() else Px.ink300()
    Box(
        modifier = Modifier
            .background(if (kind == PixelKind.PRIMARY) Px.ink500() else Px.ink100())
            .padding(start = 0.dp, top = 0.dp, end = 0.dp, bottom = 2.dp),
    ) {
        Box(
            modifier = Modifier
                .background(if (enabled) fill else fill)
                .border(1.dp, border)
                .clickable(enabled = enabled) { onClick() }
                .padding(vertical = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = fg)
        }
    }
}

@Composable
fun Modifier.pixelField(): Modifier =
    this.background(Px.paper100()).border(1.dp, Px.ink300())

@Composable
fun PixelTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String = "",
    singleLine: Boolean = true,
) {
    Box(modifier = Modifier.pixelField().padding(10.dp)) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = singleLine,
            textStyle = TextStyle(color = Px.ink900(), fontSize = 14.sp),
            decorationBox = { inner ->
                if (value.isEmpty()) Text(placeholder, color = Px.ink300(), fontSize = 14.sp)
                inner()
            },
        )
    }
}

@Composable
fun PixelEditor(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String = "",
) {
    Box(modifier = Modifier.pixelField().padding(10.dp).heightIn(min = 84.dp)) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = TextStyle(color = Px.ink900(), fontSize = 14.sp),
            decorationBox = { inner ->
                if (value.isEmpty()) Text(placeholder, color = Px.ink300(), fontSize = 14.sp)
                inner()
            },
        )
    }
}

@Composable
fun StatusDot(color: Color) {
    Box(modifier = Modifier.size(8.dp).background(color))
}

@Composable
fun Chip(text: String, fill: Color = Px.cream200(), dot: Color? = null) {
    Row(
        modifier = Modifier.background(fill).border(1.dp, Px.ink100()).padding(horizontal = 6.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot != null) {
            StatusDot(dot)
            androidx.compose.foundation.layout.Spacer(modifier = Modifier.size(6.dp))
        }
        PixelLabel(text, sizeSp = 7, color = Px.ink700())
    }
}

@Composable
fun Bubble(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier.background(Px.cream50()).border(2.dp, Px.ink900()).padding(12.dp),
    ) { content() }
}

// ── el elenco ──

object Cast {
    /** Misma regla que la PWA: el jefe es Michael, si no el nombre o id, si no un fijo estable. */
    fun of(id: String, name: String, god: Boolean, names: List<String>): String {
        if (god) return "michael"
        for (raw in listOf(name, id)) {
            var key = raw.lowercase()
            if (key.startsWith("worker-")) key = key.removePrefix("worker-")
            key = key.takeWhile { it.isLetter() && it in 'a'..'z' }
            if (names.contains(key)) return key
        }
        val pool = names.filter { it != "michael" }
        if (pool.isEmpty()) return "michael"
        var h = 0L
        for (ch in id) h = (h * 31 + ch.code) and 0xFFFFFFFFL
        return pool[(h % pool.size).toInt()]
    }

    fun of(agent: Agent?, names: List<String>): String {
        if (agent == null) return "michael"
        return of(agent.id, agent.name, agent.god == true, names)
    }

    fun forAssignee(id: String?, agents: List<Agent>?, names: List<String>): String {
        if (id == null) return "michael"
        val a = agents?.firstOrNull { it.id == id || it.name.lowercase() == id.lowercase() }
        if (a != null) return of(a, names)
        return of(id, id, false, names)
    }
}

@Composable
fun rememberCastNames(): List<String> {
    val ctx = LocalContext.current
    return remember {
        try {
            ctx.assets.list("Media/Cast")?.map { it.removeSuffix(".png") }?.sorted() ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }
}

@Composable
fun Portrait(name: String, scale: Float = 2f) {
    val ctx = LocalContext.current
    val bmp = remember(name) {
        try {
            ctx.assets.open("Media/Cast/$name.png").use { BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            null
        }
    }
    val w = (18 * scale).dp
    val h = (28 * scale).dp
    if (bmp != null) {
        Image(
            painter = BitmapPainter(bmp.asImageBitmap()),
            contentDescription = name,
            modifier = Modifier.size(w, h).background(Px.cream200()).border(1.dp, Px.ink100()),
            contentScale = ContentScale.FillBounds,
        )
    } else {
        Box(modifier = Modifier.size(w, h).background(Px.cream200()).border(1.dp, Px.ink100()))
    }
}

// ── iconos pixel 12×12, mismas cuadrículas que la PWA ──

object PixelIcon {
    val office = listOf("....####....", "...#....#...", "..#......#..", ".#........#.", "############", "#..........#", "#.##....##.#", "#.##....##.#", "#..........#", "#....##....#", "#....##....#", "############")
    val ask = listOf("...######...", "..##....##..", "..##....##..", "........##..", ".......##...", "......##....", ".....##.....", ".....##.....", "............", ".....##.....", ".....##.....", "............")
    val board = listOf("############", "#..........#", "#.##.##.##.#", "#.##.##.##.#", "#..........#", "#.##.##....#", "#.##.##....#", "#..........#", "############", ".#........#.", ".#........#.", "............")
    val link = listOf("............", ".####.......", "#....#......", "#..#####....", "#....#..#...", ".####....#..", "..#....####.", "...#..#....#", "....#####..#", "......#....#", ".......####.", "............")
    val panel = listOf("############", "#..........#", "#.##....##.#", "#.##....##.#", "#..........#", "#.###..###.#", "#..........#", "#..........#", "#.##....##.#", "#..........#", "#..........#", "############")

    @Composable
    fun Draw(grid: List<String>, cell: Dp = 2.dp, tint: Color = Px.ink900()) {
        Canvas(modifier = Modifier.size((12 * 2).dp)) {
            val px = cell.toPx()
            grid.forEachIndexed { y, row ->
                row.forEachIndexed { x, ch ->
                    if (ch == '#') drawRect(tint, Offset(x * px, y * px), Size(px, px))
                }
            }
        }
    }
}

// ── ayuditas ──

object When {
    fun ago(iso: String?): String? {
        if (iso == null) return null
        val date = try {
            Instant.from(DateTimeFormatter.ISO_DATE_TIME.parse(iso))
        } catch (e: Exception) {
            try {
                Instant.from(DateTimeFormatter.ISO_INSTANT.parse(iso))
            } catch (e2: Exception) {
                return null
            }
        }
        val m = ((Instant.now().epochSecond - date.epochSecond) / 60).toInt()
        if (m < 1) return "ahora"
        if (m < 60) return "hace $m min"
        val h = m / 60
        if (h < 24) return "hace $h h"
        return "hace ${h / 24} d"
    }
}

val stateName: Map<String, String> = mapOf("idle" to "libre", "working" to "trabajando", "blocked" to "bloqueado", "gone" to "fuera", "offline" to "apagado")

@Composable
fun stateColor(s: String?): Color = when (s) {
    "idle" -> Px.mint()
    "working" -> Px.lemon()
    "blocked" -> Px.coral()
    else -> Px.idle()
}
