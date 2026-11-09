---
paths: ["modules/whiteboard/**", "tests/**/whiteboard*", "scripts/seed-demo-whiteboard.mjs", "modules/actions/pages/ActionWhiteboardsCard.svelte"]
---

# Modul `whiteboard` (Whiteboards, live gemeinsam bearbeiten)

Whiteboards mit **Live-Bearbeitung durch mehrere Personen**: Kacheln/Notizzettel und Formen in Farben, Text, **Verbinder** (gerade/gewinkelt/
gebogen, an Elemente gebunden), Freihand (Stift/Marker, Radierer), **Rahmen**, **Bilder und Dateien** (Upload ins Board), **Links**, **Karten** aus
anderen Modulen (Aktion, Aufgabe, Aufgaben-Board, Termin, Galerie, Datei aus „Dateien“, anderes Whiteboard), **Versionsverlauf**, Teilen an
Principals, **mehrere Boards je Aktion** (Zugriff vererbt), Export **PNG/SVG/PDF** und Archiv **`.epwhiteboard`** (Import), touch-tauglich.
Schema `mod_whiteboard`, v1.1.0 (2026-10-26), keine harten Abhängigkeiten, `optionalDependencies: ['members','actions','tasks','events','galleries','files','notes']`.
Navigation „Whiteboards“ (Icon `presentation`, `order` 76). Editor-Seite vollflächig über `ModuleUi.fullBleedRoutes: [':id']` (Core, 2026-10-26).

Nutzerentscheidungen (2026-10-26): Dateien **direkt hochladen und** aus „Dateien“ verknüpfen (als Karte, ohne Kopie); **mehrere** Whiteboards je
Aktion; erste Version **mit** Freihand, Live-Cursor/Anwesenheit, Rahmen, Versionsverlauf; Karten für Aufgaben, Termine, Galerien, Dateien, Aktionen.

## Architektur
- **Echtzeit = SSE + POST** (kein WebSocket: `node build`/adapter-node kennt kein Upgrade). `GET /boards/:id/live` → `text/event-stream` über den normalen
  API-Router (rohe `Response`), Heartbeat 20 s, `X-Accel-Buffering: no`; Änderungen per `POST /boards/:id/ops` (Client bündelt ~80 ms).
  Verteilung im **Prozess** (`live.ts`, `Map<boardId, Map<client, Subscriber>>`) → **nur eine App-Instanz** (mehrere bräuchten LISTEN/NOTIFY).
- **Zuletzt geschrieben gewinnt, je Element**: jede Änderung ersetzt die ganzen Daten, `version` +1; alle Änderungen einer Anfrage bekommen dieselbe
  neue Board-`seq` (unter `lockBoard`). Löschen = Grabstein (`deleted`), erneutes Schreiben stellt wieder her (Rückgängig). Wiederverbinden mit
  `since=<seq>` → nur Änderungen danach; `since < purged_seq` oder `> seq` → `hello.reset` (komplett neu laden).
- Client: eigene ausstehende Änderungen haben Vorrang (`sync.isPending`), Fremdänderungen nur mit höherer `version`. Gleichzeitiges Tippen im selben
  Element: Toast „X bearbeitet diesen Text gerade auch“ (Anwesenheit `editing`), sonst gewinnt das Letzte.
- **Eigener SVG-Renderer** (keine Fremd-Bibliothek außer `perfect-freehand` für Striche). Text wird selbst umbrochen (`text-layout.ts`, Canvas
  `measureText`) und als `<text>/<tspan>` gezeichnet – Export = dieselben Komponenten (`ExportSvg` per `mount`), Bilder als Data-URL eingebettet.
- Fläche folgt **Dunkelmodus und persönlichem Theme** (Nutzerwunsch 2026-10-26): durchsichtig (Theme-Hintergrund scheint durch), Farben aus einer
  `Palette` (`render.ts` `readPalette()` liest `--background/--foreground/--card/--border/--muted…`, `MutationObserver` am `<html>` liest bei jedem
  Wechsel neu; SVG-Attribute lösen keine CSS-Variablen auf). Fast schwarze „Tinte“ (`#1f2937` u. a.) wird im Dunkelmodus hell gezeichnet (`ink()`),
  Text ohne Füllung ebenso; Nutzerfarben (Notizen, Formen) bleiben. **Export immer hell** (`LIGHT`, druckbar). Keine Palettenklassen (Design-Guard).
- **Persönliche Flächenfarbe** (Nutzerwunsch 2026-10-26, v1.1.0, Migr. 0002): Tabelle `user_prefs(user_id PK, prefs jsonb)`, `GET/PUT /me/prefs`
  (`userPrefsInput`: `surface.mode` `fixed|theme`, `surface.color` `#rrggbb`). **Standard: feste weiße Fläche**; Knopf „Fläche einstellen“ (Farbeimer,
  unten rechts, `SurfaceMenu.svelte`): Schalter „Feste Flächenfarbe“, Weiß/Schwarz/eigene Farbe; aus = wie Modus/Theme. Gilt je Konto für alle Boards.
  Feste Farbe → `fixedPalette(color)` (dunkle Fläche: helle Tinte, dunkle Karten), Fläche deckend (`Canvas` `surface`). Löschen/Reset/Auskunft berücksichtigen
  `user_prefs`.

## Dateien (`modules/whiteboard/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (4 Rechte, **keine** `defaultRoleGrants`), Einstellung `whiteboard.storage.boardMb` (200), Jobs `snapshots` (stündlich) + `cleanup` (täglich), Hooks, Endpoints in `withBoardContext` (Reihenfolge boards → transfer → live → assets → snapshots/refs) |
| `schemas.ts` | Konstanten/Grenzen, **Element-Schemas je Typ** (`shapeData`, `connectorData`, `freehandData` mit `vw`/`vh`, `imageData`, `fileData`, `linkData` + `isAllowedLink`, `frameData`, `refData`), `parseElementData`, Ops/Presence/Live-Eingaben, DTOs, `LiveEvent`, `presenceColor`, Archiv-Konstanten |
| `access.ts` | `boardShareAccess`, `loadBoardContext`/`withBoardContext` (Schlüssel + `accessibleActions` **vor** der Tx), `resolveBoardAccess`/`requireBoardAccess`, `visibleBoardsFilter`, `boardAccessForMany`, `lockBoard` |
| `boards.service.ts` | Laden (`loadBoardRows`, `loadDetailRows`), Aufbau (`buildBoards`, `buildDetail`, `elementOf`, `liveElementOf`, `assetOf`), `boardLimitBytes` (**Core-Einstellung, nie in einer Tx**), `usedBytes` |
| `boards.endpoints.ts` | Boards, `/boards/recent`, `/boards/by-action/:actionId`, Freigaben, `/principals`; PATCH/PUT-Freigaben → `recheckBoard`, DELETE → `closeBoard` + Dateien weg |
| `ops.service.ts` | `checkOps` (Zod je Typ, ≤ 64 KB/Element, 422 Pfad `ops.<i>.data…`), `writeOps` (Sperre, Asset-Prüfung, `seq`, Grenze 5000 → 409), `applyOps` (+ Verteilen) |
| `live.ts` / `live.endpoints.ts` | Hub (`openStream`, `broadcast`, `updatePresence`, `recheckBoard`, `closeBoard`, ≤ 20 Streams je Konto), Endpunkte `live`, `ops` (1200/60 s), `presence` (1500/60 s) |
| `assets.service.ts` / `assets.endpoints.ts` | Upload (Bilder → `core.images.process` thumb 640/web 2000 WebP ohne Metadaten; Dateien nach Allowlist + Magic Bytes, PDF-Vorschau über `core.pdf.renderPage`), Speicherplatz je Board, Auslieferung `GET /boards/:id/assets/:assetId/thumb|web|file` (`IMAGE_RATE_LIMIT`) |
| `storage.ts` | Systemkontext `whiteboard-files`, Pfade `boards/<boardId>/<assetId>-<variant>`, `removeFiles`, `fileResponse` |
| `refs.service.ts` | Karten **je Betrachter*in** über die Verträge (`ActionsService`, `TaskRefsService`, `EventRefsService`, `GalleryRefsService`, `FileRefsService`, `NoteRefsService` – Karte „Notiz“, Typ `note`, Icon `notebook-pen`, Unterzeile = Textanfang); gespeichert wird nur Typ + ID |
| `embeds.ts` | Core-Einbetten (`ModuleDefinition.embeds`, Art `board`): Suche/Auflösung sichtbarer Boards je Betrachter*in, Pfad `<id>` → `/embed/whiteboard/<id>`; Seite `pages/EmbedBoardPage.svelte` (`ui.ts` `embedRoutes`) = Editor mit `embedded` (kein Rücklink/Freigabe/Eigenschaften/Löschen, „Vollbild öffnen“ mit `target=_top`, nur Ansicht bei read) |
| `snapshots.service.ts` / `snapshots.endpoints.ts` | Versionen (auto ≤ 50, benannt ≤ 100), Wiederherstellen (sichert vorher „Vor dem Wiederherstellen“, schreibt per `writeOps`, dann `reset`), Jobs `runAutoSnapshots`, `runCleanup` (Grabsteine > 30 Tage → `purged_seq`; ungenutzte Dateien > 24 h); dazu `/refs`, `/refs/describe` |
| `archive.ts` | `.epwhiteboard` (ZIP: `board.json` + `assets/<uuid>`), `parseArchive` mit Grenzen, keine ZIP64, Pfad-Allowlist |
| `prefs.endpoints.ts` | Persönliche Ansicht-Einstellungen `GET/PUT /me/prefs` (je Konto, für alle Whiteboards, z. B. feste Flächenfarbe) |
| `transfer.endpoints.ts` | Export (Archiv), Import (immer neues Board, Bilder neu verarbeitet, Dateien neu geprüft, IDs der Dateien neu), PDF aus Browser-Seiten (`page0…`, Deckblatt + je Seite eine Bild-Anlage über `core.pdf`, ≤ 20 Seiten, 8 MB/55 MB) |
| `privacy.ts`, `search.ts`, `notify.ts` | Löschen/Reset/Auskunft, Suche (Boards + Rahmentitel, `?focus=`), `board-shared` |
| `pages/BoardsPage.svelte`, `BoardDialog.svelte`, `BoardPage.svelte`, `widgets/RecentBoardsWidget.svelte` | Übersicht + Import, Anlegen/Eigenschaften (Aktion nur Eigentümer*in), Laden, Dashboard-Kachel |
| `pages/editor/` | **rein**: `geometry.ts`, `connectors.ts`, `text-layout.ts`, `viewport.ts`, `freehand.ts`, `bounds.ts`, `render.ts`, `export.ts`; **Zustand**: `store.svelte.ts` (Elemente, Auswahl, Rückgängig/Gesten `begin/preview/end/cancel`), `sync.svelte.ts` (EventSource, Bündeln, Wiederholen, Presence), `controller.svelte.ts` (Werkzeuge, Pointer/Touch/Stift, Griffe, Zwischenablage); **UI**: `Editor`, `Canvas`, `ElementView` (+ `ShapeView`, `ConnectorView`, `FreehandView`, `CardView`), `Toolbar`, `PropertiesBar`, `ColorButton`, Dialoge `ExportDialog`, `HistoryDialog`, `RefPicker`, `LinkDialog`, `ExportSvg` |

Außerhalb: `actions/pages/ActionWhiteboardsCard.svelte` (nur REST, in `ActionDetailPage` mit `whiteboard.board.view`), Verträge `tasks/contract.ts` +
`refs.service.ts`, `files/contract.ts` + `refs.service.ts`, `galleries/contract.ts` (`searchGalleryCards`/`describeGalleryCards`), Core
`ModuleUi.fullBleedRoutes` (`sdk/types/module-ui.ts`, Catch-all `+page.ts` → `fullBleed`, `(internal)/+layout.svelte`), Icon `presentation`,
nginx-Location für `…/live`.

## Rechte und Zugriff
`whiteboard.board.view` (Grundrecht), `.create` (anlegen/importieren), `.view-all`, `.edit-all`. Bearbeiten: Eigentümer*in, Freigabe `edit`, Aktion mit
Bearbeiten-Zugriff, `edit-all`. Lesen: Freigabe `read`, Aktion lesbar, `view-all`. Teilen/Löschen/Aktion wechseln: Eigentümer*in/`edit-all`. Fremd → 404.
Live-Verbindungen prüfen beim Start, alle 60 s und sofort nach Freigabe-/Aktionswechsel (`revoked` schließt, `access` meldet neue Stufe).
Assets nur über das eigene Board (Asset-ID gehört zum Board, sonst 422 bei Ops / 404 beim Abruf).

## Bedienung (Editor)
Werkzeuge V Auswählen · H Hand · N Notiz · R Form (Popover: Rechteck, abgerundet, Ellipse, Raute, Dreieck, Sechseck, Stern, Sprechblase, Wolke) ·
T Text · L Verbinden · P Stift · M Marker · E Radierer (nur Freihand) · F Rahmen; „+“: Bild/Datei hochladen, Link, Karte, Aus „Dateien“.
Auswahl: Klick/Umschalt, Auswahlrechteck (Maus), Strg+A; Griffe für Größe (Bilder/Freihand halten das Seitenverhältnis, Umschalt löst), Drehen
(Einrasten 90°/mit Umschalt 15°), **Verbinden-Griffe** rechts/unten/links an Formen; Verbinder: Endpunkte umhängen, Knick-Griff. Doppelklick/-tippen:
Text bearbeiten (Form), Titel (Rahmen), Beschriftung (Verbinder), Öffnen (Link/Karte/Datei); auf leerer Fläche (Maus) neue Notiz.
Touch: 1 Finger leer = Ansicht verschieben, 2 Finger = Zoom/Verschieben, Long-Press = Kontextmenü, Stift zeichnet (Touch 800 ms danach ignoriert),
Griffe größer bei `pointer: coarse`. Tastatur: Entf, Strg+Z/Y/D/C/X/V, Pfeile (Umschalt = 10), 0 = 100 %, 1 = alles zeigen, Leertaste+Ziehen.
Einfügen aus der Zwischenablage: eigene Elemente, Bilder/Dateien (Upload), URL → Link, Text → Notiz. Dateien per Drag & Drop aus dem System.
**Schnelle Notizen** (Nutzerwunsch 2026-10-26): Notiz-Werkzeug zeigt Farbwahl für die nächste Notiz; Antippen einer schon allein ausgewählten
Form/Notiz öffnet die Texteingabe (`tapEdit`); „+“-Griffe rechts/unten/links: **Klick** = neue Notiz gleicher Art/Farbe/Größe daneben, mit Pfeil
verbunden (`spawnNext`), **Ziehen** = verbinden; **Tab** beim Schreiben = nächste Notiz rechts (Umschalt+Tab darunter, ohne Pfeil); Doppeltippen
auf leere Fläche (auch Touch) = Notiz. Neue Notizen: `autoFit` (Schrift schrumpft bis 8 px), neue Textfelder: `autoHeight` (Höhe wächst/schrumpft beim
Tippen, `textHeight`). **Text-Menü** (`TextSettings.svelte`, Knopf „Text einstellen“): Schriftart `sans|serif|mono|hand` (nur Systemschriften,
`FONT_STACKS`), Größe 8–160 (Stepper + S…XXL), waagrecht/senkrecht ausrichten, fett/kursiv/unterstrichen/durchgestrichen, Automatik-Schalter.
Ältere Elemente bekommen die neuen Felder per Schema-Standardwert (`store.load` normalisiert über `parseElementData`).
Rahmen nehmen beim Verschieben/Kopieren vollständig enthaltene Elemente mit. Löschen eines Elements löst angehängte Verbinder (Ende bleibt stehen).

## Grenzen
5000 Elemente/Board, 64 KB/Element, Text 5000 Zeichen, 3000 Punkte/Strich, 500 Ops/Anfrage, Koordinaten ±1 000 000, Zoom 10–400 %,
Datei 25 MB, Speicher je Board `whiteboard.storage.boardMb` (Standard 200 MB), Import 100 MB, PDF 20 Seiten.

## Audit
`whiteboard.board.created|updated|deleted|shared|imported|exported|restored`, `whiteboard.asset.uploaded`, `whiteboard.snapshot.created` – nur IDs/Zähler/
Feldnamen, **keine** Texte oder Dateinamen. Element-Änderungen werden nicht auditiert (zu häufig).

## Tests
Integration `tests/integration/whiteboard.test.ts` (26 Fälle, **ohne** `members`/`actions`: Zugriffsmatrix mit Rollen-/Benutzer-Freigabe,
Gruppen-/Mitglieds-Freigabe → 422, Boards an Aktionen → 422/404, Aktions-Karten nicht verfügbar, Ops/Versionen/Grabsteine, Validierung, SSE mit
Anwesenheit/`since`/`revoked`/`access`, Bild-Upload + Auslieferung, Versionen + `reset`, Export → Import, manipulierte Archive,
PDF, Karten je Betrachter*in, Aufräum-Job + `hello.reset`, Audit, Konto löschen, Modul aus). Mit `members`/`actions` (Gruppen-Freigabe,
mehrere Boards je Aktion, `/boards/by-action`, Aktions-Karten): `ep-intern-modules/modules/_integration/tests/integration/whiteboard-actions.test.ts`. Unit `whiteboard-editor.test.ts`, `whiteboard-archive.test.ts`.
E2E `tests/e2e/whiteboard.spec.ts` (Notiz tippen, live im zweiten Browser, Verbinder, Rückgängig/Wiederholen bei beiden, Neuladen, Touch-Pinch, PNG/PDF,
Board aus der Aktion). Demo: `node scripts/seed-demo-whiteboard.mjs`.

## Fallen
- Core-Dienste (Einstellungen, Storage, Bilder) **nie** in `mdb().transaction` – `boardLimitBytes()` vorher holen (PGlite hängt sonst; im Test passiert).
- Router: `POST` antwortet 201; JSON-Grenze 1 MB → der Client bündelt höchstens ~800 KB/400 Ops.
- `core.pdf`-Bildblöcke sind auf 150 mm/2 MB begrenzt → PDF-Export über **Anlagen** (seitenfüllend) mit Deckblatt.
- SVG mit `role="application"` + `tabindex` braucht `svelte-ignore a11y_no_noninteractive_tabindex`.

## Offen
- Mehrere App-Instanzen nicht unterstützt (Hub im Prozess). Traefik/Dokploy-Verhalten bei SSE nach Deploy ungeprüft; echte Geräte (iPad/Android-Stift),
  echtes S3 für Board-Dateien und Safari-Export (SVG→Canvas) ungeprüft.
- Kein Gruppieren, Ausrichten/Verteilen, Raster-Einrasten, Kommentare, Vorlagen; Text ohne Rich-Text; gleichzeitiges Tippen im selben Element ohne
  Zusammenführen (Letztes gewinnt); Drehen mehrerer Elemente gemeinsam nicht möglich (nur einzeln).
- Rahmen-/Kartentexte im Export nutzen die Systemschrift des exportierenden Geräts. Export ignoriert Dunkelmodus/Theme (immer hell).
