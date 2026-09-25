<!-- Puente entre los dos mantenedores del fork. PÚBLICO por necesidad (este
     repo es público: gh auth no restringe descargas aquí). No hay secretos,
     llaves, tokens ni IPs en este archivo — eso va por el Bridge privado. -->

# Mantenedores del fork ISyCo

Este archivo es el puente entre los dos que cuidamos este fork.
Existe porque el repo es público y necesitamos un punto de encuentro
que ambos podamos leer con un simple `git pull`.

## Quién es quién

| Lado | Mantenedor | Cuida |
|---|---|---|
| Linux | opencode (este host) | `start.sh`, `tools/munder/`, build AppImage + `.exe` (wine), suites, typecheck |
| Windows | lado Windows (máquina nativa) | `munder.ps1`, `munder.cmd`, `install.ps1`, NSIS/SmartScreen, ConPTY, guía sin MSVC |

## Carriles (no cruzar sin avisar)

* **Linux no toca** `*.ps1`, `*.cmd`, `install.ps1` ni nada bajo `C:\`.
* **Windows no toca** `tools/munder/`, `start.sh` ni `*.sh`.
* **Compartido** (avisar en el Bridge antes): `src/`, `package.json`,
  `electron-builder.yml`, workflows, `RELEASE.md`.

## Reglas

1. `git commit -- <tus paths>`, nunca bare. Nada de push sin Danny.
2. Todo PR corre `npm run typecheck` + suites del CLI antes de pedir review.
3. Los binarios los arma Linux (AppImage + setup/portable por wine, probado).
   Windows prueba el portable en máquina real y reporta.
4. Secrets/llaves/IPs: **nunca** en este repo. Fixtures con forma de llave
   llevan marca `FAKE`/`EXAMPLE` (el repo-engine las marca, son falsos
   positivos conocidos — ver historial del bridge).
5. Coordinación: Bridge tópico `isyco-git/munder-fork` (RESULT al cerrar,
   HANDOFF al abrir).

## Estado (2026-09-25)

* `v0.5.2-ISyCo.1` publicado: AppImage + setup + portable + sums. ✅
* Base a la par del upstream (su HEAD del 18 sep, incluye su `v0.5.2`). ✅
* Munder Link dentro (8/8 tests; entre 2 máquinas físicas: NO PROBADO).
* Pendiente Windows: `munder.ps1`/`.cmd` limpios (el de la sesión del 25 sep
  trae funciones duplicadas por la herramienta de edición) + `install.ps1` +
  PR + test del portable sin compilar.
* Pendiente compartido: CI no dispara runs (0 eventos); releases manuales
  mientras tanto.
