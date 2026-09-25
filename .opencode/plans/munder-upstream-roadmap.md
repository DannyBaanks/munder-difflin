# Plan

## Roadmap: ideas upstream → implementación nativa en Munder

> **Estado:** BLOCKED · plan local creado y commiteado; falta autorización/escritura en el repo hermano de Munder
> **Snapshot:** 2026-09-25
> **Fork:** `DannyBaanks/munder-difflin` · `main` `944d7cd1`
> **Upstream:** `chaitanyagiri/munder-difflin` · `main` `c7c8921f` · 135 PRs abiertos
> **Destino de implementación:** `/home/danny/Development/ISyCo Git/munder-difflin-public`
> **Regla:** los PRs upstream son fuente de propiedades y evidencia, **no candidatos a merge**. Cada milestone se vuelve a implementar con commits propios en `DannyBaanks/munder-difflin`.

## Estado

El baseline fue verificado en vivo. El plan se ejecuta por milestones: cada lote tiene su rama/PR, push, gates y resultado PASS/FAIL. No se avanza al siguiente lote hasta que el anterior quede verde o explícitamente diferido.

## Objetivo

Reimplementar en el fork las propiedades de seguridad, durabilidad y resiliencia descubiertas en los PRs upstream, sin traer sus commits ni mergear sus ramas y sin romper Link, Mobile/PWA, iOS, Reviver, GPT ni el contrato de harnesses externos. El objetivo no es replicar el upstream: es conservar la autoridad del fork e implementar solamente lo que sigue faltando.

## Evidencia inspeccionada

- `git rev-parse HEAD` en el fork: `944d7cd127b53e949b54d4ca978e10a2bac080a4`.
- `git rev-list --left-right --count main...origin/main`: `101 0`; merge-base `c7c8921f`.
- `gh pr list --repo chaitanyagiri/munder-difflin --state open --limit 200`: `135` PRs abiertos.
- Se compararon 21 PRs: 12 prioritarios y 9 secundarios; no se editó el fork durante la radiografía.
- Todos los PRs citados siguen `OPEN`; varios tienen `Before / after evidence` en rojo. No se deben considerar autoridad de implementación.
- Conflict Matrix observada: `src/main/hive.ts`, `src/main/index.ts`, `src/main/config.ts`, `src/main/hooks.ts`, `src/renderer/src/components/AddAgentModal.tsx`, `src/renderer/src/i18n/locales/*` y `src/preload/index.ts` ya tienen evolución propia; el fork tiene además `es.json`.

## Alcance

- Crear una rama/PR por milestone.
- Crear código propio para cada propiedad upstream; no traer commits ni merges upstream.
- Preservar receipts existentes (`lib-harness`/`lib-reviver`) y la autoridad de Link/Remote.
- Añadir `es.json` a cualquier cambio i18n.
- Ejecutar typecheck, tests focalizados, `check:links`, build cuando corresponda y CI de Linux/Windows/macOS.
- Reportar PASS/FAIL con salida real antes de continuar.

## Regla de ejecución: upstream es investigación, no backlog de merge

- **No** se hace `merge`, `cherry-pick`, rebase ni se importa una rama/PR de `chaitanyagiri/munder-difflin`.
- Cada milestone se implementa con commits propios en el fork `DannyBaanks/munder-difflin`.
- El PR upstream se cita como **evidencia de una propiedad** (qué falla, qué invariante propone y qué caso cubre), no como ancestry de código.
- Si el fork ya resolvió la propiedad de otra forma, se conserva la solución del fork; no se fuerza el texto del PR.
- El PR del fork describe la propiedad implementada y sus tests, aunque la inspiración venga de `#NNN` upstream.

## No objetivos

- No sincronizar el fork con el upstream completo.
- No implementar la Web UI completa (#173), el preset `mcode` (#414) ni WSL2 (#437) en este lote.
- No mezclar traducciones, marketing, skins o duplicados.
- No crear un segundo plano de evidencia para #342.
- No rebases ni force-push sobre ramas existentes.

# Mapa de milestones

| ID | Lote | PRs/propiedades | Depende de | Estado |
|---|---|---|---|---|
| M0 | Roadmap y baseline | Este plan; Conflict Matrix | — | BLOCKED_PERMISSION |
| M1 | Integridad y seguridad pequeña | #607, #529, #566, #564, #474 | M0 | PENDING |
| M2 | Ledger y trabajo no integrado | #562, #496 | M1 (#529) | PENDING |
| M3 | Resiliencia de runtime | #495, #468 | M1, M2 | PENDING |
| M4 | Fuse del control plane | #563 + bounce de GPT | M1, M3 | PENDING |
| M5 | Decisión Codex remoto | #610 | M4 | BLOCKED_DECISION |
| M6 | Superficie de operador | #605, #428, #342 | M1–M4 | PENDING |
| M7 | Mejoras opcionales | #108, #508, #465-split, #450+#217, #470, #457-split, #476, #542-narrow | M6 | OPTIONAL |
| M8 | Descartados/deferred | #173, #414, #437, traducciones, marketing, duplicados | — | SKIP |

## M0 — Roadmap y baseline

**Objetivo:** dejar el trabajo trazable antes de tocar código.

**Pasos previstos:**

- Registrar el fork, upstream, merge-base y lista de PRs abiertos.
- Mantener la Conflict Matrix con los archivos que el fork ya modificó.
- Commit y push de este artefacto en el repo activo antes de iniciar M1; si el permiso de escritura del fork se restaura, copiarlo también a `munder-difflin-public`.

**Criterio de aceptación:** el roadmap existe, el checkout está limpio y el baseline es reproducible.

**Bloqueo actual:** el entorno permite editar únicamente `.opencode/plans/*.md` del repo activo y rechaza escrituras en `/home/danny/Development/ISyCo Git/munder-difflin-public`. El plan ya está commiteado en ISyCo como `3b3255dc`, pero no se puede copiar/pushear al fork desde esta sesión sin autorización de escritura para el repo hermano.

**Comando de prueba:**

```bash
git status --short --branch
git rev-parse HEAD
git rev-list --left-right --count main...origin/main
gh pr list --repo chaitanyagiri/munder-difflin --state open --limit 200
```

**Rollback:** `git revert` del commit del plan; no toca runtime.

## M1 — Integridad y seguridad pequeña

**Objetivo:** reimplementar en el fork propiedades pequeñas, de bajo conflicto y alto valor, usando los PRs upstream solo como referencia.

**Rutas previstas:** `src/main/hive.ts`, `src/main/config.ts`, `src/main/index.ts`, `src/main/workerWake.ts`, `src/renderer/src/hooks/useHive.ts`, `src/shared/broadcast.ts`, tests focalizados.

**Lote:**

1. **Propiedad de #607 — trust de Claude en Windows:** reimplementar `hasTrustDialogAccepted` bajo las rutas que Claude realmente lee; probar cwd `C:/...`.
2. **Propiedad de #529 — escrituras atómicas:** reimplementar la protección de `registry.json`, `tasks.json`, `config.json` y `fleet.json`.
3. **#566 — IDs de mensaje del servidor:** cerrar colisiones/path traversal y cubrir también el inbox GPT.
4. **#564 — hold efectivo:** wake beat, renderer poll y broadcast deben respetar el hold.
5. **#474 — no reescribir docs generados:** `PROTOCOL.md`/`COMMANDS.md` solo se generan al faltar o por operación explícita.

**Criterio de aceptación:** typecheck, `check:links`, tests focalizados, build y CI de tres sistemas verdes; evidencia Before/After; ningún cambio ajeno.

**Comandos de prueba:**

```bash
npm run typecheck
npm run check:links
node --test test/control-channel.test.cjs
npm run test:focused -- --test-reporter=spec
npm run build
```

**Rollback:** revert del merge commit por propiedad; nunca `reset --hard` ni reescritura de historia.

## M2 — Ledger y trabajo no integrado

**Objetivo:** evitar pérdida de tablero y borrado de trabajo no integrado.

**Rutas previstas:** `src/main/hive.ts`, `src/main/index.ts`, `src/main/git.ts`, tests de mutación de tasks y teardown de worktree.

**Lote:**

- **#562:** `tasks.json` ilegible no puede fallbackear a `{tasks: []}` durante una mutación; los handlers IPC devuelven error controlado, no promesa rechazada.
- **#496:** un agente nombrado conserva worktree con commits no integrados; integrar con el guard de symlink de Link.

**Dependencias:** M1, especialmente #529.

**Criterio de aceptación:** test de ledger corrupto que conserva el tablero previo, test de teardown con trabajo no integrado, receipts/`git status` verificables, suite y CI verdes.

**Rollback:** revertir el lote; los worktrees preservados permanecen recuperables.

## M3 — Resiliencia de runtime

**Objetivo:** hacer que hooks y procesos sobrevivan a una muerte violenta sin matar cosas equivocadas.

**Rutas previstas:** `src/main/hooks.ts`, `src/main/index.ts`, `src/main/pty.ts`, nuevo ledger de stale agents, `procKill.ts`, tests de socket/procesos.

**Lote:**

- **#495:** health/retry/logs del hook socket, `fleet.json` auditable y no borrar sockets de otra instancia; preservar `hiveGuard`.
- **#468:** ledger persistente PID + start time + comando; ante identidad incierta conservar, no matar; no debilitar `procKill.ts`.

**Dependencias:** M1–M2; integración explícita con Reviver.

**Criterio de aceptación:** simular socket huérfano, muerte de Munder y PID reciclado; demostrar supervivencia de `opencode` humano y de otro Munder con otro userData; CI verde.

**Rollback:** revertir el lote y apagar solo el supervisor nuevo; nunca matar por PID sin identidad.

## M4 — Fuse del control plane

**Objetivo:** hacer real `HOP_CAP` para cualquier camino de control, incluido GPT.

**Rutas previstas:** `src/main/hive.ts`, `lib-harness`, `lib-gpt`, tests de routing/harness.

**Lote:** reimplementar la propiedad de #563; el emisor incrementa `hops`; el bounce de GPT pasa por el mismo contador; un loop Munder → harness → MCP → Munder agota el fuse y deja receipt.

**Dependencias:** M1 (#566) y M3 (hooks/health).

**Criterio de aceptación:** tests en `HOP_CAP-1`, `HOP_CAP` y `HOP_CAP+1`, loop GPT↔Michael↔harness, mensaje normal sin incremento, CI verde.

**Rollback:** revertir solo el contador; nunca relajar el límite para hacerlo pasar.

## M5 — Codex `--remote` vs `--add-dir`

**Objetivo:** resolver una decisión de producto antes de reimplementar la propiedad de #610.

**Opciones:** mantener remote y omitir `add-dir`; mantener roots y devolver `remote_unavailable`; o hacerlo opt-in por agente.

**Criterio de aceptación:** tabla de decisión, tests de argv, smoke local y smoke remoto documentado. No aplicar el PR upstream a ciegas.

## M6 — Superficie de operador

- **#605:** estado `starting / awaiting-hive-selection / open`, idealmente también en la salud de Reviver.
- **#428:** modelos vivos de OpenCode con cache/timeout; no bloquear el main indefinidamente.
- **Propiedad de #342:** reimplementar la evidencia sobre los receipts existentes; no crear un segundo esquema.

**Dependencias:** M1–M4. **Aceptación:** estados observables, fallbacks probados, `es.json` incluido.

## M7 — Mejoras opcionales

Abrir como lotes independientes: #108 (solo validación sobre `ptyEnv`), #508 (parser framing), #465 (primero PTY coalescing), #450+#217 (memory descriptor + bundle), #470 (floor switcher con fixes AltGr/checkmark), #457-split (solo `reviewGate`/`agentDuty`), #476 (después de seguridad/performance), #542 (solo backfill/cache).

## M8 — No implementar por ahora

#173 Web UI completa, #414 `mcode` worker, #437 WSL2, traducciones duplicadas, marketing, skins y PRs que rehacen propiedades ya resueltas.

## Definition of Done

- Rama y PR identificados del fork.
- El diff contiene solo commits propios del fork; ningún merge/cherry-pick upstream.
- El PR upstream aparece como referencia/evidencia, no como ancestry.
- Diff limitado al milestone.
- Tests focalizados ejecutados y salida conservada.
- `npm run typecheck`, `check:links`, `build` y CI aplicables verdes.
- Evidencia Before/After cuando haya superficie visible.
- `es.json` revisado si el cambio toca i18n.
- Commit pushado y PR actualizado.
- Resultado explícito: **PASS**, **FAIL** o **DEFERRED**.
- Solo después de PASS se empieza el siguiente lote.

## HANDOFF TO CODER

**Primer paso inequívoco:** M0 no toca runtime. El artefacto canónico está en `/home/danny/Development/ISyCo/.opencode/plans/munder-upstream-roadmap.md`; está commiteado en ISyCo como `3b3255dc`, pero el fork hermano rechaza escrituras en esta sesión. Un `maintainer` debe copiarlo/commitearlo en `munder-difflin-public` o habilitar ese permiso; después se espera PASS de M0 antes de crear la rama/PR de M1 en Munder.

**Orden de implementación:** M0 → M1 (propiedades #607, #529, #566, #564, #474) → M2 (#562, #496) → M3 (#495, #468) → M4 (#563) → decisión M5 (#610) → M6 → M7 opcional.

**Regla de continuación:** después de cada push, reportar PASS/FAIL/DEFERRED. No abrir el siguiente lote hasta PASS.

**Handoff:** `coder` puede iniciar M1 después de que M0 esté commiteado y pushado. `researcher` debe resolver la decisión de producto de #610 antes de M5.
