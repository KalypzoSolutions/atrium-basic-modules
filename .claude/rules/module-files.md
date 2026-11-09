---
paths: ["modules/files/**", "tests/**/files*", "tests/helpers/s3-mock.ts", "scripts/seed-demo-files.mjs"]
---

# Modul `files` (Dateien / Cloud-Ablage)

Cloud-Ablage des Stammes mit **einer Ansicht „Dateien“**: In der Wurzel stehen die eigenen Ordner/Dateien (mit Kontingent) **und** alles,
was mir andere freigegeben haben (auch an den ganzen Stamm). Ordner und Dateien lassen sich hochladen (auch ganze Ordner per Drag & Drop),
umbenennen, verschieben, in den Papierkorb legen, an **Principals** freigeben (Lesen/Bearbeiten, vererbt) und über **öffentliche Links** an
Personen ohne Konto weitergeben – zum Ansehen, zum Hochladen oder beides. Aktionen per „…“-Menü **und Rechtsklick**. Vorschau für Bilder, PDFs
und Text. Ordner mit **Icon und Farbe**, **Speicherkontingent je Person**. Schema `mod_files`, Version 1.3.0, keine harten Abhängigkeiten, optional `members` (Gruppen/Mitglieder als Freigabe-Ziele).
Navigation „Dateien“ (Icon `cloud`). Inhalte liegen im Core-Storage (S3, Modul `files`), Zugriff per Systemkontext `files-storage` **nach**
der Objektprüfung (Benutzer brauchen keine `files.storage.*`-Rechte).

## Entscheidungen des Nutzers (2026-10-19, nicht ungefragt ändern)
- Freigabe an **Principals** (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in; `read`/`edit`) wie `events`/`galleries`.
- **Eine Ansicht** statt „Meine Dateien“ / „Stamm“ / „Mit mir geteilt“ (Umbau 2026-10-19): Freigegebenes erscheint einfach in meiner Dateiliste.
  Den **Stammesordner gibt es nicht mehr** – „Stamm“ = Freigabe an `everyone:*` („Mit dem ganzen Stamm teilen“). Rechte `files.shared.view|edit` entfallen.
- Öffentliche Links auch für Personen **ohne Konto**: Ablaufdatum, optionales Passwort, widerrufbar, rate-limitiert. **Art beim Erstellen wählbar**:
  „Ansehen“ (`view`), „Hochladen“ (`upload`, sieht keinen Inhalt), „Ansehen und hochladen“ (`view-upload`); Upload-Arten **nur für Ordner**.
- Link-URL ist **jederzeit** wieder abrufbar/kopierbar (nicht nur einmal beim Anlegen).
- Öffentlicher Upload mit **optionalem Namen** („Dein Name (optional)“), an der Datei gespeichert und angezeigt.
- Aktionen auch per **Rechtsklick** (Kontextmenü an der Mausposition, Long-Press auf Touch).
- Drag & Drop für Dateien **und** Ordner (Upload von außen, Verschieben intern). Vorschau für **Bilder und PDFs** (+ Text).
- **Nicht im Umfang**: Sync-Client, Versionen, gemeinsames Bearbeiten, Videos.
- (2026-10-23) Ordner bekommen **Icon** (aus einer Icon-Bibliothek mit möglichst vielen Icons → alle Lucide-Icons, Auswahl über ein Menü)
  und **Farbe** (vorhandener `ColorPicker` + Vorschläge); **für alle mit Zugriff gleich**, ändern darf, wer den Ordner bearbeiten darf.
  Kontingent **je Person**, Standard bleibt 1 GB, einstellbar **im Dialog „Benutzer bearbeiten“** der Verwaltung.

## Dateien (`modules/files/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (4 Rechte + Beschreibungen, `defaultRoleGrants` „Mitglied“ → `files.file.view`, Navigation), Einstellungen, Migrationen 0001–0005, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`, `search`, `backup` (`filesBackup`), Jobs `purge-trash` (täglich) und `thumbs-backfill` (stündlich), Endpoint-Reihenfolge links → meta → recent → trash → shares → upload → quota → nodes (öffentliche/feste Pfade vor `:id`) |
| `ui.ts` | Route `''` → `FilesPage`; `publicRoutes` `link/:token` → `PublicLinkPage`; `userAdminSections` `quota` → `UserQuotaSection` |
| `schemas.ts` | API-Vertrag (Server + UI): `PERMISSIONS`, `SETTING_KEYS`, `ROOT_LABEL` („Dateien“), `SPACES` (nur noch `personal`, intern), `LINK_MODES`/`LINK_MODE_LABELS`/`LINK_MODE_DESCRIPTIONS`, `linkCanView`/`linkCanUpload`, Grenzen (`MAX_NAME` 200, `MAX_DEPTH` 20, `MAX_BULK` 500, `MAX_SHARES` 200, `MAX_LINKS_PER_NODE` 20, `MAX_SEARCH_RESULTS` 100, `MIN_PASSWORD` 8, `MAX_UNLOCK_FAILURES` 10, `LINK_ACCESS_TTL_SEC` 900, `MAX_TEXT_PREVIEW_BYTES` 1 MB, `UPLOAD_CONCURRENCY` 3, `MAX_PUBLIC_UPLOAD_FILES` 10, `MAX_PUBLIC_UPLOAD_BYTES` 30 MB, `MAX_UPLOADER_NAME` 100), Vorschau-Typen, `NEVER_INLINE_TYPES`, `INVISIBLE_CHARS`, Zod (`nodeName`, `listQuery`, `folderCreateInput`, `moveInput`, `uploadFields`, `sharesInput`, `linkCreateInput` mit `mode`, `publicUploadFields`, …), DTOs `FileNode` (`owner`, `own`, `stamm`, `uploadedByName`, `viaLink`), `FolderListing`, `Breadcrumb`, `SearchResult`, `TrashItem`, `NodeShares`, `ShareLink` (`mode`, `url`), `PublicLinkInfo` (`mode`, `upload`), `PublicListing`, `PublicUploadResult`, `FilesMeta` |
| `db.ts` | `mdb()`, `filesCtx()` (Systemkontext für Storage), `NodeRow`/`nodeRowOf`/`NODE_COLUMNS`, `loadNode(s)`, `ancestorsOf`/`descendantIds` (rekursive CTEs, Zyklenschutz 64), `userRefs` (nach der Tx), `filesSettings()` |
| `access.ts` | Objektprüfung: `rootAccess` (Eigentümer*in / `manage-all`), `resolveAccess`, `requireNode` (404/403), `requireFolderTarget` (`null` = eigene Wurzel), `accessForMany` (Listen, ein CTE), `sharedWithMeRoots` (Wurzel-Einträge anderer), `visibleNodesFilter` (Suche), `stammSharedSql` (Badge „Stamm“), `canManageAll`, `NODE_SHARES` (Freigabe-Tabelle für die SDK-Bausteine `shareLevelOn`/`loadObjectShares`/`replaceObjectShares`, #35) |
| `names.ts` (rein) | `normalizeName` (NFC, unsichtbare Zeichen raus, Leerzeichen, Kürzen mit Endung), `splitExtension`, `uniqueName` („Bild (2).jpg“), `splitRelativePath`, `displayPath` |
| `nodes.service.ts` / `nodes.endpoints.ts` | Auflisten (Wurzel = eigene + freigegebene), Breadcrumbs, Suche, Ordner anlegen, `ensureFolderPath` (Ordner-Upload), `siblingNames`, Umbenennen, Verschieben (Advisory-Lock, Zyklus-/Tiefenprüfung, Eigentümerwechsel, Kontingent), DTO-Aufbau (`extrasForMany`, `toFileNode`) |
| `upload.service.ts` | `storeIntoFolder(input)` – gemeinsamer Upload-Ablauf für intern **und** öffentlich (Tx 1 → Storage → Tx 2, `recheck` in beiden Transaktionen, Kontingent der Eigentümer*in, Konflikt `rename`/`replace`, Aufräumen bei Fehlern), `cleanUploaderName`; kein Audit (macht der Aufrufer) |
| `upload.endpoints.ts` | Interner Upload (Multipart, Vorprüfungen, dann `storeIntoFolder`), Inhalt, Thumbnail |
| `storage.ts` | `storeContent` (Typ normalisieren/prüfen, Vorschaubild über `createThumbnail`: Bilder 320 px, PDFs erste Seite 480 px per `core.pdf.renderPage`, beides WebP über `core.images.process`; `canThumbnail`, `thumbPathFor`), `contentResponse`/`thumbResponse` (Sicherheits-Header, gestreamt über `core.storage.downloadStream`), `removeObjects` (Sammel-Löschung `core.storage.removeMany`: S3 DeleteObjects à 1000, ein Audit `core.storage.files_deleted`; #24), `storageLimits`, `quotaUsed`/`assertQuota` |
| `thumbs.service.ts` | Job `thumbs-backfill` (`runBackfill`, ≤ 50 Dateien je Lauf, ≤ 50 MB): Bestand ohne Vorschau (Bild/PDF, `thumb_attempted_at IS NULL`) einmal versuchen; andere Typen nur markieren; Speicher nicht erreichbar → Abbruch ohne Markierung; Ersetzen-Upload dazwischen → neues Vorschaubild wird verworfen |
| `shares.service.ts` / `shares.endpoints.ts` | Freigaben lesen (eigene + geerbte) / ersetzen, Principal-Suche (`everyoneLabel` „Stamm“), `keysFor`, `canManageShares`/`assertCanManageShares` |
| `links.service.ts` / `links.endpoints.ts` | Öffentliche Links: anlegen (mit Art)/auflisten (mit URL)/widerrufen (intern); Info, Freischalten, Ordnerinhalt, Inhalt, **Upload** (öffentlich) |
| `trash.service.ts` / `trash.endpoints.ts` | Papierkorb: löschen, Liste, wiederherstellen, endgültig löschen, Ablauf-Job `purgeExpired` |
| `meta.endpoints.ts` | `/meta`: Kontingent, Upload-Grenzen, Papierkorb-Dauer, Fähigkeiten des Aufrufers (`linkCreate`, `manageAll`) |
| `reset.ts` | Reset-Bereich `all` (`rebuild`, alle Storage-Objekte, keine `implies`), `resetUsers` (Übernahme fremder Ablagen) |
| `recent.endpoints.ts` | `GET /recent` („Zuletzt geändert“ fürs Dashboard): eigene + freigegebene Dateien (keine Ordner, kein Papierkorb), neueste zuerst; auch mit `manage-all` keine fremden Ablagen; ohne Audit |
| `search.ts` | Globale Suche (`filesSearch`) über `searchNodes` (gleiche Sichtbarkeit wie `GET /search`, nie Papierkorb); Dateien verlinken auf ihren Ordner, sonst auf die Wurzel |
| `contract.ts`, `refs.service.ts` | Dienst `FileRefsService` (`provides`, 2026-10-26): `searchFileRefs` (über `searchNodes`, ab 2 Zeichen) / `describeFileRefs` (`resolveAccess` je ID, nie Papierkorb) mit `href` und `contentUrl`; prüft `files.file.view` selbst; Nutzer: Karten im `whiteboard` (keine Kopie, Zugriff bleibt bei „Dateien“) |
| `backup.ts` | `filesBackup.rehash`: `share_links.token_hash` aus `token_enc` mit dem Ziel-Schlüssel neu berechnen; ohne entschlüsselbares `token_enc` → Link widerrufen (`unrecoverable`) |
| `user-deleted.ts` | `onUserDeleted`: Ablage der Person **löschen** (nicht übergeben), übrige von ihr angelegte Links widerrufen, `user:`-Freigaben löschen, `created_by`/`deleted_by` → `NULL`; Storage-Objekte nach dem Commit |
| `subject-export.ts` | Datenauskunft (`subjectExport`): Metadaten der eigenen Ablage (ohne Inhalte/Pfade), Uploads in fremde Ordner, Freigaben an Konto/Mitglieder, eigene Links (ohne Token/Hash) |
| `pages/FilesPage.svelte` | Eine Seite „Dateien“ (`?folder=<id>`), Knopf **„Papierkorb“** im Seitenkopf (`?view=trash`, zurück per Knopf/Brotkrumen), Brotkrumen (Drop-Ziele), Raster/Liste (Wahl in `localStorage`), Suche, Mehrfachauswahl, `QuotaBar` immer sichtbar; Kontextmenü auf leerer Fläche („Neuer Ordner“, „Dateien hochladen“, „Ordner hochladen“) |
| `pages/FileList.svelte` | Raster-/Listenansicht, Tastatur (Pfeile, Home/End), internes Ziehen mit `DRAG_MIME`; **Rechtsklick** → `ContextMenu` an der Mausposition mit denselben Aktionen wie das „…“-Menü (gemeinsames Snippet), bei Mehrfachauswahl für die Auswahl; Long-Press auf Touch; fremde Einträge mit Badge „von <Name>“ bzw. „Stamm“ |
| `pages/UploadDropzone.svelte`, `upload-queue.ts` | Drop-Bereich + Datei-/Ordnerauswahl (`webkitdirectory`, `webkitGetAsEntry`), Warteschlange (Vorprüfung Größe/Typ/Kontingent, 3 parallel, Fortschritt, Fehler) – `upload-queue.ts` rein und getestet |
| `pages/FilePreview.svelte` | Vorschau (Bild mit Zoom/Blättern/Wischen, PDF im Blob-iframe, Text ≤ 1 MB), auch für die öffentliche Seite (`ContentUrlFn`) |
| `pages/ShareNodeDialog.svelte` | Oben Schalter **„Mit dem ganzen Stamm teilen“** (Sehen/Bearbeiten → `everyone:*`), darunter `SharePanel` für Einzelne (eigene + geerbte Freigaben) |
| `pages/LinkDialog.svelte` | Neuer Link: **Art** (Segment Ansehen · Hochladen · Ansehen und hochladen; Upload nur bei Ordnern), Ablauf, Passwort; Liste zeigt **jederzeit die URL** mit „Kopieren“/„Öffnen“ und Widerrufen (alte Links ohne `token_enc`: „Link-Adresse nicht mehr abrufbar – neuen Link erstellen“) |
| `pages/NameDialog`, `MoveDialog` (ein Baum ab „Dateien“: eigene + bearbeitbare freigegebene Ordner), `NodeInfoDialog` („Hochgeladen über Link von <Name>“), `TrashView`, `QuotaBar`, `helpers.ts` | Dialoge und Hilfen (`DRAG_MIME`, `VIEWS` = `files`/`trash`, `internalUrl`, `compareNodes`, `formatDateTime`, `errorText`) |
| `quota.endpoints.ts` | `GET/PUT /quotas/:userId` (Recht `files.quota.manage`): Modus `default`/`custom`/`unlimited`, Belegung, wirksames Limit; Audit `files.quota.updated` (Modus, MB) |
| `pages/file-types.ts` (rein), `pages/FileTypeGlyph.svelte` | Dateityp für die Anzeige: `fileTypeOf(contentType, name)` → Art (`pdf`, `word`, `sheet`, `slides`, `image`, `text`, `code`, `archive`, `audio`, `video`, `other`; Content-Type, Rückfall Endung), Kürzel („DOCX“), Beschreibung; `FILE_KIND_ICONS`, `FILE_KIND_CLASSES` (Tokens `text-file-<art>`/`bg-file-<art>-muted`), `fileTint`; Glyph = Symbol in Typfarbe, ab `md` mit Kürzel. `iconFor(kind, type, name?)` nutzt es |
| `pages/FolderGlyph.svelte` | Ordnersymbol: gefüllt in der Ordnerfarbe (ohne Farbe neutral grau), ab `md` Icon darauf (Kontrastfarbe per `contrastTextColor`) |
| `pages/FolderStyleDialog.svelte` | Dialog „Ordner gestalten“: Vorschau, Vorschlagsfarben + `ColorPicker`, `IconPicker` (alle Icons), „Kein Icon“, „Auf Standard zurücksetzen“ |
| `pages/UserQuotaSection.svelte` | `userAdminSections`-Abschnitt im Benutzer-Dialog: `QuotaBar`, Auswahl Standard/Eigenes Limit (Zahl + MB/GB)/Unbegrenzt, Warnung unter der Belegung, eigener Speichern-Knopf |
| `pages/PublicLinkPage.svelte` | Öffentliche Seite `/p/files/link/<token>` je `mode`: Passwortabfrage, Ordner blättern (`?folder=`), Vorschau, Download; bei Upload-Arten **Upload-Bereich** (Drag & Drop + Auswahl, mehrere Dateien, Fortschritt per XHR, Feld „Dein Name (optional)“, Grenzen, „Danke! N Dateien hochgeladen“); „Hochladen“ zeigt keinen Inhalt; Zugriffstoken in `sessionStorage` |
| `migrations/0001_init.sql`, `0002_link_lockout.sql`, `0003_single_view_upload_links.sql`, `0004_folder_style_user_quota.sql`, `0005_thumb_state.sql` | Schema; Fehlversuchs-Zähler für Link-Passwörter; eine Ansicht + Link-Arten + `token_enc` + Upload-Herkunft; `nodes.icon`/`color` + Tabelle `user_quotas`; `nodes.thumb_attempted_at` (+ Teilindex offener Vorschauen) |

Core-Baustein dazu: `src/lib/components/ui/context-menu/` (bits-ui `ContextMenu`, gleiche API wie `ui/dropdown-menu`, siehe `ui-design.md`).

## Datenmodell
- `nodes` – Ordner **und** Dateien als Baum (`parent_id` FK CASCADE, `kind` folder|file, `space` (seit 0003 immer `personal`, CHECK unverändert),
  `owner_id` = Eigentümer*in, `name`, `storage_path`/`thumb_path`/`content_type`/`size_bytes` nur Dateien, `created_by` (`NULL` bei öffentlichem Upload),
  Zeitstempel; 0003: `uploaded_by_name text` (optionaler Name beim öffentlichen Upload), `uploaded_via_link text` (Link-ID, ohne FK)).
  **Wurzeln sind virtuell**: `parent_id NULL` + `owner_id` – keine Wurzel-Zeile.
- Eindeutige Namen je Ordner ohne Groß/Klein über **Partial-Unique-Index** `nodes_unique_name_idx` auf
  `(COALESCE(parent_id, space || ':' || owner|''), lower(name)) WHERE deleted_at IS NULL` – Papierkorb-Einträge blockieren keine Namen.
  Konflikte: Upload (`conflict = rename|replace`), Verschieben und Wiederherstellen benennen automatisch per `uniqueName`; Ordner anlegen und
  Umbenennen → 409 mit Namensvorschlag.
- **Papierkorb**: alle Knoten eines gelöschten Teilbaums bekommen `deleted_at`/`deleted_by`, nur die Wurzel `trash_root = true`. Früher gelöschte
  Unterbäume behalten ihre eigene `trash_root` (bleiben beim Wiederherstellen des äußeren im Papierkorb; endgültiges Löschen entfernt sie per CASCADE mit).
  Wiederherstellen: zurück in den Elternordner, wenn er noch da ist, sonst in die Wurzel der Eigentümer*in; Name ggf. `uniqueName`.
- `node_shares(node_id FK CASCADE, principal_type CHECK, principal_id, level read|edit, created_by, created_at, PK)` + Index `(principal_type, principal_id)`.
  „Stamm“ = Zeile `everyone` / `*`.
- `share_links(id, node_id FK CASCADE, token_hash UNIQUE, expires_on date (gültig bis einschließlich), password_hash, created_by, created_at, revoked_at,
  last_access_at, access_count)`; 0002: `failed_count`, `failed_window_start`; 0003: `mode text NOT NULL DEFAULT 'view' CHECK (view|upload|view-upload)`,
  `token_enc text` (Token per `core.crypto.forModule('files').encrypt`, damit die URL wieder anzeigbar ist; gesucht wird weiter über `token_hash`).
  Alte Links (vor 0003) haben kein `token_enc` → `url = null`.
- 0005: `nodes.thumb_attempted_at timestamptz` – Zeitpunkt des Vorschau-Versuchs; Uploads setzen ihn immer, `NULL` = Bestand vor 0005 → Job `thumbs-backfill`.
- 0004: `nodes.icon text` (CHECK Format `[a-z0-9-]`, ≤ 64), `nodes.color text` (CHECK `#rrggbb` klein), CHECK nur Ordner tragen ein Aussehen
  (`nodes_style_check`). `user_quotas(user_id PK, quota_mb integer NULL = unbegrenzt, CHECK 1–10 000 000, updated_by, updated_at)` – keine Zeile = Standard
  `files.quota.mb`. `quotaLimitFor(tx, owner, defaultBytes)` (`storage.ts`) liefert das wirksame Limit; `assertQuota`, Link-Upload-Vorprüfung und `/meta`
  nutzen es. `onUserDeleted` löscht die Zeile, `resetUsers` die Zeilen fremder Personen, Reset `all` die Tabelle; `subjectExport` → `storageQuota`.

### Migration 0003 (Stamm-Bereich auflösen)
1. Namenskonflikt einer Stamm-Wurzel mit einer Wurzel der künftigen Eigentümer*in → Suffix „ (Stamm <erste 8 Zeichen der ID>)“ (immer eindeutig).
2. Jede ehemalige Stamm-Wurzel bekommt die Freigabe `everyone:*` **read** (Eigentümer*in hat ohnehin edit, `manage-all` sowieso).
3. Ganzer Teilbaum bekommt `owner_id` der Wurzel (= Person, die den Stamm-Ordner angelegt hat).
4. `space = 'personal'` für alle. Keine Daten werden gelöscht.

**Hinweis**: Bearbeiten-Rechte von Rollen mit dem früheren `files.shared.edit` werden **nicht** automatisch als Rollen-Freigaben übertragen
(Rollenrechte liegen im Core-Schema, die Modul-Migration kommt nicht dran). Eigentümer*in oder `manage-all` muss bei Bedarf nachträglich
(Stamm oder Rolle, „Bearbeiten“) freigeben.

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `files.file.view` | Grundrecht: eigene Ablage, für mich (oder den ganzen Stamm) Freigegebenes; alle internen Endpunkte |
| `files.link.create` | Öffentliche Links anlegen (zum Ansehen/Hochladen; zusätzlich Eigentümerschaft oder `manage-all` am Knoten nötig) |
| `files.file.manage-all` | Alles sehen und verwalten, auch fremde Dateien (`GET /nodes?owner=`) |
| `files.quota.manage` | Speicherkontingent einzelner Personen festlegen (Abschnitt im Dialog „Benutzer bearbeiten“) |

`files.shared.view|edit` gibt es seit 0003 nicht mehr. `defaultRoleGrants`: „Mitglied“ → `files.file.view` (Verknüpfungs-Konten bekommen eine
eigene Ablage und sehen Freigegebenes).

## Zugriffsregeln (`access.ts`)
- **Eigentümerschaft**: System/`manage-all` → edit überall; `owner_id = ctx.userId` → edit. Sonst nur über Freigaben.
- **Vererbung**: Freigabe auf dem Knoten **oder einem Vorfahren** gilt (auch `everyone:*`); **höchste Stufe gewinnt**.
- Gelöschte Knoten (auch über einen gelöschten Vorfahren) und Knoten ohne Zugriff → **404**, nie 403 (Existenz nicht verraten). 403 nur, wenn read da ist,
  aber edit verlangt wird.
- `principalKeysFor` (`keysFor`) immer **vor** der Transaktion, `validatePrincipals`/`describePrincipals` vor bzw. nach.
- **Wurzel** (`GET /nodes` ohne `parent`) = eigene Wurzelknoten + `sharedWithMeRoots`: Knoten **anderer** mit direkter Freigabe an einen meiner Principals
  (auch Stamm), deren Vorfahren mir nicht schon freigegeben sind (sonst erscheinen sie im freigegebenen Oberordner). Eigene Knoten nie doppelt.
- **Breadcrumbs/Suchpfade**: Wurzel „Dateien“; bei fremden Ordnern erst ab dem ersten zugänglichen Vorfahren (keine Namen privater Oberordner).
- Geerbte Freigaben zeigt `GET /nodes/:id/shares` nur von Vorfahren, auf die der Aufrufer selbst Zugriff hat (sonst würden fremde Ordnernamen sichtbar).
- `requireFolderTarget(null)` = eigene Wurzel von `ctx.userId`; neue Kinder bekommen die Eigentümer*in des Zielordners.

## Sicherheitsregeln (aus der Prüfung, nicht aufweichen)
- **Freigaben und Links verwalten nur Eigentümer*in und `manage-all`** (`canManageShares`, DTO-Feld `canShare`). **Edit über eine Freigabe reicht nicht**
  (auch nicht über eine Stamm-Freigabe mit „Bearbeiten“; sonst ließen sich fremde Inhalte weiterverteilen) → 403.
- **Verschieben**: edit auf Quelle und Ziel; gehört das Ziel jemand anderem, wechselt `owner_id` für den ganzen Teilbaum – nur mit Eigentümerschaft bzw.
  `manage-all` an der Quelle (edit über Freigabe → 403 „Nur die Eigentümer*in kann Einträge aus dieser Ablage herausverschieben“) und mit Prüfung des
  Kontingents der neuen Eigentümer*in. Nicht in sich selbst/Nachfahren (422), Tiefe ≤ 20 (422).
  Wer nur über eine **Bearbeiten-Freigabe** zugreift, darf **nur innerhalb des freigegebenen Teilbaums** verschieben (Ziel muss unter dem Knoten mit der
  edit-Freigabe liegen) – sonst 403; verhindert Weiterverteilen (z. B. aus einem privat freigegebenen in einen Stamm-/Link-Ordner). Beim **Eigentümerwechsel**
  werden alle aktiven öffentlichen Links im Teilbaum widerrufen (Audit `revokedLinks`); Freigaben bleiben.
- **Namen**: keine `/ \`, keine Steuerzeichen, nicht `.`/`..`, **keine unsichtbaren Zeichen** (`INVISIBLE_CHARS`: Zero-Width, Bidi wie U+202E/U+061C, C1,
  Füllzeichen, weiche Trennung, BOM → 422); Upload-Namen werden
  vorher normalisiert.
- **Upload (intern)**: `Content-Length` ist **Pflicht** (fehlt/ungültig → 400; > Max + 1 MB → 413, bevor der Body gelesen wird); Typ gegen die Allowlist
  (Browser-Typ, sonst Endung, sonst `application/octet-stream`; aktive Inhalte nur, wenn ausdrücklich erlaubt). **Kontingent in beiden Transaktionen**
  von `storeIntoFolder` (Vorprüfung + mit echter Größe; Fehler → hochgeladene Objekte werden entfernt); Papierkorb zählt mit. `assertQuota` nimmt
  `pg_advisory_xact_lock(hashtext('files:quota:<owner>'))` (immer als letzte Sperre der Transaktion) → parallele Uploads überschreiten das Kontingent nicht (#72, 06-12). Das Kontingent gilt je
  Eigentümer*in (auch für Uploads anderer in freigegebene Ordner).
- **Öffentlicher Upload** (`publicUpload` → `storeIntoFolder`):
  - nur bei Link-Art `upload`/`view-upload` auf einem **Ordner** (sonst 403), bei Passwort nur mit gültigem Zugriffstoken `t` (403);
  - Dateien landen **nur direkt im Link-Ordner** (kein `relativePath`, keine Unterordner), **nie überschreiben** (Konflikt immer `rename` → „Name (2)“);
  - Eigentum und Kontingent = **Eigentümer*in des Link-Ordners**, `created_by = NULL`, `uploaded_via_link` = Link-ID; Vorprüfung aller Dateien
    (Größe, Kontingent → 413; 0 Dateien → 422; > 10 Dateien lehnt schon der Core-Router mit 400 ab), danach Typ/Größe wie `storeContent`;
  - **Obergrenze je Link** (`files.link.upload-mb`, Standard 500 MB, 0 = unbegrenzt): Summe aller über den Link hochgeladenen Dateien (Papierkorb zählt mit),
    geprüft vorab und in jedem `recheck` (Advisory-Lock je Link) → 413 „Über diesen Link kann nichts mehr hochgeladen werden“;
  - Speicher-Fehler im öffentlichen Pfad mit **neutraler Meldung** („In diesem Ordner ist nicht genug Speicherplatz frei“, keine Belegungszahlen;
    Erkennung über das Wort „Speicherplatz“ in der Meldung von `assertQuota` – bei Umformulierung mitziehen);
  - **`recheck` in jeder Speicher-Transaktion**: Link noch aktiv (nicht widerrufen/abgelaufen), Art mit Upload, Ordner nicht im Papierkorb, gleiche Eigentümer*in;
    scheitert eine spätere Datei, bleiben die schon gespeicherten erhalten;
  - Name der Person bereinigt (`cleanUploaderName`: NFC, unsichtbare/Steuerzeichen raus, Leerraum zusammengefasst, ≤ 100 Zeichen, leer → `null`);
  - Antwort nur Namen + Größen der angelegten Dateien (keine IDs, kein anderer Inhalt); bei Art `upload` die **angefragten** (normalisierten) Namen,
    nicht die vergebenen („X (2)“) – sonst ließe sich die Existenz gleichnamiger Dateien erfragen; Audit `files.link.uploaded` mit Anzahl/Bytes, **ohne** Namen der Person
    und ohne Dateinamen.
- **Auslieferung** (`contentResponse`): `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, `content-disposition` nach
  RFC 5987; inline nur Bilder, PDF und Text (Text als `text/plain; charset=utf-8`); **aktive Inhalte** (`text/html`, `image/svg+xml`, `application/xhtml+xml`)
  **nie inline**, immer `attachment` als `application/octet-stream`.
- **Link-Token** (32 Byte, base64url): Suche über Hash (`core.crypto.forModule('files').hash`, HMAC-SHA-256, `token_hash`), seit 0003 zusätzlich
  **AES-256-GCM-verschlüsselt** (`token_enc`) – die URL bekommen nur Verwaltende über `GET …/links` (nicht entschlüsselbar → `url = null`). Passwort:
  scrypt mit Salt, `timingSafeEqual`, `MIN_PASSWORD` 8.
- **Link-Art**: Ordnerinhalt/Dateien (`nodes`/`content`) nur bei `view`/`view-upload` (sonst 403 „Über diesen Link kann nur hochgeladen werden“);
  `GET /public/links/:token` liefert bei „Hochladen“ keinen Knoten.
- **Zugriffstoken** nach dem Freischalten: `<linkId>.<exp>.<sig>` (HMAC über eigene Domäne `access:`), gültig **15 min**.
- **Passwort-Raten**: höchstens **10 Fehlversuche je Link und Stunde**, danach **429** (auch bei richtigem Passwort); Erfolg setzt zurück. Zusätzlich Rate-Limit
  `unlock` 10/600 s je IP.
- Ungültig / abgelaufen / widerrufen / Knoten im Papierkorb → überall dieselbe 404 „Link nicht verfügbar“. Öffentlicher Zugriff nur im Teilbaum des Links.
- **Eigentümer*in des Link-Knotens** muss existieren und aktiv sein (`assertOwnerActive` in `links.service.ts`, `core.users.directory` nach der
  Transaktion) – Links **deaktivierter** oder gelöschter Konten → dieselbe 404 (Info, Freischalten, Inhalt, Ordnerinhalt, Upload).
- **Konto gelöscht** (`user-deleted.ts`, Hook `onUserDeleted`): Ablage der Person samt Teilbäumen löschen (CASCADE: Links/Freigaben), weitere von ihr
  angelegte Links widerrufen, Freigaben an `user:<id>` löschen, `created_by`/`deleted_by` → `NULL`; Storage-Objekte nach dem Commit. Keine Übergabe
  (anders als `resetUsers`).
- Audit ohne Inhalte/Namen: `files.node.created|uploaded|renamed|moved|trashed|restored|purged`, `files.share.updated` (Anzahl), `files.link.created` (mit `mode`)
  `|revoked`, `files.link.accessed` (höchstens 1× je Link und Stunde, Akteur `system`/„Öffentlicher Link“), `files.link.uploaded` (Anzahl, Bytes).
  Vorschau/Download wird nicht protokolliert.

## API (`/api/v1/modules/files/…`)
Alle internen Endpunkte: Recht `files.file.view`, die Objektprüfung macht der Handler.
| Methode + Pfad | Besonderheiten |
|---|---|
| GET `/meta` | `FilesMeta`: Kontingent, `maxFileBytes`, erlaubte Typen, `trashDays`, `can` (`linkCreate`, `manageAll`) |
| GET `/nodes?parent=&owner=` | `FolderListing` (Ordner zuerst, Name de); ohne `parent` = Wurzel (eigene + freigegebene); `owner` nur mit `manage-all` (Wurzel einer anderen Person) |
| GET `/search?q=` | ab 2 Zeichen, über alles Sichtbare, ≤ 100 Treffer (`truncated`), mit Pfad |
| POST `/folders` | `{ parentId, name }` (`parentId = null` = eigene Wurzel); edit am Ziel; Tiefe ≤ 20 |
| POST `/nodes/move` | `{ ids ≤ 500, targetId }` (`null` = eigene Wurzel) → `{ affected }`; Regeln siehe oben |
| GET `/nodes/:id` | `FileNode` (404 ohne Zugriff) |
| PATCH `/nodes/:id` | `{ name }` umbenennen (Konflikt 409 mit Vorschlag) |
| POST `/nodes/style` | `{ ids ≤ 500, icon?, color? }` (fehlend = unverändert, `null` = zurücksetzen) → `{ affected }`; edit an jedem Ordner (fremd 404, nur Lesen 403), Dateien 422, unbekanntes Icon 422 (Prüfung gegen `$lib/sdk/icons`); `updated_at` bleibt; Audit `files.node.styled` nur mit Anzahl und `set`/`reset`/`unchanged` |
| GET / PUT `/quotas/:userId` | Recht `files.quota.manage`; PUT `{ mode: default|custom|unlimited, mb? }` (custom: ganze MB 1–10 000 000) → `UserQuota`; kein Existenz-Check der ID (deaktivierte Konten bleiben bearbeitbar) |
| POST `/nodes/:parent/upload` | multipart `file` + `relativePath?`, `conflict?`; `parent` = Ordner-ID oder `root` (eigene Wurzel); ein Request je Datei |
| GET `/nodes/:id/content?download=1` | Inhalt mit Sicherheits-Headern (`private, max-age=60`) |
| GET `/nodes/:id/thumb` | WebP (Bilder 320 px, PDF erste Seite 480 px) (`private, max-age=3600`), 404 ohne Thumbnail; eigenes Rate-Limit `IMAGE_RATE_LIMIT` (1200/60 s, #23) |
| GET / PUT `/nodes/:id/shares` | lesen (read) / Liste ersetzen (`canShare`, ≤ 200, keine Duplikate, unbekannte Ziele 422); Stamm = `{ type: 'everyone', id: '*' }` |
| GET `/principals?q=` | Freigabe-Ziele (`everyoneLabel` „Stamm“); nur mit `manage-all` oder eigenem Knoten (sonst 403), 60/60 s; Mitglieder nur mit `members.member.view`, E-Mail nur mit `core.users.view` |
| GET / POST `/nodes/:id/links` | Links auflisten (mit `url`) / anlegen `{ expiresOn, password, mode }` (`canShare` + `files.link.create`; `expiresOn` echtes Datum, nicht vergangen; Upload-Art bei Datei → 422 Pfad `mode`; ≤ 20 aktive je Knoten → 409) |
| DELETE `/links/:id` | widerrufen (ohne edit 404, edit nur über Freigabe 403) |
| POST `/nodes/trash` | `{ ids }` in den Papierkorb (edit) |
| GET `/trash` | `TrashItem[]` mit ursprünglichem Ort und `purgeOn` (eigene Einträge, mit `manage-all` alle, dazu selbst gelöschte mit edit am Ort) |
| POST `/trash/restore`, `/trash/purge` | wiederherstellen / endgültig löschen (nur Papierkorb-Wurzeln, Storage danach) |

`GET /shared-with-me` und der Parameter `space` (bei `/nodes`, `/search`, `/folders`, `/nodes/move`, Upload) sind seit dem Umbau **entfallen**.

Öffentlich (`public: true`, kein Login; Router ergänzt einen IP-unabhängigen Gesamt-Bucket 20 × Limit, mind. 200):
| Methode + Pfad | Rate-Limit je IP | Besonderheiten |
|---|---|---|
| GET `/public/links/:token?t=` | 60/60 s | `PublicLinkInfo` (Name, Art `kind`, `mode`, `needsPassword`, Ablauf, `upload`-Grenzen bei Upload-Arten; Datei-Knoten erst nach Freischalten und nur bei Ansehen-Arten) |
| POST `/public/links/:token/unlock` | 10/600 s | `{ password }` → `{ accessToken, expiresInSec }`; falsch 403, gesperrt 429 |
| GET `/public/links/:token/nodes?parent=&t=` | 120/60 s | Ordnerinhalt im Link-Teilbaum; ohne gültiges `t` bei Passwort 403; Art „Hochladen“ 403 |
| GET `/public/links/:token/content/:nodeId?t=&download=&thumb=` | 300/60 s | Datei/Thumbnail; Thumbnails zählen nicht als Abruf; Art „Hochladen“ 403 |
| POST `/public/links/:token/upload` | 20/600 s | öffentliches Multipart (`ApiEndpoint.multipart`: `maxBytes` 30 MB = Core-Grenze, `maxFiles` 10): Dateien im Feld `file`, optional `name` (≤ 100) und `t` → `PublicUploadResult` (`uploaded: [{ name, sizeBytes }]`); Regeln siehe Sicherheit |

## UI
- **Eine Ansicht**: `/modules/files` (`?folder=<id>`), Papierkorb über Knopf im Seitenkopf (`?view=trash`). Raster/Liste wird je Browser gemerkt.
  Fremde Einträge zeigen „von <Name>“, an den ganzen Stamm freigegebene ein „Stamm“-Badge/Icon (`FileNode.stamm`).
- **Kontextmenü**: Rechtsklick auf einen Eintrag öffnet `ContextMenu` (`ui/context-menu`) an der Mausposition mit denselben Aktionen wie das „…“-Menü;
  bei Mehrfachauswahl wirkt es auf die Auswahl (Herunterladen nur bei einer Datei, Verschieben, Papierkorb). Auf leerer Fläche: „Neuer Ordner“,
  „Dateien hochladen“, „Ordner hochladen“. Long-Press auf Touch.
- **Drag & Drop**: Dateien/Ordner **von außen** = Upload (`UploadDropzone`, Ordner per `webkitGetAsEntry` bzw. Auswahl `webkitdirectory`, Ordnerstruktur über
  `relativePath`); **intern** = Verschieben auf Ordner oder Brotkrumen mit eigenem MIME `DRAG_MIME` (`application/x-ep-files-nodes`, JSON-Liste der IDs).
- **Vorschau** (`FilePreview`): Bilder mit Zoom (Buttons, Strg + Mausrad, Tasten) und Blättern (←/→, Wischen); **PDF per Blob-URL im iframe**, weil die App
  `X-Frame-Options: DENY` setzt (direkte URL im iframe wäre blockiert); Text bis 1 MB, größer → Hinweis + Download.
- **Freigabe-Dialog**: Schalter „Mit dem ganzen Stamm teilen“ (Sehen/Bearbeiten), darunter `SharePanel` für Einzelne (eigene + geerbte Freigaben).
- **Link-Dialog**: Art wählen (Upload nur bei Ordnern), Ablauf, Passwort; Liste mit jederzeit sichtbarer URL, „Kopieren“, „Öffnen“, Widerrufen.
- **Verschieben-Dialog**: ein Baum ab „Dateien“ (eigene + bearbeitbare freigegebene Ordner).
- **Info-Dialog**: bei Uploads über einen Link „Hochgeladen über Link von <Name>“ (bzw. ohne Namen).
- **Raster** (intern und öffentliche Seite): Karten einer Reihe gleich hoch, Name mit fester Höhe für zwei Zeilen, Umbruch bevorzugt nach `_ - . /` und vor
  Ziffern (`breakableName` → `<wbr>`), voller Name im Tooltip; Ordner zeigen „12 Einträge · 4,1 MB“ (`folderMeta`, `FileNode.folderBytes` = Teilbaum ohne
  Papierkorb), farbige Ordner mit getönter Vorschaufläche. Liste: kleines Ordnersymbol in der Farbe (ohne Icon).
- **Dateitypen** (2026-10-26, Nutzerwunsch): Dateien ohne Vorschaubild zeigen ein Symbol in der Typfarbe (PDF rot, Word blau, Tabelle grün,
  Präsentation orange, Bild violett, Archiv amber, Audio/Video pink, Code cyan, Rest grau) auf getönter Fläche plus Endungs-Kürzel („DOCX“) –
  Raster, Liste, Suche, Info, Vorschau, Papierkorb, Dashboard-Kachel, öffentliche Seite. **Bilder und PDFs** zeigen eine echte Vorschau; PDFs als
  „Blatt“ (oberer Teil der ersten Seite) mit Abzeichen „PDF“, auch als Titelbild eines Datei-Links.
- **Aussehen**: Menü/Rechtsklick „Farbe“ (Untermenü mit Vorschlagsfarben, auch für mehrere Ordner, Rückgängig-Toast) und „Aussehen ändern …“
  (`FolderStyleDialog`) – nur Ordner mit Bearbeiten-Zugriff. Öffentliche Links zeigen Icon/Farbe (`PublicNode.icon/color`).
- **Öffentliche Seite** `/p/files/link/<token>`: Passwortabfrage; „Ansehen“: Ordner blättern, Vorschau, Download; „Hochladen“: nur Upload-Bereich
  (kein Inhalt); „Ansehen und hochladen“: beides. Upload-Bereich mit Drag & Drop/Auswahl, mehreren Dateien, Fortschritt (XHR), „Dein Name (optional)“,
  angezeigten Grenzen und Erfolgsliste. Zugriffstoken je Link in `sessionStorage`.

## Einstellungen, Job, Reset
- `files.quota.mb` (Standard 1024, 0 = unbegrenzt; je Eigentümer*in, einzeln überschreibbar über `user_quotas`), `files.trash.days` (Standard 30, 1–365),
  `files.link.upload-mb` (Höchstmenge je Upload-Link, Standard 500, 0 = unbegrenzt).
  Größe/Typen kommen aus den Core-Storage-Einstellungen (`core.storage.maxFileSizeMb`, `core.storage.allowedContentTypes`).
- Job `files.thumbs-backfill` (stündlich): fehlende Vorschaubilder für den Bestand (siehe `thumbs.service.ts`).
- Job `files.purge-trash` (täglich): abgelaufene Papierkorb-Wurzeln endgültig löschen (je Lauf ≤ 500, Rest beim nächsten Lauf), Storage danach.
- Reset: Bereich `all` (alle Tabellen inkl. Stamm-Freigaben und Links, alle Storage-Objekte, `rebuild`). `resetUsers`: öffentliche Links auf fremde Ablagen
  **widerrufen**, jede fremde Ablage wandert in einen neuen Ordner **„Übernommen“** („Übernommen (2)“ …) in der Wurzel der behaltenen Person,
  Benutzer-Freigaben fremder Personen weg, `owner_id`/`created_by`/`deleted_by` umschreiben.

## Benachrichtigungen (2026-10-25, `notify.ts`)
- `file-shared`: neu hinzugekommene Freigaben (ohne „ganzer Stamm“) in `putShares`; `link-upload`: Dateien über einen öffentlichen Upload-Link → Eigentümer*in
  des Ordners (eine Nachricht je Upload-Anfrage, mit optionalem Namen der Person). Beide mit „Täglich“ wählbar.

## Tests und Demo
Unit `tests/unit/files-*.test.ts` (`files-file-types`, `files-upload-queue`, `files-names`, `files-schemas`, `files-helpers` inkl. `breakableName`/`folderMeta`), `icon-data.test.ts`;
**neu** `files-style-quota.test.ts` (Aussehen inkl. Zugriff/Validierung/öffentlicher Link/Audit, Ordnergröße, Kontingent je Person inkl. Upload 413, Meta, Löschen); Integration `tests/integration/files.test.ts`
(Ablage, eine Wurzel mit Freigegebenem, Upload, Papierkorb, Kontingent, Auslieferung), `files-sharing.test.ts` (Freigaben inkl. Stamm, Vererbung, Links,
URL wieder abrufbar, Fehlversuche), **neu** `files-upload-link.test.ts` (Link-Arten, öffentlicher Upload: Modus/Passwort/Grenzen/Kontingent/Namen/kein
Überschreiben/Widerruf während des Uploads/Audit) und `files-migration.test.ts` (Migration 0003 mit Stamm-Daten: Eigentum, `everyone:*`, Namenskonflikte);
Integration `files-thumbs.test.ts` (`core.pdf.renderPage`, PDF-Vorschau beim Upload, kaputtes PDF, Backfill genau einmal);
E2E `tests/e2e/files.spec.ts` (eine Ansicht, Rechtsklick, Upload-Link ohne Login); S3-Ersatz `tests/helpers/s3-mock.ts`.
Demo: `node scripts/seed-demo-files.mjs` (braucht MinIO).

## Offen / Bekannt
- Rollen-Bearbeitungsrechte aus dem früheren `files.shared.edit` wurden bei 0003 **nicht** übertragen (siehe Migration) – ggf. von Hand freigeben.
- Öffentlicher Upload höchstens **30 MB und 10 Dateien je Request** (Core-Grenze für öffentliches Multipart); größere Dateien gehen über Links nicht.
- Öffentlicher Upload kann das Kontingent der Ordner-Eigentümer*in füllen (begrenzt durch Rate-Limit 20/600 s je IP, `files.link.upload-mb` und Kontingent);
  der Core-Router puffert öffentliche Multipart-Bodies (≤ 30 MB) im Speicher, bevor der Link geprüft wird; kein Virenscan.
- Migration 0003 gibt ehemalige Stamm-Wurzeln an `everyone:*` frei – damit sehen sie auch Konten der Rolle „Mitglied“ (Eltern), die früher kein
  `files.shared.view` hatten. Unkritisch, solange keine Instanz mit Stamm-Daten aus der Erstversion existiert; sonst Freigaben nach dem Update prüfen.
- Alte Links aus der Zeit vor 0003 haben keine wieder abrufbare URL (`url = null`); ein geänderter Krypto-Schlüssel macht `token_enc` unlesbar (`url = null`, Link funktioniert weiter).
- Core-Router setzt bei öffentlichen Endpunkten `cache-control: no-store` → Thumbnails öffentlicher Links sind nicht cachebar.
- Core-Router schreibt den Pfad **inkl. Link-Token** in `api_log` (Token-Leck in Logs) – Core-Fix vorgeschlagen: Pfad maskieren.
- Rate-Limit `content` 300/60 s gilt je IP **über alle Links** plus globaler Bucket (viele Thumbnails können andere Links bremsen).
- Zugriffstoken `t` steht in der URL (Logs/Verlauf); gültig 15 min.
- Leere Ordner zählen nicht ins Kontingent.
- Standard-Allowlist und Endung → Typ stehen **einmal** in `$lib/sdk/content-types.ts` (Core + `files`, 2026-10-21): PDF, Bilder (inkl. AVIF), Text/CSV/
  Markdown/JSON, ZIP, Word/Excel/PowerPoint inkl. **Vorlagen** (`dot/dotx`, `xlt/xltx`, `pot/potx`, `pps/ppsx`), RTF, OpenDocument inkl. Vorlagen
  (`ott/ots/otp`). **Makro-Formate** (`docm`, `dotm`, `xlsm` …) bewusst nicht – nur per Einstellung `core.storage.allowedContentTypes`.
- PDF-Vorschaubilder: pdf.js (`pdfjs-dist` 6.4.299) + `@napi-rs/canvas` 1.0.11 (fest gepinnt, Linux-glibc-Binärdatei im Docker-Image `bookworm-slim`); Schriften
  nicht eingebetteter PDFs aus `pdfjs-dist/standard_fonts`. Keine Vorschau für Word/Excel/PowerPoint (bräuchte LibreOffice) – dafür Typ-Symbol.
- Ungeprüft: PDF-Einbettung im echten Browser/mobil, PDF-Vorschaubilder im Produktions-Container, echtes S3 bei großen Dateien, öffentlicher Upload mit echtem S3.

## Dashboard (2026-10-20)
- `GET /recent?limit=1–20` (Std. 8, `files.file.view`, `recent.endpoints.ts`): eigene und freigegebene **Dateien** (keine Ordner, kein Papierkorb),
  neueste zuerst; `parentId` nur, wenn der Ordner selbst sichtbar ist; `manage-all` sieht hier bewusst **keine** fremden Ablagen.
  Kachel `files:recent`. Test `files-recent.test.ts`.

## Datenauskunft (#30)
- `subject-export.ts` (Hook `subjectExport` in `module.ts`): Metadaten der eigenen Ablage inkl. Papierkorb (keine Inhalte, keine Speicherpfade), Uploads in fremde Ordner, Freigaben an Konto/Mitglieder, eigene öffentliche Links (Art, Ablauf, `hasPassword`, Zugriffe – **ohne** Token/Hash/`token_enc`). Test `tests/integration/privacy-subject-export.test.ts`.

## Verweise auf `members`, Löschen und Reset (Stand 2026-10-21, Issue #76 10-09)
- `node_shares` mit `group:`/`member:` (aus `members`, ohne FK): kein `onMemberDeleted`, kein Ereignis beim Löschen einer Gruppe; Reset
  `members:all` impliziert keinen `files`-Bereich – die Freigaben bleiben stehen und erscheinen als „Unbekannt“ (`describePrincipals`).
- Benutzerkonten: `onUserDeleted` löscht die Ablage (Recht auf Löschung), `resetUsers` übernimmt sie (siehe `user-deleted.ts`, `reset.ts`).
