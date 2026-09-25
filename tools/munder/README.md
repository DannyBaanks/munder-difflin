# munder — CLI de control (sin `npm run dev`)

`munder` arranca, para y observa la app sin tocar Electron a mano.
Node puro, cero dependencias. Linux-first.

## Instala

```bash
./tools/munder/install.sh   # symlink en ~/.local/bin + munder check
```

(Sin script: `ln -sf "$PWD/tools/munder/munder" ~/.local/bin/munder`.)

Sin args (con TTY) abre el menú interactivo. Sin TTY imprime la ayuda.

## Uso diario

```bash
munder start          # dev despegado anti-freeze (setsid, log a ~/.local/state/munder/)
munder status         # PIDs, uptime, puerto 5173, tail del log
munder logs -f        # seguir el log
munder stop           # TERM, espera 5s, KILL a lo que quede
munder restart        # stop + start
munder check          # verifica package.json + node_modules
```

`MUNDER_DIR` apunta al checkout (defecto: la raíz de este repo).
`MUNDER_STATE_DIR` apunta a estado/logs/pid (defecto: `~/.local/state/munder`).

```bash
MUNDER_DIR=/ruta/a/otro/checkout munder status
```

Regla de oro: **nunca build (`./start.sh`) + `munder start` a la vez** —
comparten `~/.config/munder-difflin` y la segunda instancia muere por singleton.

## Sesión viva

```bash
munder sesion ver                  # tabla de agentes
munder sesion armar --nombre X --comando "..." --cwd ...  # crea un agente
munder sesion quitar <id>          # elimina un agente (id o pty)
munder ctl ping                    # prueba el canal de control (M0)
munder repaint                     # repintado sin reiniciar
munder sesion proveedor            # wizard connect: CLIs, endpoints, modelos
munder create-harness ~/Dev harness-1  # carpeta de harness completa
```

Si `ctl ping` dice `ECONNREFUSED`, la app murió dejando
`~/.config/munder-difflin/munder-control.json` — arráncala de nuevo.

## Avatares solo con texto (sin keys)

```bash
munder avatar compilar "piel morena, pelo castaño largo, blusa rosa, gafas"
munder avatar compilar "piel morena, traje azul" --motor spec --pelo "corto castaño" --salida ./yo.png
munder avatar inspect ./yo.png     # matriz textual para que el modelo la "vea"
munder avatar lienzo ./base.png    # lienzo 18×28 para editar con modelo
```

## Inyectar tu avatar al piso (persistente)

```bash
munder avatar inyectar "piel morena, blusa rosa, gafas" --slot auto
munder avatar inyectar --ver          # lo guardado
munder avatar inyectar --quitar --slot kelly
```

Guarda tu receta en `~/.config/munder-difflin/avatar-overrides.json`;
la app la aplica al montar el piso (reinicia para verla) y arma su worker
con `character='<slot>'`. `auto` elige el primer slot libre según la sesión
viva; `michael` nunca se presta (es del GOD).

Motores: `local` (defecto, determinista), `spec` (cuerpo 18×32 con piernas),
`flow` (necesita el pincel FLOW: `flow` en PATH o `FLOW_CLI`), `modelo`
(edita con un endpoint de imagen; key **solo** por variable de entorno).
Mismo texto = mismo PNG. `INVALID_ENUM` + lista = corrige y reintenta.

Detalle del formato para modelos: `AVATAR_AGENTES.md`.
Spec congelado v1: `AVATAR_SPEC.md` + `avatar-spec.schema.json`.

## Tests

```bash
node tools/munder/avatar.test.cjs
node tools/munder/proveedor.test.cjs
```

`avatar-engine.cjs` es GENERATED desde
`src/renderer/src/scene/office/portraitArt.ts` — no se edita a mano:

```bash
node tools/munder/sync-avatar-engine.cjs [--fuente <checkout>]
```

`munder.bash-legacy` es el launcher bash anterior, conservado como referencia.
