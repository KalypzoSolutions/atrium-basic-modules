---
paths: ["modules/notes/**", "tests/**/notes*", "scripts/seed-demo-notes.mjs", "modules/actions/pages/ActionNotesCard.svelte", "src/lib/sdk/server/live-hub.ts", "src/lib/server/core/embeds/**", "src/routes/embed/**", "src/lib/sdk/types/embeds.ts"]
---

# Modul `notes` (Notizen, live gemeinsam bearbeiten)

Notizen als **Seitenbaum** (Unterseiten beliebig bis 10 Ebenen) mit **Live-Bearbeitung durch mehrere Personen** (Yjs/CRDT, Cursor der anderen),
formatiertem Editor (Tiptap 3) mit **Markdown-Kürzeln**, eingefügtem Markdown und umschaltbarer **Quelltext-Ansicht**, Werkzeugleiste (fett, kursiv,
unterstrichen, durchgestrichen, Schriftgröße, Farbe/Markierung, Ausrichtung, Listen/Aufgaben, Zitat, Code, **Tabellen**, Link, Bild, Trennlinie),
Slash-Menü (`/`), **Bilder** (Upload/Einfügen/Ziehen, Größe per Griff), **eingebettete Whiteboards** (live bearbeitbar, Core-Mechanismus „Einbetten“),
Teilen an Principals (vererbt auf Unterseiten), Notizen je **Aktion**, Versionen, Papierkorb, **Export** `.md`/`.zip`/`.html`/`.docx`/`.pdf` und Import
`.md`/`.zip`. Schema `mod_notes`, v1.4.0 (2026-11-04, Nummerierungsarten + große Notizen), keine harten Abhängigkeiten, `optionalDependencies: ['members','actions']`.
Navigation „Notizen“ (Icon `notebook-pen`, `order` 72), Editor vollflächig (`fullBleedRoutes: [':id']`).

Nutzerentscheidungen (2026-10-29): eigenes Modul (nicht in „Dateien“); formatierter Editor mit Markdown-Kürzeln **plus** Quelltext-Umschalter;
**Seitenbaum** mit vererbter Freigabe; Whiteboard **live + bearbeitbar** einbetten (generischer Core-Mechanismus); Export .md (+ .zip mit Bildern), .pdf,
.docx, .html.

## Architektur
- **Inhalt = Yjs-Dokument** (Fragment `default`, Schema aus `doc/extensions.ts` – Server UND Browser, Browser ergänzt nur Verhalten/Node-Views, nie
  Knoten/Marks). Gespeichert: `notes.ydoc` (verdichtet) + `note_updates` (Einzel-Updates seit der Verdichtung). Abgeleitet (5 s verzögert):
  `content_json` (über das Schema, ungültige Blöcke fallen weg) und `content_text` (Suche/Vorschau, Volltextindex `german`).
- **Transport wie Whiteboard**: SSE `GET /notes/:id/live` (Hub `live.ts` über den SDK-Baustein `$lib/sdk/server/live-hub.ts` `createLiveHub`, Heartbeat,
  Recheck 60 s, ≤ 30 Streams je Konto) + Änderungen per `POST /notes/:id/updates` (Body = **ein rohes Yjs-Update**, `application/octet-stream`, ≤ 5 MB,
  umgeht das 1-MB-JSON-Limit des Routers) + Awareness `POST /notes/:id/awareness` (nur weitergereicht). Start: `GET /notes/:id/state?sv=` (binär,
  nur fehlende Änderungen, Header `x-yjs-state-vector` + `x-note-level`) → Client schickt eigene fehlende Änderungen nach (offline bearbeitet).
- **Server-Dokument** (`doc.service.ts`): je geöffneter Notiz ein `Y.Doc` im Speicher (nach 5 min ohne Verbindung entladen), Schreiben unter einer
  Sperre je Notiz (`withDocLock`): dekodieren (kaputt → 422) → speichern → anwenden → verteilen; ab 200 Updates (große Notizen später, `compactThreshold`: je 4 KB Zustand ein Update, ≤ 2000) bzw. stündlich (Job) verdichten; Ableiten
  verzögert je 256 KB um 5 s mehr (≤ 60 s, `deriveDelayMs`).
  Grenze 20 MB je Notiz (413 „Teile sie in Unterseiten auf“). **Nur eine App-Instanz** (Dokumente und Hub im Prozess).
- **Bilder** speichern im Dokument nur `assetId` (`image`-Knoten), die Adresse baut der Renderer (`assetUrl`), eine freie `src` wird nie ausgegeben;
  Markdown `![alt](asset:<id>)`. **Einbettungen** `embed { module, kind, refId, height }`, Markdown `:::embed {module="…" kind="…" refId="…" height="…"} :::`.
- Rückgängig/Wiederholen über den Yjs-UndoManager (nur eigene Änderungen); Wiederherstellen einer Version = eine Server-Transaktion auf dem Live-Dokument
  (`replaceContent`), offene Editoren übernehmen sie ohne Neuladen.

## Dateien (`modules/notes/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (6 Rechte inkl. `notes.link.create`, **keine** `defaultRoleGrants`), Jobs `versions` (stündlich: verdichten + automatische Versionen) und `purge-trash` (täglich), Hooks, `provides` `NoteRefsService`, Endpoints in `withNoteContext` (transfer → notes → live → assets → versions) |
| `schemas.ts` | Vertrag: Konstanten/Grenzen, Zod (`noteCreateInput` mit `markdown`, `noteUpdateInput`, `moveInput`, `stateQuery`, `liveQuery`, `updatesQuery`, `awarenessInput`, `sharesInput`, `exportQuery` …), DTOs (`NoteNode`, `NoteDetail`, `NoteRoots`, `NoteShares` mit `inherited`, `NoteVersion`, `TrashItem`, `NoteAsset`, `Peer`), `LiveEvent`, `presenceColor` |
| `access.ts` | Zugriff mit **Vererbung über die Oberseiten-Kette** (`chainOf`, `resolveNoteAccess`, `requireNoteAccess(…, 'read'|'edit'|'share', { includeDeleted })`), Liste `accessForMany` (ein CTE), `visibleNotesSql`, `notInTrashSql`, Teilbaum-Hilfen, Sperren `lockNote`/`lockRoots`, `loadNoteContext`/`withNoteContext` (Schlüssel + `accessibleActions` **vor** der Tx) |
| `db.ts` | `mdb`, `filesCtx` (Systemkontext `notes-files`), `userRefs`/`refOf` |
| `doc.service.ts` | Yjs im Speicher: `applyClientUpdate`, `stateFor`, `fullState`, `currentJson`, `stateFromJson`, `jsonFromState`, `replaceContent`, `flushNote`/`flushAll`, `dropDoc`, Test-Hilfen |
| `live.ts` / `live.endpoints.ts` | Hub (`hub`, `peersOf`, `recheckNotes`, `closeNotes`), Endpunkte `state`, `live`, `updates` (1200/60 s), `awareness` (1500/60 s) |
| `state-response.ts` | Antwort für `…/state` (intern + Gast): ab 32 KB gzip, `no-store` (`stateResponse`, `acceptsGzip`) |
| `notes.endpoints.ts` / `tree.service.ts` | Wurzeln (eigene/geteilt/Aktionen), zuletzt bearbeitet, Suche, Papierkorb, `by-action`, Principals, CRUD, Kinder, Verschieben, Freigaben; Aufbau der DTOs, Positionen, Teilbaum |
| `trash.service.ts` | `purgeExpiredTrash` (Job, ≤ 200 je Lauf), `afterPurge` (Dateien, Dokumente, Streams) |
| `assets.service.ts` / `assets.endpoints.ts` / `storage.ts` | Bild-Upload (`core.images.process` thumb 640 / web 2000 WebP ohne Metadaten), Auslieferung `GET /assets/:assetId/:variant` (Zugriff über die Notiz des Assets, `IMAGE_RATE_LIMIT`), Pfade `notes/<noteId>/<assetId>-<variant>.<ext>` |
| `versions.service.ts` / `versions.endpoints.ts` | Versionen (auto ≤ 50, benannt ≤ 100), Vorschau (`content` = PM-JSON), Wiederherstellen (sichert vorher „Vor dem Wiederherstellen“), `runAutoVersions` |
| `transfer.endpoints.ts` + `export/*` | Export `GET /notes/:id/export?format=md|zip|html|docx|pdf&subpages&letterhead` (`collect.ts` ≤ 300 Seiten/200 MB Bilder, `markdown.ts`, `zip.ts`, `html.ts` eigener Serialisierer mit Allowlist, `docx.ts`, `pdf.ts` über Core-Block `richText`, `embeds.ts`), Import `POST /notes/import` (`import.ts`: .md/.txt/.zip, Ordner → Unterseiten, Bilder neu verarbeitet, ZIP-Grenzen 500 Einträge/200 MB, kein `..`) |
| `prefs.endpoints.ts` | Persönliche Ansicht `GET/PUT /me/prefs` (Migr. 0002 `user_prefs`): Hintergrund `surface.mode` `theme` (Standard) oder `fixed` + `surface.color`; UI `pages/SurfaceMenu.svelte` (Farbeimer im Kopf, Weiß/Papier/Schwarz/eigene Farbe), Palette `pages/surface.ts` (`surfaceVars` überschreibt die Tokens nur im Bereich Leiste+Titel+Text, dunkle Fläche → helle Schrift) |
| `privacy.ts`, `search.ts`, `notify.ts`, `refs.service.ts`, `contract.ts` | Löschen/Reset/Auskunft, globale Suche, `note-shared`, `NoteRefsService` (Karte „Notiz“ im Whiteboard) |
| `doc/extensions.ts`, `doc/text.ts` | Schema (`noteExtensions`, `noteSchema`, `noteImage`, `Embed`, `assetUrl`), Klartext/Assets/Einbettungen aus PM-JSON |
| `ui.ts`, `pages/**` | Übersicht, Editor-Seite mit Seitenbaum, Editor (`pages/editor/`: `sync.svelte.ts` Yjs-Provider über SSE, `NoteEditor`, `Toolbar`, `SlashMenu`, `BubbleMenu`, `SourcePanel` + `source-diff.ts`, `EmbedView`/`EmbedPicker`, Node-Views), Dialoge, Dashboard-Kachel |

Außerhalb: `actions/pages/ActionNotesCard.svelte` (REST, in `ActionDetailPage` mit `notes.note.view`), Whiteboard-Karte `note` und Einbettung
(`whiteboard/embeds.ts`, `pages/EmbedBoardPage.svelte`), Core `core.embeds` + `/api/v1/embeds*` + Route `/embed/<modul>/<pfad>` (`src/routes/embed/`,
`core/internal-pages.ts`, Header `SAMEORIGIN` + `frame-ancestors 'self'` nur dort), PDF-Block `richText` (`sanitizeDocumentHtml`), Icon `notebook-pen`.

## Rechte und Zugriff
`notes.note.view` (Grundrecht), `.create` (eigene Wurzeln anlegen/importieren), `.view-all`, `.edit-all`. Bearbeiten: Eigentümer*in (der Seite oder einer
Oberseite), Freigabe `edit` auf der Seite **oder einer Oberseite**, Aktion der Wurzel mit Bearbeiten-Zugriff, `edit-all`. Lesen: Freigabe `read`, Aktion lesbar,
`view-all`. **Teilen, Löschen, Aktion wechseln, aus dem Teilbaum verschieben: nur Eigentümer*in/`edit-all`** (Bearbeiten-Freigabe reicht nicht – wie `files`).
Mit Bearbeiten-Freigabe nur verschieben, wenn sich niemandes Zugriff ändert: gleiche Eigentümer*in, gleiche Aktion der Wurzel, **gleiche vererbte
Freigaben** der alten und neuen Oberseiten (`sameInheritedShares`), keine Wurzel unter eine Seite (2026-10-29, Review PR #136).
Unterseiten gehören der Eigentümer*in der Wurzel; Verschieben in einen fremden Teilbaum wechselt die Eigentümer*in des Teilbaums. Fremd/Papierkorb → 404.
Live-Verbindungen prüfen beim Start, alle 60 s und sofort nach Freigabe-/Aktions-/Ortswechsel (`recheckNotes(subtreeIds)`). Die Neuprüfung löst
Sitzung/API-Key, Konto und Rechte **neu** auf (`refreshLiveContext` im SDK-Hub; abgemeldet/deaktiviert → `revoked`). Eine fremde `client`-Kennung
übernehmen → 409. `/awareness` lädt keinen Zugriffskontext, `/updates` nutzt ihn bis 5 s je Person/Rechte wieder (`loadNoteContextCached`).

## Grenzen
Titel 200, Tiefe 10, 500 Unterseiten je Seite, 20 MB Yjs-Zustand je Notiz, Update 5 MB, Bild 25 MB, Import 50 MB, Export 300 Seiten, 200 Freigaben,
30 Live-Streams je Konto, Papierkorb 30 Tage, Einbettungshöhe 160–1600 px.

## Audit
`notes.note.created|updated|moved|trashed|restored|purged|shared|exported|imported`, `notes.asset.uploaded`, `notes.version.created|restored|deleted` – nur
IDs/Zähler/Formate, **keine** Inhalte oder Titel. Einzelne Text-Änderungen werden nicht auditiert.

## Tests und Demo
Integration `tests/integration/notes.test.ts` (Zugriffsmatrix inkl. Vererbung/Aktion, Yjs-Konvergenz zweier Clients, SSE, Verdichtung, Versionen,
Bilder, Papierkorb, Suche, Audit), `notes-transfer.test.ts` (alle Exportformate, Import inkl. manipulierter ZIPs), `core-embeds.test.ts`; Unit
`notes-doc`, `notes-text`, `notes-export`, `notes-source-diff`, `pdf-rich-text`; E2E `tests/e2e/notes.spec.ts`.
Demo: `node scripts/seed-demo-notes.mjs` (Beispielnotiz mit Unterseiten; `--big` = große Notiz für den Lasttest).

## Fallen
- **Zwei `prosemirror-model` im Produktions-Build**: `@tiptap/y-tiptap` ist Modul-Paket und wird samt eigener Kopie gebündelt. Nie
  `prosemirrorJSONToYXmlFragment` auf dem Server – `writeJson` in `doc.service.ts` baut den Knoten mit `noteSchema()` und ruft
  `prosemirrorToYXmlFragment` (sonst „Can not convert … to a Fragment“: neue Notiz mit Inhalt, Import, Version wiederherstellen). Tritt nur im Build auf.
- **`@tiptap/y-tiptap` auf 3.0.9 festgehalten** (2026-11-04): ab 3.0.10 zählt die „position migration“ bei jeder strukturellen Änderung
  (Enter, Löschen über Blöcke, Einfügen) alle Zeichen des Dokuments durch – ~1 s je Enter bei ~1500 Blöcken, ×4 auf Tablets – und legt die
  Root-Map `__tiptap_position_migrations:*` an (wächst ~1,4 KB je Änderung). Vor einem Update messen (Playwright, große Notiz, CPU ×4).
- **Markdown-Tokenizer** (`doc/extensions.ts`): Tiptaps Tabelle, Einbettung und Aufgabenliste prüfen an jeder Blockgrenze den ganzen Rest
  (quadratisch, 12 000 Blöcke ≈ 9 s). `NoteTable`/`NoteTaskList`/`embedStart` prüfen nur den Anfang. Neue Markdown-Erweiterungen genauso
  absichern (Test `notes-large.test.ts`).
- Client: `/state` wird beim Verbinden sofort geholt (nicht erst nach `hello`), Abgleiche laufen nacheinander (`requestSync`); Antwort ab 32 KB
  gzip (`state-response.ts`). Endgültig abgelehnte Änderungen (400/409/413/422) → Toast + Serverstand neu laden (sonst laufen Client und
  Server still auseinander: `Gespeichert`, nach dem Neuladen weg).
- **Kein `content-visibility: auto`** im Editor: Safari (iPad/iPhone) zeichnet übersprungene Blöcke im contenteditable nach Änderungen nicht neu
  (Zeilen verschwanden nach Enter, 2026-10-29) und es schneidet die Namensschilder fremder Cursor ab.
- `doc.service`-Funktionen und Core-Dienste **nie** in `mdb().transaction` (PGlite hängt).
- Lesen ohne Live-Bearbeitung (Export, Aufräumen) über `snapshotJson` (lädt nicht in den Speicher), nie `currentJson`.
- Zurücksetzen/Wiederherstellen → `onDataReplaced` → `discardAllDocs` (Speicher verworfen, Editoren bekommen `reset`); Deaktivieren sichert vorher.
- Ungenutzte Bilder: Tagesjob `purge-trash` löscht Bilder, die seit 7 Tagen in keinem Notizinhalt und keiner Version ihrer Notiz vorkommen
  (`purgeUnusedAssets`).
- Neue Knoten/Marks nur in `doc/extensions.ts` – sonst verwirft der Server sie beim Ableiten und Export.
- Router: POST antwortet 201; `updates` braucht `content-type: application/octet-stream` (kein JSON).

## Offen
- Mehrere App-Instanzen nicht unterstützt; SSE hinter Traefik, echte Tablets/Safari, echtes S3 und echtes Chromium-PDF nach Deploy prüfen.
- Einbettungen bleiben in Export/Import nur als Link erhalten.

## KI-Schreibhilfe (2026-10-29, v1.2.0)
`assist.ts`: Recht `notes.ai.use` (keine Standard-Vergabe), Kontext `notes:note` (Titel, Oberseiten, Aktion; Zugriff über `resolveNoteAccess`, fremd 404).
Textstellen `note-selection` (markierter Abschnitt: umformulieren, kürzen, einfache Sprache, Rechtschreibung, Englisch, zusammenfassen, Aufgaben ableiten)
und `note-write` (ohne Auswahl, ganze Notiz als Klartext ≤ 18 000 Zeichen: Entwurf, Zusammenfassen, Weiterschreiben, Aufgaben ableiten), beide
`richTables` (Tabellen bleiben im HTML). UI `pages/editor/NoteAssist.svelte`: Knopf „Schreibhilfe“ in der `Toolbar`, ✦ in der `BubbleMenu`, Eintrag im
Slash-Menü – nur mit Recht und eingerichteter KI. Auswahl → **Ersetzen** (ein Undo-Schritt, Yjs führt die Auswahl bei Fremdänderungen mit), sonst
**Einfügen** an der Cursorposition; Aufgaben als Aufgabenliste (`taskList`). Nie die ganze Notiz ersetzen (Live-Bearbeitung). Bilder/Einbettungen/Code
in der Auswahl gehen beim Ersetzen verloren → Hinweis im Blatt. Tests in `tests/integration/ai-assist.test.ts` („Notizen“).

## Öffentliche Links (2026-11-01, v1.3.0, Migr. 0003)
Nutzerentscheidungen: Link gilt für die Seite **mit allen Unterseiten**; Schutz **wie bei Dateien** (optionales Ablaufdatum + Passwort,
widerrufbar, URL jederzeit kopierbar, Fehlversuchssperre); Gäste werden **nach ihrem Namen gefragt** (optional, im Browser gemerkt,
Cursor „<Name> (Gast)“, sonst „Gast“); Gäste mit Bearbeiten-Link schreiben **nur Text** – keine Bild-Uploads, Einbettungen (nur Hinweis),
Unterseiten, Titel, Versionen, Export, KI.
- Tabelle `note_links` (Token nur als HMAC-Hash `token_hash` + verschlüsselt `token_enc`, `level read|edit`, `expires_on`, scrypt-`password_hash`,
  Fehlversuchszähler, Zugriffe). Backup-Hook `backup.ts` (Hash neu aus `token_enc`). Recht **`notes.link.create`** (keine Standard-Vergabe);
  verwalten nur Eigentümer*in/`edit-all` (Bearbeiten-Freigabe reicht nicht → 403), fremd 404, ≤ 20 aktive je Notiz.
- Dienst `links.service.ts`, Endpunkte `links.endpoints.ts`: intern `GET/POST /notes/:id/links`, `DELETE /links/:linkId` (in `withNoteContext`);
  öffentlich (`public: true`, **außerhalb** von `withNoteContext`) unter `/public/links/:token`: Info (Titel/Seitenbaum erst nach dem Freischalten),
  `unlock` (10/600 s; 10 Fehlversuche je Link und Stunde → 429), `notes/:noteId/state|live|updates|awareness`, `assets/:assetId/:variant`.
  Ungültig/abgelaufen/widerrufen/Papierkorb/Seite außerhalb/Eigentümer*in der Wurzel fehlt oder deaktiviert → dieselbe 404. Zugriffstoken nach dem
  Passwort 12 h (`LINK_ACCESS_TTL_SEC`), Live-Verbindungen prüfen es laufend.
- **Gäste live**: Updates als **JSON (base64)** `POST …/updates` (öffentliche Endpunkte nehmen nur JSON; ≤ 600 KB roh, `MAX_PUBLIC_UPDATE_BYTES`),
  Zugriff 5 s gecacht (`clearGuestCache` nach Widerruf). SSE über denselben Hub: `createLiveHub` kennt jetzt `subject` (Identität statt Konto,
  `guest:<hash des Tab-Geheimnisses key>`), `recheck` (eigene Neuprüfung statt Sitzung) und `countWhere` (≤ 30 Gast-Streams je IP). Anwesenheit nur mit
  passendem `key`; fremde `client`-Kennung → 409. Widerruf/Verschieben/Papierkorb → `recheckNotes` → `revoked`.
- Client: `NoteSync(…, level, guest)` (Basis `/public/links/<token>/notes/<id>`, `t`/`key`/`name` in der Query), `NoteEditor guest={{ assetSrc, openHref }}`
  (Gastmodus, `GuestEmbed`, `browserImage(src)`), Seiten `pages/PublicNotePage.svelte` (`/p/notes/link/<token>`, `?seite=<id>`, Passwort, Name,
  Seitenbaum/BottomSheet) + `PublicNoteView.svelte`; Verwaltung `pages/NoteLinkDialog.svelte` (Menü „Öffentlicher Link …“, nur mit Recht + Teilen-Recht).
  Core: `ModuleUi.publicWideRoutes` → `/p/…` ohne schmale Spalte.
- Audit `notes.link.created|revoked|accessed` (accessed ≤ 1×/h je Link, Akteur `system` „Öffentlicher Link“), ohne Passwort/Inhalt/Gastnamen.
  Gast-Änderungen speichern `created_by/updated_by = NULL`. Konto gelöscht → eigene Links widerrufen; `resetUsers` widerruft fremde Links.
- Tests `tests/integration/notes-links.test.ts`. Offen: echte Browser-Prüfung mit mehreren Gästen gleichzeitig, Safari/iOS; Gast-Updates zählen gegen
  das IP-Rate-Limit (1200/60 s je IP – mehrere Gäste hinter einem NAT teilen es).


## Nummerierungsarten (2026-11-04, v1.4.0, keine Migration)
Attribut `listStyle` an `orderedList` (`NoteOrderedList`, Logik `doc/list-style.ts`): `decimal` (1. 2.), `outline` (1. 1.1. 1.1.1.), `classic`
(1. → a. → i. je Ebene), `lower-alpha` (a)), `upper-alpha` (A.), `upper-roman`, `lower-roman`. `null` = Standard bzw. **wie die Oberliste**: Unterlisten
(Tab) erben die Art ohne eigenes Attribut; Tiptaps `type` (a/A/i/I aus HTML/Markdown) gilt als Art (`ownListStyle`). Gerendert als `data-list-style`,
Darstellung per CSS-Zähler in `pages/editor/ListStyles.svelte` (global, auch Versionsvorschau; Start ≠ 1 über `--ol-start`). Auswahl: Pfeil neben
„Nummerierung“ in der Werkzeugleiste, Slash-Eintrag „Gliederung“; `setListStyleAt` setzt die innerste Liste am Cursor (`decimal` nur ausdrücklich, wenn
eine Oberliste etwas anderes vererbt). Export: HTML/PDF schreiben Listen mit Art als `ul.task-list`/`li.task-item` mit ausgeschriebener Nummer (die
PDF-Bereinigung des Cores lässt an `ol` nur `start` zu), Word als Text mit hängendem Einzug, Markdown wie gewöhnliche Liste (Art geht verloren).
Tests `notes-list-style.test.ts`.
