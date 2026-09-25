# AVATAR_SPEC v1 — compilador paramétrico de avatar (congelado)

Origen: plan `.opencode/plans/avatar-parametrico.md` (M0).
Estado: **FROZEN v1**. Cambiar cualquier tabla, pieza, anchor o gramática
= bump a v2 con motivo en este archivo. El renderer y el normalizador
(M1/M2) implementan ESTA versión byte a byte.

Idea: el LLM traduce intención a spec; el motor compila spec a PNG.
El LLM jamás pinta un píxel. `spec A + assets v1 = mismo PNG siempre`.

## 1. Formato de canvas (decisión M0)

**Cuerpo completo 18×32** (`formato escena`). El busto 18×28 sigue vivo
para los verbos existentes (`inspect`, `lienzo`, `editar`, motores
local/modelo/flow) sin cambios; el spec paramétrico apunta al formato
escena porque el usuario exige piernas/pantalones/zapatos.

Mapa de regiones (evidencia: `avatar-engine.cjs` escena 18×32 —
`SCENE_W/H`:21-22, `drawSceneLegs`:508-520, `composeScene`:795-806;
cabeza idéntica al retrato):

| región | coords | evidencia |
|---|---|---|
| HEAD | x4..13, y2..16 | retrato (`HX0/HX1`, `drawHead`) |
| EYES | x5..6,10..11, y9 | `drawFace` |
| NECK | x7..10, y17..18 | `collarNeck` |
| TORSO | y18..24 | `drawSceneTorso` |
| LEGS | cols 5..7 y 10..12, y25..30, gap x8..9 | `drawSceneLegs` |
| FEET | mismas cols, y30..31 (según fase) | `drawSceneLegs` |

## 2. Piezas cerradas (ni una más en v1)

`BODY, HEAD, HAIR, EYES, EYEBROWS, MOUTH, SHIRT, PANTS, SHOES, ACCESSORY_1`.
`HEAD`/`BODY` no llevan estilo en v1 (fijos por formato); existen para que
el schema y el DSL sean totales desde el día uno.

## 3. Catálogos por pieza (cerrados; lo ausente es INVALID)

Origen de los nombres existentes: `AVATAR_VOCAB` del engine. Los IDs con
sufijo numérico son el vocabulario del spec (mapeo documentado, no alias
mágicos del renderer: M2 los implementa contra esta tabla).

- `hair.style`: `short_01, floppy_01, frame_01, bun_01, curly_01, messy_01,
  recede_01, spiky_01, bald_01` (↔ `styleShort…styleBald` del engine).
- `shirt.style`: `suit, dressshirt, polo, blouse, cardigan, sweater`
  (los 6 del engine). FUTURO (hoy INVALID): `tshirt, hoodie, jeans-style`.
- `eyes.style`: `round_01` (catálogo de uno: el engine dibuja una sola
  forma de ojo; el color manda).
- `eyebrows`: `flat, angry, raised, soft`.
- `mouth`: `neutral, smile, frown, grin`.
- `facial` (opcional): `mustache, mustacheSm, stubble, goatee`
  (ausente = sin vello).
- `glasses, blush, lashes, heavy`: booleanos (ausente = false).
- `body`: `standard_01` (+ `heavy`).
- `pants.template`: `standard_01` (solo color en v1).
- `shoes.template`: `standard_01` (solo color en v1).
- `accessory_1`: `none` (FUTURO: `hat_01,…` — hoy INVALID).

## 4. Paleta interna (normativa v1, definida aquí)

Los HEX de filas marcadas `[engine]`/`[parser]` vienen del repo
(`SKIN`, `AV_PELO_COLOR`, `AV_COLOR`); los marcados `[v1]` los define
este spec. La columna Pantone queda reservada y VACÍA en v1 salvo que
Danny la llene: Pantone es opción de entrada, nunca dependencia.

| ID | HEX | RGB | origen |
|---|---|---|---|
| SKIN_01 | #F7C9AA | 247,201,170 | [engine] light.base |
| SKIN_02 | #D6A274 | 214,162,116 | [engine] tan.base |
| SKIN_03 | #9E704E | 158,112,78 | [engine] brown.base |
| SKIN_04 | #785038 | 120,80,56 | [engine] dark.base |
| HAIR_01 | #1E1612 | 30,22,18 | [parser] negro |
| HAIR_02 | #5C3C22 | 92,60,34 | [parser] castaño |
| HAIR_03 | #6E4B2D | 110,75,45 | [parser] marrón |
| HAIR_04 | #BE9E5F | 190,158,95 | [parser] rubio |
| HAIR_05 | #964628 | 150,70,40 | [parser] pelirrojo |
| HAIR_06 | #A8A49A | 168,164,154 | [parser] gris |
| HAIR_07 | #E4E4E4 | 228,228,228 | [parser] blanco |
| EYE_01 | #2E262A | 46,38,42 | [engine] pupila |
| EYE_02 | #6B4226 | 107,66,38 | [v1] marrón |
| EYE_03 | #6EAE6F | 110,174,111 | [parser] verde |
| EYE_04 | #6E8CB4 | 110,140,180 | [parser] azul |
| EYE_05 | #96682E | 150,104,46 | [v1] miel |
| CLOTH_RED | #B0413A | 176,65,58 | [parser] rojo |
| CLOTH_BLUE | #6E8CB4 | 110,140,180 | [parser] azul |
| CLOTH_GREEN | #6EAE6F | 110,174,111 | [parser] verde |
| CLOTH_YELLOW | #E8C85A | 232,200,90 | [parser] amarillo |
| CLOTH_BLACK | #3A3A44 | 58,58,68 | [parser] negro |
| CLOTH_WHITE | #F0EEEA | 240,238,234 | [parser] blanco |
| CLOTH_PINK | #ECAEC0 | 236,174,192 | [parser] rosa |
| CLOTH_PURPLE | #9692AA | 150,146,170 | [parser] morado |
| CLOTH_BROWN | #967856 | 150,120,86 | [parser] marrón |
| CLOTH_BEIGE | #ECDCC0 | 236,220,190 | [parser] beige |
| CLOTH_ORANGE | #D2823C | 210,130,60 | [parser] naranja |
| CLOTH_SKY | #8CBEDC | 140,190,220 | [parser] celeste |

Nombres básicos ES→ID (selector guiado): rojo→CLOTH_RED,
azul→CLOTH_BLUE, verde→CLOTH_GREEN, amarillo→CLOTH_YELLOW,
negro→CLOTH_BLACK, blanco→CLOTH_WHITE (misma tabla vale para pelo
con HAIR_* y ojos con EYE_*).

## 5. Gramática de color (por campo de color)

```
color := PALETTE_ID | HEX | PANTONE_FREE
PALETTE_ID := SKIN_0[1-4] | HAIR_0[1-7] | EYE_0[1-5] | CLOTH_[A-Z]+
HEX        := #[0-9a-fA-F]{6}   (literal RGB, siempre válido si bien formado)
PANTONE_FREE := PANTONE:<texto-libre no vacío>
```

Regla `PANTONE:` (v1): se preserva el texto verbatim en el spec
(`custom`) y se resuelve por palabras conocidas con el mismo
normalizador ES (p. ej. `PANTONE 186 C rojo` → `CLOTH_RED`). Sin
palabra conocida → `INVALID_ENUM` con `available` (el bucle de
corrección del modelo). No existe tabla Pantone→RGB en v1 a propósito.

## 6. DSL mínima (texto → spec, M1 la parsea)

```text
avatar {
  body standard_01
  skin SKIN_02
  hair short_01 HAIR_02
  eyes round_01 EYE_02
  eyebrows soft
  mouth smile
  shirt suit CLOTH_BLUE tie #AA3A3A
  pants standard_01 CLOTH_BLUE
  shoes standard_01 CLOTH_BLACK
  accessory_1 none
}
```

Una declaración por línea dentro de `avatar { … }`; comentarios `#`;
orden libre; campos del §3 ausentes = defaults (`body standard_01`,
`eyebrows flat`, `mouth neutral`, booleanos false, `accessory_1 none`).
El JSON canónico lleva `"spec": "avatar-spec/1"` + los mismos campos
(ver `avatar-spec.schema.json`).

## 7. Contrato INVALID_ENUM

Todo valor fuera de catálogo/gramática → objeto de error
`{ok:false, code:"INVALID_ENUM"|"SCHEMA", field, value, available[]}`
(o `SCHEMA` para forma rota: pieza desconocida, campo extra, tipo mal).
Nunca se adivina ni se reescala en silencio. Ejemplo:

```text
hair.style = "dragon_supersaiyan"
→ INVALID_ENUM, field "hair.style",
  available: short_01, floppy_01, frame_01, bun_01, curly_01,
             messy_01, recede_01, spiky_01, bald_01
```

## 8. Ejemplos (los 3 fixtures de `avatar-spec.fixtures.json`)

Válido: `piel morena, pelo castaño corto, traje azul` →
`skin SKIN_02, hair short_01 HAIR_02, shirt suit CLOTH_BLUE`
(+ defaults) → `ok:true`.
Inválido-forma: pieza `"cape"` → `SCHEMA`.
Enum-malo: `hair.style "dragon_supersaiyan"` → `INVALID_ENUM` +
`available` (fixture 3, el caso del plan).
