<!-- Notas del release del fork. Se publican tal cual como cuerpo del GitHub Release. -->
# Munder Difflin Fork ISyCo v0.5.2-ISyCo.1

Build del fork [DannyBaanks/munder-difflin](https://github.com/DannyBaanks/munder-difflin),
al día con el upstream (su HEAD del 18 sep: incluye su `v0.5.2` del 9 sep más
63 commits de sitio/blog — la app es 0.5.2 tal cual) más todo lo ISyCo.
Detalle en el [README](./README.md).

## Lo del upstream 0.5.2 (traducido)

- **Tu nombre llega a tu equipo.** Los nombres de los agentes viajan sellados.
- **El "no recibo" se le dice al remitente.** En el relay.
- **Quién responde.** Un ajuste, Slack y compañeros.
- **Se acaban los rebotes.** El arranque espera la restauración.
- **Michael, más corto.** Terminales, memoria y el composer de los agentes.

## Lo ISyCo de este build

1. **Español primero** — selector al onboarding, `es.json` completo.
2. **Canal de control local** (`127.0.0.1` + token): `munder ctl ping`,
   `GET /salud`, `GET /sesion`, `POST/DELETE /sesion/agentes`, repaint sin restart.
3. **Launcher Linux** `./start.sh` despegado (adiós freeze SIGTSTP), sesiones
   paralelas con `--user-data-dir`.
4. **Supervisión de entrega** — el router se rearma solo si el outbox se para;
   el breaker ya no confunde un evento sin `tool_input` con un loop.
5. **Canvas + terminal Linux** — repintado tras muerte de GPU, abrir la
   terminal de verdad en vez de `open -a`.
6. **Harness usable + avatar compilado** — crear configs, `.gitignore` auto,
   `composeAvatar` compartido app↔CLI (mismo texto = mismo PNG).
7. **Catálogo + Office Bridge MCP** — familia `openisy`, 5 tools locales.
8. **CLI `munder`** — sin `npm run dev`: `start/stop/status/sesion/avatar/ctl`.
   Instala: `./tools/munder/install.sh`.
9. **Avatar persistente** — `munder avatar inyectar "tu desc" --slot auto`
   y tu cara entra al piso como un worker más (cuerpo prestado).
10. **Munder Link** — un Michael le delega al otro por LAN/Tailscale
    (`munder link conectar`), firmado y cifrado, código de 6 dígitos.

## Instalar

Descargas abajo: Windows `.exe` (instalador o portable), Linux `.AppImage`.
`SHA256SUMS.txt` para verificar lo descargado:

```bash
sha256sum -c SHA256SUMS.txt
```

Sin firma (builds de contribuidor): Windows mostrará SmartScreen y Linux
pedirá marcar el AppImage como ejecutable — normal.
El `.dmg` de mac sale por CI en los tags (aquí no hay runner Apple).

Pre-release a propósito: página pública para descargar, sin ofrecerse solo
por el auto-updater. El updater de estos builds apunta a este repo, no al
upstream.
