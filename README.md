# Atrium – Basismodule für Kalypzo Atrium

Allgemeine Basismodule für die Plattform [Kalypzo Atrium](https://github.com/KalypzoSolutions/kalypzo-atrium) (Core, eigenes Repo).
Alle Module liegen unter `modules/<id>/`, der Katalog unter `modules/atrium-modules.json`.
Herkunft: umgezogen aus [`ep-intern-modules`](https://github.com/Stamm-Edelweisspiraten/ep-intern-modules) (Stand `e300d71`).

| Modul | Inhalt |
|---|---|
| `files` | Dateien (Cloud-Ablage, Freigaben, öffentliche Links) |
| `notes` | Notizen (live gemeinsam schreiben, Export) |
| `tasks` | Aufgaben (Kanban, Phasen, Zeitleiste) |
| `whiteboard` | Whiteboards |
| `events` | Termine (Serien, Tags, Freigabe, Website-API, Kalender-Abo) |

Alle Abhängigkeiten zu anderen Modulen (`members`, `actions`, `galleries` … aus `ep-intern-modules`) sind **optional**.

## Installation auf einem Server

Administration → Module → **Installieren** → Link `https://github.com/<org>/atrium-basic-modules/tree/<commit>/modules`
(oder ZIP dieses Repos) → Module auswählen. Für frische Deployments: Seed (`ATRIUM_MODULES_SEED`, siehe
`docs/deployment.md` im Core).

## Entwickeln

Der Core ist als Git-Submodul `.core` auf einen festen Stand gepinnt.

```bash
git clone --recurse-submodules <url> && cd atrium-basic-modules
npm run setup        # Core-Abhängigkeiten, node_modules-Link, Pakete der Module
npm run check        # Typprüfung (Core + Module)
npm test             # Tests der Module (Vitest, PGlite)
npm run build        # Produktions-Build
npm run e2e          # Playwright
npm run demo         # Demo-Server http://localhost:4300 mit diesen Modulen
npm run check:catalog && npm run check:migrations
```

Core aktualisieren: `git -C .core fetch --tags && git -C .core checkout <tag>`, dann `npm run setup -- --force`, prüfen, committen.
Angewendete Migrationen sind unveränderlich (`check:migrations` vergleicht mit dem letzten Tag dieses Repos).

Regeln für die Arbeit an Modulen: `.core/.claude/rules/modules.md` (Muster, Rechte, Endpunkte) und `.claude/rules/module-<id>.md`.
