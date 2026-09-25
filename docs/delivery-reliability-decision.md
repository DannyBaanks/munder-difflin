# Delivery reliability — decision record (2026-09-23)

Incident: god→Pam dispatch sat in `agents/god/outbox/` ~2h (18:44 → 20:39:52 UTC)
while scheduler heartbeats kept flowing. No silent backlog is acceptable:

> If an actionable message is accepted for an idle worker, the system delivers
> and wakes it within a bounded, observable interval, or exposes degraded state.

## Diagnosis (evidence)

1. **Two planes.** `hive.send()` (`src/main/hive.ts:1555`) writes DIRECTLY to the
   recipient inbox — heartbeats, standups, breaker mail all bypass the router.
   Agent-written outbox files move ONLY via `routeOnce()` on the 1.5s router
   interval (`hive.ts:1705`). So "scheduler alive" never implied "router alive".
   Log 18:44→20:39 shows 28 heartbeat messages, zero `routed` events — consistent.
2. **Router has teardown paths with narrow re-arm.** `stopRouter()` runs on
   changeHome / quit / reset; re-arm exists only on boot (`bootstrapHiveServices`)
   and true sleep/wake (`onSystemResume`, committed). Any stop without re-arm =
   silent indefinite stall. The exact trigger of this incident is unidentified
   (no changeHome/reset/quit in the window; no app-start at recovery), but every
   trigger variant produces the same observable state — and nothing observed it.
3. **Wake can't fix unrouted mail.** `WorkerWakeWatchdog` (15s main beat) and the
   renderer nudge only see mail already in inbox. God is woken by heartbeat —
   the exact noise that masked the stall.
4. **Breaker punishes the workaround.** The Pi bridge (`hive.ts` PI_EXTENSION)
   and the OpenCode plugin (OPENCODE_PLUGIN) post `PostToolUse` WITHOUT
   `tool_input`. `toolKey()` then collapses to `bash:<sha256('')>` — constant —
   so any 8 consecutive Bash calls trip `looping: 8× identical tool call`. All
   openisy-agent steers in the incident match this shape. Breaker #377 fixed
   truncated-input collisions, not missing input.

## Options

| # | Idea | Fixes | Remaining | Platform risk | Complexity | Observability | Class |
|---|------|-------|-----------|---------------|------------|---------------|-------|
| B | Receipts + backlog age | nothing (diagnostic) | stall itself | none | low | high | diagnostic |
| C | Nudge-on-route via routedObserver | wake latency after delivery (~27s→~0s) | stall itself | none | low | medium | mitigation |
| A | fs.watch push primary | poll cadence (already 1.5s when alive) | supervision gap | macOS quirks (cited in-tree) | medium | low | wrong target |
| S | **Router supervision** (new) | EVERY stall trigger: re-arm + drain within bound, degraded log | — | none (same poll) | low | high | **root fix** |
| D | Separate planes | god can't distinguish noise vs rot | — | none | trivial | medium | mitigation |
| E | Breaker: missing input ≠ identical | false loop trips on bridged agents | real loops still caught (other arms + full-input arm) | none | trivial | n/a | root fix |

## Decision

- **S (implement):** `HiveManager.superviseRouter()` — stamps `lastRouteAt` on every
  `routeOnce()` completion; when outbox backlog exists and (timer dead OR
  `now-lastRouteAt > 30s`), re-arm + drain immediately + `router-supervise` log.
  Called from the 8s always-on beat (main-process, renderer-independent) and from
  `onSystemResume` (replacing its ad-hoc trio). Worst-case stall: ~8s + 1.5s.
- **B (implement, minimal):** `routerHealth()` (running, lastRouteAt, backlog,
  oldest age) + one backlog-age line in god's heartbeat digest + degraded log.
  No new UI surface.
- **C (implement):** fan-out `addRoutedObserver()`; register the wake beat so a
  routed message triggers one edge-triggered wake check immediately (cooldown +
  announced-ids dedupe already prevent storms/doubles).
- **A (reject as primary):** poll is fast enough when supervised; fs.watch buys
  no latency and re-opens the cited macOS risk. Poll REMAINS the bounded
  fallback — now a supervised one.
- **D (implement, one line):** digest shows oldest actionable backlog age.
- **E (implement):** `recordToolUse` ignores calls with missing `tool_input`
  (absence of evidence ≠ evidence of loop). True loops still trip via full-input
  keys and the velocity/error/no-progress arms.

## Verdict on "background timer suspension caused the stall"

See final report. Structural evidence supports the failure CLASS (two planes +
unsupervised timer + unobservability); per-timer throttling alone cannot explain
a dead 1.5s interval beside a live 5min chain in one libuv loop, so the trigger
was most likely a teardown without re-arm, not throttling.
