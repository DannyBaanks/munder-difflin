# Munder Mobile self-signing: M1 audit (architecture, licensing, network, authority)

Milestone M1 of *COMPOSE — Munder Mobile Self-Signing V0*. **No product code changes.**
This document exists before any implementation, as the compose requires, and it
ends at a stop condition: a licensing decision that is Danny's to make (§9).

Everything below was read from source at the commits listed. Nothing was run on
an iPhone; any device claim is marked INFERRED or NOT_DEMONSTRATED.

## 0. Provenance

| Component | Repository | Commit | Date | License (as found) |
|---|---|---|---|---|
| Munder base | DannyBaanks/munder-difflin `main` | `5fcc3081` | 2026-09-25 | MIT |
| SideStore | SideStore/SideStore `develop` | `0dd743f75afc358b0ba4a002feb5f19474492371` | — | AGPL-3.0 (`LICENSE`) |
| SideSign (pinned by SideStore) | SideStore/SideSign `main` | `6b68651697f99791ef85404b7aea1891a26a285d` | 2026-09-19 | GPL-3.0 per README; **no LICENSE file** |
| minimuxer (pinned by SideStore) | SideStore/minimuxer `develop` | `12be70dc2627307a16bfd2dc7a009080d5bec909` | — | AGPL-3.0 (`LICENSE`) |
| iBridge | DannyBaanks/iBridge `main` | `348eefd7de78e9bc612c9d619b8b1e7a80ba3ba0` | 2026-09-10 | MIT (fork of iloader) |
| iloader upstream | nab138/iloader `main` | `8473838c75fa71ede4da44d941307577d7bc6e10` | 2026-09-23 | MIT |
| isideload (iloader's engine) | nab138/isideload `main` | `52b504c2cd706a9e415109b0be9e137168034f5e` | — | MIT |
| idevice (device protocol crate) | jkcoxson/idevice | crate 0.1.68 | — | MIT |
| apple-codesign-quick (iloader's signer) | crates.io 0.1.0 (Dadoum/apple-crates) | — | — | **LGPL-2.1-or-later** |
| CodeSignKit, GSACryptoKit, AnisetteKit (SideSign's deps, `branch: main`, unpinned) | mahee96/* | `main` | — | **AGPL-3.0** |
| AppleBridge | DannyBaanks/AppleBridge `master` | `f5ea9bb4` | 2026-09-18 | — (not a signer; see §4) |

The SideStore commit is the one the compose cites, so there has been no drift
since the compose was written. **minimuxer, however, is not what the compose
assumed** (§3.3).

## 1. Current Munder Mobile (the baseline to preserve)

- **Targets.** `ios/MunderMobile/project.yml` (XcodeGen):
  - `MunderMobileCore`: static framework, no UI, simulator tests;
  - `MunderMobile`: the app. Bundle ID `mx.isyco.munder.mobile`, iOS 16+.
- **CI.** `.github/workflows/ios.yml` builds `MunderMobile-unsigned.ipa` on a macOS runner. It proves the bundle *can* be signed by ad-hoc signing a copy (`codesign --sign -`) and ships the IPA unsigned. No Apple credentials are in CI. That stays.
- **Keychain.** `Sources/Keychain.swift`:
  - service `mx.isyco.munder.mobile`;
  - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`;
  - **no explicit access group**, so items live in the app's default group, `<TEAMID>.mx.isyco.munder.mobile`.
- **Office connectivity.** `RemoteClient.swift` tries the LAN and Tailscale addresses in order, remembering the winner. There is no VPN of its own: Tailscale is the user's own app.
- **Installation today.** Done by hand with iloader (Windows/Linux), SideStore or AltStore (`ios/MunderMobile/README.md`). This is the rollback floor.

## 2. What "iBridge" actually is

**iBridge is iloader.** `DannyBaanks/iBridge@main` is byte-for-byte the upstream
commit `nab138/iloader@348eefd` ("Update isideload & bump version", v2.3.3). It has
no iBridge-specific commits and no Munder code. It is 10 commits behind upstream,
which has moved to v2.3.4 and isideload 0.4.0 (a git dependency on the fork).

iloader is a Tauri app (Rust backend, web UI). Its responsibilities, from `src-tauri/src/*.rs`:

| Capability | iloader | Where |
|---|---|---|
| Device discovery over usbmuxd | ✓ | `device.rs` (`list_devices`, `get_usbmuxd`) |
| Pairing, including RPPairing + lockdown pairing-file placement into apps (SideStore, StikDebug, …) | ✓ | `pairing.rs` |
| Apple Account login | ✓ | `account.rs`, via isideload GSA/SRP |
| Credential storage in the OS keyring | ✓ | `secure_storage.rs` (`keyring` crate, platform-native) |
| Certificates: list and **revoke** | ✓ | `account.rs` `get_certificates`, `revoke_certificate` |
| App IDs: list and delete | ✓ | `account.rs` |
| Sign + install an arbitrary IPA | ✓ | `sideload.rs` → isideload → apple-codesign-quick → idevice |
| Install SideStore and plant its pairing file | ✓ | `sideload.rs` `install_sidestore_operation` |
| Anisette | remote v3 | isideload `anisette/remote_v3`, default `https://ani.stikstore.app` |

**Conclusion:** the desktop bootstrap (M7 "one guided desktop bootstrap") is
already solved by iloader. It must be **integrated, not rebuilt** (§10). iBridge
as a fork adds nothing today. Either sync it with upstream or drop it in favour
of upstream releases.

## 3. SideStore today (develop @ 0dd743f7)

### 3.1 App

SideStore is an AltStore fork (the `AltStore/` tree is still present). It
re-signs with the user's personal development certificate and refreshes before
the 7-day expiry. Its README still says "a computer is required for the initial
installation" and describes the on-device path as "a specially designed VPN …
to trick iOS" (see the terminology rule in §11).

SideStore can optionally append `.<TEAMID>` to bundle IDs
(`InfoPlistCustomizationCoreView.swift`, `PipelineHandler.swift`,
`appendTeamID`). This matters for Keychain continuity (§7).

### 3.2 SideSign (signing and Apple developer services)

A Swift package: `SideSign`, `SideSign-Dynamic`, and a `sidesign` CLI. It covers:
- IPA/bundle re-signing, including nested extensions and frameworks;
- entitlement rewriting (`application-identifier`, `team-identifier`, `keychain-access-groups`);
- CSR generation and PKCS#12;
- a GSA (GrandSlam) login;
- a Developer Portal client (teams, App IDs, devices, certificates, profiles).

Local anisette is available through AnisetteKit.

**This is the native Swift engine Danny wants.** It already exists. The licensing below is the problem.

### 3.3 minimuxer has been rewritten, and the compose's picture of it is out of date

The compose describes minimuxer as the Rust lockdown muxer. At the pinned
commit it is a **Swift package** ("Swift complete rewrite by @mahee96"):

- **Device gateways are pluggable:** `idevice` (the MIT Rust crate, via FFI) or `libimobiledevice`.
- **EMProxy** ships as a binary xcframework from `SideStore/em_proxy` v0.9.3. It is the WireGuard loopback server that LocalDevVPN connects to.
- **There are two connection modes** (`MinimuxerApi.swift`):
  - `.localVPN`: the on-device loopback through LocalDevVPN (a `utun` interface). This is the supported path.
  - `.remoteServer`: *"Remote server endpoint ex: externalServer on VPN, on LAN, on router"*. In this mode minimuxer skips the utun/LocalDevVPN checks and only TCP-probes a user-configured IP (`MinimuxerImpl.swift` around L151 and L184; `DeviceConnectionManager.swift` around L167). **This is the upstream seam for "refresh through something reachable over Tailscale"** (§6).
- **New platform constraints in code:**
  - On **iOS 26.4+**, a lockdown pairing (rather than RPPairing) requires an IPsec/IKEv2 interface as well as utun ("LocalDevVPN may not support the lockdown protocol on iOS 26.4+").
  - Wireless pairing is marked **iOS 27+**.

  Both are real device-matrix risks.

## 4. AppleBridge (for completeness)

AppleBridge (`DannyBaanks/AppleBridge`) gives agents on Windows/Linux real iOS
**build/test verification** on GitHub macOS runners, as schema-frozen results
with receipts. It does not sign, provision or install for devices. It is
useful for M2–M6 CI (proving credential-free signing fixtures on a real
Apple toolchain), and it is not part of the signing boundary.

## 5. License matrix

| Component | License | Linked into a MIT Munder Mobile binary? | Consequence |
|---|---|---|---|
| Munder Mobile / Core | MIT | — | — |
| SideStore app | AGPL-3.0 | ✗ | Only as a separate app/repo under AGPL |
| minimuxer | AGPL-3.0 | ✗ | Same |
| **SideSign** | GPL-3.0 declared (README only) | ✗ | Linking makes the combined work GPL |
| **SideSign's crypto deps** (CodeSignKit, GSACryptoKit, AnisetteKit) | **AGPL-3.0** | ✗ | **Any binary using SideSign is effectively AGPL-3.0**, not GPL-3.0 as the compose assumed |
| em_proxy (EMProxy.xcframework) | AGPL-3.0 (SideStore/em_proxy `LICENSE`) | ✗ | Same as minimuxer |
| LocalDevVPN (separate App Store app) | custom "StosVPN License" | — | Not linked; the user installs it. Read its terms before recommending it in Munder docs |
| iloader / isideload / idevice | MIT | ✓ (desktop side) | Clean |
| apple-codesign-quick (iloader's signer) | **LGPL-2.1-or-later** | desktop only | Rust links statically, so LGPL relinking obligations apply to any Munder desktop helper that bundles it. Fine as a separate process (a subprocess of the unmodified iloader) |

Two corrections to the compose:

1. **SideSign is not "GPL-3.0" in practice.** Its three cryptographic dependencies are AGPL-3.0, and they are unpinned (`branch: main`).
2. **SideSign's repository has no LICENSE file**, only a README sentence. For a copyleft dependency that is a provenance gap: record it and ask upstream before relying on it.

## 6. Network / VPN model

```text
Munder Mobile ── LAN / Tailscale ──▶ Munder office          (office transport)
SideStore     ── LocalDevVPN utun ──▶ this iPhone's lockdown (signing transport, .localVPN)
SideStore     ── TCP to configured IP ──▶ ??? ──▶ lockdown   (.remoteServer, upstream seam)
```

- **Tailscale reachability is not device-service availability.** In `.localVPN` mode LocalDevVPN and Tailscale both want the single active VPN slot. The compose's V0 behaviour (switch, refresh, restore, then a health check) remains the right default. It is NOT_DEMONSTRATED on hardware.
- **`.remoteServer` is the interesting part.** It needs no LocalDevVPN, just an IP that exposes this iPhone's device services. Something at that IP would have to relay back to the phone's own lockdown/RSD port. That is essentially the community "Tailscale reflector" idea, and the Munder office (reachable over Tailscale) is the natural host.
  - It is not "Tailscale makes iOS think it's on Wi-Fi". It is an explicit relay whose behaviour must be proven on a device.
  - Classified **EXPERIMENTAL / NOT_DEMONSTRATED** (compose M8). It is still worth knowing that upstream now ships the client half.
- **Cellular-only refresh.** Nothing in the code supports the claim. It is not made.
- **iOS 26.4+ IKEv2 requirement (lockdown pairing).** This adds a VPN-type constraint that did not exist when the compose was written. It must be in the device matrix.

## 7. Keychain / bundle continuity (the pairing must survive refresh)

The Munder pairing key sits in the app's default keychain group, `<TEAMID>.<bundleID>`.

- **Same Apple team and same bundle ID:** the group is unchanged and the key survives the re-sign. INFERRED from the Keychain semantics; to be DEMONSTRATED in M4.
- **A different team** (another Apple Account, or a revoked and recreated team) makes the key unreachable. The user must re-pair the office, which is safe, never a plaintext export.
- **SideStore's `appendTeamID`** changes the bundle ID to `mx.isyco.munder.mobile.<TEAMID>`, and with it the default group. The first install decides; switching mode later loses the pairing.

Recommendation: the Munder signer must **pin the bundle ID** it was first installed with, and must refuse (and explain) a team change instead of silently re-pairing.

## 8. Credential and authority model (unchanged from the compose, now anchored)

- Apple credentials live only in the signer's own storage. iloader uses the OS keyring; SideStore uses the iOS Keychain.
- Never in the Munder config, hive, tasks, receipts, Link, GPT audit, CI or logs.
- Michael, workers and GPT (including Full) may only *create a human-facing request*, such as "Munder Mobile expires in 18 h".
- iloader exposes `revoke_certificate` and `delete_app_id`. A Munder wrapper must put an explicit human gate plus a receipt in front of both (compose §30).
- Autostart (compose §38): a desktop signer helper is started per user (systemd `--user`, a Windows logon task, a macOS LaunchAgent) only after a human approval screen that shows the path, the mechanism and "administrator: NOT REQUESTED". The Reviver (PR #21) already implements this pattern for its own daemon (receipts, user-level units), so reuse its code shape rather than inventing one.

## 9. Recommended boundary, and the STOP

### Recommended (L1 + Strategy B-in-its-own-repo)

```text
DannyBaanks/munder-difflin (MIT)               DannyBaanks/munder-sidestore (AGPL-3.0)
  Munder Mobile — remote client only             minimal AltStore-like companion
  (App Store-clean, unchanged)                   Munder Mobile ONLY: sign · refresh · update
        ▲                                        SideSign + minimuxer (as pinned by SideStore)
        │ signed / refreshed app                 tiny SwiftUI: status, expiry, [Renovar]
        └────────────────────────────────────────┘
                     ▲ bootstrap once
              iloader (MIT, upstream; iBridge optional) — desktop
```

- **Why a separate AGPL repo.** SideSign's deps make any SideSign-based binary AGPL. Keeping it in its own repo, as its own app, leaves Munder Mobile MIT and App Store-clean with no relicensing. It also keeps compose §6 simple: the App Store edition never contains signing code, so nothing has to be excluded at build time.
- **Why not fork all of SideStore.** It is an AltStore fork carrying a general store, sources, JIT, backups and widgets. Munder needs one app. Depend on the pinned SideSign + minimuxer packages and write a small UI.
- **Why not a clean MIT re-implementation (L3/Strategy C).** The only MIT signing stack found (isideload) signs with an LGPL crate, is Rust, and runs on the desktop. An on-device MIT engine would mean re-implementing GSA/SRP, CMS/Mach-O signing and the portal client, which is the security-sensitive reinvention the compose warns against.

**Rejected alternatives:**
- embedding SideSign in `MunderMobile` (it makes the app AGPL and not App Store-clean);
- vendoring SideStore into this repo;
- rebuilding the iloader bootstrap;
- a Tailscale-first design in V0.

### STOP: needs Danny's decision before M2

1. **License/repo split.** Approve a new AGPL-3.0 repo (working name `munder-sidestore`) for the companion. The alternatives are L4 (relicense parts of Munder Mobile) or accepting the cost of L3.
2. **SideSign provenance.** It has no LICENSE file, and its AGPL deps are unpinned. Accept pinning them by commit and filing an upstream issue asking for a LICENSE file, or wait for upstream.
3. **iBridge.** Sync it with upstream iloader, or retire the fork and point users at upstream iloader.
4. **Test device.** M2 onward needs a real iPhone (model and iOS version recorded) and an Apple Account that is free and ideally dedicated to testing. Mind the 3-app limit and certificate revocation.

## 10. Next milestones, once approved

- **M2:** in the new repo, sign a known `MunderMobile-unsigned.ipa`.
  - Use the `sidesign` CLI on a Mac, or AppleBridge's macOS runner **without credentials** for the fixture half.
  - Real signing uses Danny's account locally.
  - Receipt fields: `source_artifact_sha256`, `signed_artifact_sha256`, `bundle_id`, `profile_expires_at`, engine version and commit.
- **M3:** install through iloader's existing path. Munder writes nothing new for the bootstrap.
- **M4:** refresh on the device in `.localVPN` mode. Keychain continuity test (§7). VPN matrix from compose §20, including iOS 26.4+.
- **M5/M6:** the minimal UI; an update gated by artifact provenance (repo, workflow, commit, hash).
- **M8:** `.remoteServer` through a relay on the Munder office over Tailscale. Experimental.

## 11. Terminology for Munder docs

Say "personal development certificate", "on-device refresh", "device-local
communication path" and "Renovación de Munder Mobile". Do not repeat upstream's "trick iOS".

## 12. Classification

| Property | Status |
|---|---|
| iBridge = iloader@348eefd with no own changes | **DEMONSTRATED** (tree diff + commit identity) |
| iloader covers device, pairing, account, certificates, sign + install | **DEMONSTRATED** (source) |
| SideSign effective license is AGPL via deps | **DEMONSTRATED** (dep LICENSE files) |
| minimuxer is Swift, with `.remoteServer` mode | **DEMONSTRATED** (source) |
| iOS 26.4+ lockdown needs IKEv2 | **INFERRED** (minimuxer checks; no device) |
| Pairing key survives a same-team, same-bundle re-sign | **INFERRED** |
| `.remoteServer` through a Tailscale relay refreshes | **NOT_DEMONSTRATED** |
| Any on-device sign, install or refresh by Munder | **NOT_DEMONSTRATED** (M2–M4) |
| "The compose's minimuxer model is current" | **DESTROYED** (rewritten in Swift, new modes) |
| "SideSign is GPL-3.0" as the operative license | **DESTROYED** (AGPL deps) |

## 13. Rollback

This PR adds one document. Removing it changes nothing. The supported path
stays: unsigned IPA from CI, then iloader, SideStore or AltStore by hand.
