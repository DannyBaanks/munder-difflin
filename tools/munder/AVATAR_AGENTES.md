# Crear avatares desde texto — receta determinista para agentes

Si eres un agente (o persona) y necesitas un avatar 18×28: **siempre este
flujo, y lo único que cambias es `<desc>`**. Todo lo demás está fijado.

## 1. Elige motor (árbol de decisión, en orden)

| Tu situación | Motor | Comando |
|---|---|---|
| Tu modelo **edita imágenes** (GPT / gpt-image y wires `openai-compatibles` que editen) y tienes su key | `modelo` | ver §2 con `--motor modelo --endpoint <id> --model <id>` |
| Quieres **cuerpo completo con piernas** desde texto puro, sin imaginar nada (cualquier LLM, incluso chiquito) | `spec` | ver §2 y §6 con `--motor spec` |
| Todo lo demás (modelos sin engine de imagen, sin key, o quieres determinismo byte-exacto del busto) | `flow` | ver §2 con `--motor flow` |
| Sin red y sin pincel FLOW instalado | `local` | ver §2 sin `--motor` (default) |

Regla de oro: **`spec` si el avatar necesita piernas; `flow` en los
demás casos sin engine**. Si no sabes si tu modelo edita imágenes, usa
`spec` o `flow` (nunca piden clave). `local` solo cuando ni hay red ni
hay FLOW.

## 2. El comando (solo cambia `<desc>`)

```bash
node tools/munder/munder avatar compilar "<desc>" --motor flow --salida ./mi-avatar.png
```

Para cuerpo completo con selector guiado por partes (cada flag acepta
palabra ES, ID, `#rrggbb` o `PANTONE:` libre; lo no reconocido muere con
`INVALID_ENUM` + lista para corregir, nunca en silencio):

```bash
node tools/munder/munder avatar compilar "piel morena, traje azul" \
  --motor spec --pelo "corto castaño" --ojos verdes \
  --pantalon azul --zapatos negros --salida ./mi-avatar.png
```

O con el DSL directo (el formato que la §6 enseña a escribir):

```bash
node tools/munder/munder avatar compilar --dsl ./mi-avatar.txt --salida ./mi-avatar.png
```

`<desc>` es español libre con este vocabulario (lo no reconocido **avisa**,
no rompe):

- **piel**: clara, morena, marrón, oscura
- **pelo**: color (negro, castaño, rubio, pelirrojo, gris…) + estilo (corto,
  flequillo, largo, moño, rizado, despeinado, entradas, pinchos, calvo)
- **ropa**: traje, camisa, polo, blusa, cárdigan, suéter + color (azul, rojo,
  negro, rosa…)
- **extras**: gafas, bigote, barba, corbata COLOR, cejas (rectas/enojadas/…),
  boca (sonrisa/neutra/…), rubor, robusto

Ejemplo: `piel morena, pelo castaño largo, blusa rosa, gafas`.

Con motor `modelo` añade `--endpoint openai --model gpt-image-1`
(y la key **solo** por variable de entorno, p. ej. `OPENAI_API_KEY`;
jamás por flag ni en el prompt).

## 3. Reglas fijas (no las cambies, ya están en el CLI)

1. El prompt del modelo lleva un sufijo pixel-art fijo (18×28, fondo
   transparente, sin texto): no lo escribas tú, lo pone el CLI.
2. Salida **siempre 18×28 exactos**: lo que no cumple se rechaza, nunca se
   reescala (destruiría el pixel-art).
3. Verificación M11 sobre todo PNG emitido (dimensiones, alfa real, tope
   512 KB).
4. Nunca se sobreescribe: si el archivo existe, el CLI se niega (bórralo o
   pasa `--salida`).
5. El bloque de éxito es **idéntico en los tres motores** (contrato para
   agentes): si no ves `✓ avatar compilado:` + `receta:`, no hay avatar.

## 4. Salida real (ejecutada 2026-09-23, motor flow, sin clave ni red)

```bash
$ node tools/munder/munder avatar compilar 'piel morena, pelo castaño largo, blusa rosa, gafas' --motor flow --salida /tmp/readme-flow.png
  ✓ avatar compilado:
    /tmp/readme-flow.png (18x28, 312 px opacos)
    receta: piel=tan pelo=styleFrame ropa=blouse
$ echo $?
0
```

Y para verlo con ojos de LLM (matriz textual, misma forma para cualquier PNG):

```bash
$ node tools/munder/munder avatar inspect /tmp/readme-flow.png
CANVAS 18x28  (/tmp/readme-flow.png)

00 ..................
01 ..................
02 ...BBBBBBBBBBBB...
03 ...BBBBBBBBBBBB...
04 ...BBBBBBBBBBBB...
05 ...BBBBBBBBBBBB...
06 ...BBCCCCCCCCBB...
07 ...BBFFCCCFFCBB...
08 ...BHEEEEHEEEBB...
09 ...BEJKECEKJEBB...
10 ...BBEECCCEECBB...
11 ...BBCCCDCCCCBB...
```

`--motor modelo` en vivo: **NO PROBADO** (este host no tiene key de
endpoint de imagen; el CLI la exige por entorno y nunca la imprime). Prueba
ejecutable que sí corre: `node tools/munder/avatar.test.cjs` incluye
`compilar --motor modelo E2E contra stub` (instala, rechaza con exit 2,
key fuera de archivos y de la salida).

## 5. Si algo falla (tabla)

| Salida | Significa | Haz esto |
|---|---|---|
| `motor desconocido 'X'. Opciones: local, modelo, flow` | typo en `--motor` | usa uno de la lista |
| `endpoint desconocido 'X'. Opciones: …` | id mal | elige de la lista |
| `… es wire 'nativo': …` | ese endpoint no edita imágenes | cambia de endpoint o usa `--motor flow` |
| `falta OPENAI_API_KEY en el entorno` | sin key | `export OPENAI_API_KEY=…` (nunca `--key`) |
| `el endpoint respondió 404: ESTE endpoint no edita` | el modelo no tiene engine | `--motor flow` (degradación honesta, nada se cobró) |
| `AVATAR_REJECTED: …` | el modelo devolvió algo inválido | no se instaló nada; reintenta o usa `flow` |
| `motor flow: flow no disponible: …` | falta el pincel | instala FLOW o `export FLOW_CLI=<checkout|binario>` |
| `motor flow: flow paint falló (exit 2): …` | bug del emisor, no tuyo | repórtalo con receta + motivo |
| `~ no entendí: "…"` | palabra fuera de vocabulario | aviso amarillo, el avatar sale igual; reformula si importa |
| `INVALID_ENUM <campo>: '<valor>'. Opciones: …` | enum fuera de catálogo (motor spec) | corrige con la lista y reintenta (bucle de corrección) |
| `no se lee --dsl …` | archivo DSL ilegible | revisa la ruta |
| `--dsl solo vale con --motor spec` | flag contradictorio | quita `--motor` o pon `spec` |
| `ya existe …` | no se sobreescribe | borra o cambia `--salida` |

## 6. Para LLMs: mapa + DSL (léeme antes de pedir un avatar)

El canvas cuerpo-completo es **18×32**. No imagines dónde va cada cosa:

| región | coords | qué pinta el motor ahí |
|---|---|---|
| HEAD | x4..13, y2..16 | piel + cara + pelo |
| EYES | x5..6,10..11, y9 | iris del color que pidas |
| NECK | x7..10, y17 | cuello |
| TORSO | y18..24 | prenda del color que pidas |
| LEGS | cols 5..7 y 10..12, y25..30 | pantalón del color que pidas |
| FEET | mismas cols, y31 | zapatos del color que pidas |

Escribe un bloque así (una declaración por línea, `#` comentarios;
`PANTONE:` + texto libre donde quieras color; lo demás, IDs o básicos):

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

Guárdalo en un `.txt` y compílalo con `--dsl` (ver §2). Si algo está
mal, el motor responde `INVALID_ENUM <campo>: '<valor>'. Opciones: …`
— corrige con la lista y reintenta. Determinismo: mismo spec, mismo
PNG, siempre; edita un campo y re-renderiza (no regeneres todo).

Salida real (motor spec, sin clave ni red, 2026-09-24):

```bash
$ node tools/munder/munder avatar compilar 'piel morena, pelo negro corto, traje azul, pantalon azul, zapatos negros' --motor spec --salida /tmp/m-spec.png
  ✓ avatar compilado:
    /tmp/m-spec.png (18x32, 292 px opacos)
    receta: piel=SKIN_02 pelo=short_01 ropa=suit
```

## 7. Dónde vive cada cosa (para no perderse)

- `tools/munder/munder` — CLI (`avatar compilar [--motor …]`, `editar`, `inspect`, `lienzo`)
- `tools/munder/lib-avatar.cjs` — PNG, verify M11, parser ES→receta, edición por modelo
- `tools/munder/avatar-engine.cjs` — retratos procedurales (GENERATED de `portraitArt.ts`; no editar a mano)
- `tools/munder/flow-emit.cjs` — receta/spec → programa `.flowpaint` (busto + cuerpo 18×32, determinista)
- `tools/munder/avatar-spec.cjs` — normalizador ES/DSL → spec v1 + validador + paleta
- `tools/munder/AVATAR_SPEC.md` + `avatar-spec.schema.json` + `avatar-spec.fixtures.json` — spec congelado v1
- `tools/munder/avatar.test.cjs` — suite (`node tools/munder/avatar.test.cjs`)
- El pincel FLOW vive en **otro repo** (`ISyCo Git/FLOW`, `flow paint`): munder lo **invoca**, nunca lo copia.
