---
paths: ["modules/tasks/**", "tests/**/tasks*"]
---

# Modul `tasks` (Aufgaben, Kanban)

Kanban-Boards mit frei benennbaren Spalten, Aufgaben (Titel, Beschreibung, Priorität, Fälligkeit, **mehrere Zuständige**) und
**Unteraufgaben als Checkliste** (je Titel, abgehakt, optional eine zuständige Person und Fälligkeit). Boards sind freigebbar an
Principals (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in) und können an **eine Aktion** gehängt werden – dann vererbt sich der Zugriff
der Aktion. Schema `mod_tasks`, Version 1.1.0 (2026-10-29, „Aufgaben 2.0“), keine harten Abhängigkeiten, `optionalDependencies: ['members', 'actions']`.
Navigation „Aufgaben“ (Icon `kanban`, `order` 75).

Nutzerentscheidungen (2026-10-25): eigenes Modul **plus** Verknüpfung mit Aktionen; Spalten **frei je Board** (Start Offen · In Arbeit ·
Erledigt, genau eine Erledigt-Spalte); Unteraufgaben als **Checkliste** (keine vollwertigen Unter-Karten).
Nutzerentscheidungen Aufgaben 2.0 (2026-10-29, Konzept-Artifact „Aufgaben 2.0“): UI im bestehenden Design, nur vorhandene Bausteine;
**Phasen je Board** (kein stammweiter Plan), Datum **optional**; Zeitleiste am **Desktop ziehbar** (Rückgängig-Toast), Touch nur ansehen;
Abhängigkeiten nur als Anzeige/Warnung (**keine** automatische Terminverschiebung); Meilensteine **optional im Kalender-Abo** (Schalter je Board,
Standard aus); verschobene Aktion → **Nachfrage** „Daten mitverschieben?“ (nie automatisch).

## Aufgaben 2.0 (v1.1.0, Migr. 0002_planning)
- **Daten**: `board_phases` (Name, Farbe, `starts_on`/`ends_on` optional, CHECK Ende ≥ Beginn, Position), `tasks.phase_id` (FK SET NULL),
  `tasks.starts_on` (CHECK ≤ `due_on`), `tasks.is_milestone` (CHECK ohne Beginn), `boards.default_view` (`board|list|timeline|calendar`),
  `boards.calendar_milestones`, `boards.anchor_on` (Bezugsdatum = Aktionsbeginn bzw. Datum der Vorlage), `board_templates` (eigene Vorlagen,
  `data` jsonb), `task_dependencies` (Vorgänger, beide FK CASCADE, CHECK ≠).
- **Reine Logik**: `phases.ts` (`phaseState`, `currentPhase`, `taskRange`), `timeline.ts` (Zeitraum, Monats-/Wochenköpfe, ISO-KW, `moveRange`,
  `resizeRange`), `templates.ts` (`templateDataSchema`, `BUILTIN_TEMPLATES` „Fahrt / Lager“ + „Tagesaktion“, `applyTemplate`, `templateFromBoard`:
  Offsets in Tagen relativ zu Beginn/Ende, Daten nach dem Aktionsende relativ zum Ende), `dependencies.ts` (`createsCycle`, `startsBeforeBlocker`),
  `schemas.ts` `taskDateIssues` (Beginn ≤ Fällig, Meilenstein nur mit Datum und ohne Beginn; PATCH prüft gegen den gespeicherten Stand, Meilenstein an
  → Beginn entfällt automatisch).
- **API** (`planning.endpoints.ts`, alle `tasks.board.view` + Bearbeiten-Zugriff, Antwort `BoardDetail`): POST/PATCH/DELETE `/boards/:id/phases[/:phaseId]`,
  PUT `…/phases/order` (≤ 20 → 409), POST `/boards/:id/shift { days, apply }` (Phasen, Aufgaben, Unteraufgaben-Fälligkeiten und `anchor_on`; `apply: false`
  = nur Bezugsdatum, blendet den Hinweis aus), GET `/templates` (`tasks.board.create`; mitgelieferte + eigene, `edit-all` alle), POST `/boards/:id/template`
  (≤ 50 je Person), DELETE `/templates/:id` (fremd → 404), POST `/boards` mit `templateId` + `anchorOn` (Standard Aktionsbeginn, sonst heute; Ende aus der
  Aktion), PATCH `/boards/:id` mit `defaultView`/`calendarMilestones` (Aktion verknüpfen setzt `anchor_on` einmalig), PUT `/tasks/:id/dependencies { ids }`
  (nur dasselbe Board, keine Kreise → 422). `BoardDetail`: `phases`, `anchorOn`, `actionStartsOn`, `actionShift` (Tage, sonst `null`); `Board`:
  `currentPhase`, `nextMilestone`, `defaultView`, `calendarMilestones`; `TaskCard`: `phaseId`, `startsOn`, `isMilestone`, `blockedBy`, `openBlockers`;
  `MyTask`: `phase`, `isMilestone`. Audit `tasks.phase.created|updated|deleted|reordered`, `tasks.template.created|deleted`, `tasks.board.shifted`.
- **Kalender-Abo**: `TaskRefsService.calendarMilestones(ctx, window)` → `events` (Migr. 0005 `include_tasks`, Schalter „Meilensteine aus Aufgaben“):
  nur Boards mit `calendar_milestones`, für die Person zugewiesene Meilensteine (ohne Zuständige: alle mit Bearbeiten-Zugriff), ganztägig „◆ Titel“.
- **UI** (`pages/`): `BoardPage` (Hülle: Kopf mit ⋯-Menü Board bearbeiten/Phasen/Spalte/Daten verschieben/Standardansicht/Als Vorlage/Löschen,
  Hinweis „Aktion verschoben“, `board/PhaseStrip`, Reiter Board · Liste · Zeitleiste · Kalender mit `?view=`, `board/BoardFilters` = ein Knopf „Filter · n“
  mit Popover + Chips, `filter.ts`), `views/KanbanView` (＋ im Spaltenkopf legt in der Spalte an, Spaltenmenü per ⋯ und Rechtsklick, Bahnen je Phase
  „Nach Phasen gruppieren“, Ablegen in anderer Bahn ändert die Phase), `views/ListView` (`DataTable mobile="cards"` je Phase, Abhaken), `views/TimelineView`
  (Bänder/Balken/Rauten, Heute-Linie, Pfeile „wartet auf“ – rot bei Konflikt, Ziehen + Tastatur ←/→ mit Umschalt/Alt), `views/CalendarView`
  (`MonthCalendar`), `board/MobileBoard` (Handy: `ScrollPills` + `TouchList`/`ListRow`, langes Drücken → `BottomSheet` + `SheetAction`),
  `board/PhasesDialog`, `task/TaskSheet` + `task/TaskEditor` (ersetzt `TaskDialog`: Seitenblatt rechts bzw. von unten, Autosave mit Statuszeile,
  ↑/↓ zur nächsten Aufgabe), `TaskCardView` (Titel + eine Zeile, Priorität hoch/dringend als linker Rand). `BoardDialog`: Vorlage + Bezugsdatum beim Anlegen,
  Schalter Kalender-Abo beim Bearbeiten. `actions/ActionTasksCard`: „Board anlegen“ mit Vorlagen-Auswahl, zeigt Phase und nächsten Meilenstein.
- **Tests**: `tests/integration/tasks-planning.test.ts`, `tests/unit/tasks-planning.test.ts`, E2E `tests/e2e/tasks.spec.ts`.
- **Offen**: Zeitleiste ohne Zoom über Monate hinaus und ohne Ziehen auf Touch (bewusst); Vorlagen nur persönlich (nicht teilbar); Abhängigkeiten
  ohne Pfeil-Bearbeitung in der Zeitleiste; Phasen-Farben im Kalender nur, wenn gesetzt.

## Dateien (`modules/tasks/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte – **keine** `defaultRoleGrants`, siehe Fallen), Benachrichtigungen, Job `due-reminders` (täglich), Hooks, Endpoints in `withTaskContext` |
| `schemas.ts` | Konstanten (`PRIORITIES`, `DEFAULT_COLUMNS`, `BOARD_COLORS`, Limits), Zod-Eingaben, DTOs (`Board`, `BoardDetail`, `TaskCard`, `TaskDetail`, `ChecklistItem`, `MyTask`, `BoardShares`, `ActionBoardInfo`), reine Helfer `dueState`, `reorder` |
| `access.ts` | `boardShareAccess` (`createShareAccess`), `loadTaskContext`/`withTaskContext` (Principal-Schlüssel + Aktions-Zugriffe **vor** der Transaktion), `resolveBoardAccess`/`requireBoardAccess`, `visibleBoardsFilter`, `boardAccessForMany`, `requireTask(…, 'read'|'edit'|'move')` |
| `boards.service.ts` | Laden in der Transaktion, Namen danach (`buildBoards`, `buildDetail`, `buildTask`, `taskDetail`), `assertAssignable`, `writeColumnOrder`, `lockBoard` (Advisory-Sperre je Board) |
| `boards.endpoints.ts` | Boards, Freigaben, `/principals`, `/boards/:id/people`, Spalten |
| `tasks.endpoints.ts` | Aufgaben, Verschieben, Unteraufgaben, `/my/tasks` |
| `notify.ts` | `notifyAssigned`, `notifyBoardShared`, `sendDueReminders` (Job), `boardLink` |
| `privacy.ts` | `onUserDeleted`, `resetAreas` (`all`, `rebuild`), `resetUsers`, `subjectExport` |
| `search.ts` | Globale Suche: Boards und Aufgaben (sichtbar wie `GET /boards`), Link `?task=` |
| `contract.ts`, `refs.service.ts` | Dienst `TaskRefsService` (`provides`, 2026-10-26): `searchBoardRefs`/`describeBoardRefs`/`searchTaskRefs`/`describeTaskRefs` – sichtbar wie `GET /boards`, prüft `tasks.board.view` selbst; Nutzer: Karten im `whiteboard` |
| `ui.ts`, `pages/` | `''` → `BoardsPage` (Karten mit Phase, Meilenstein, Fortschritt), `:id` → `BoardPage` (siehe „Aufgaben 2.0“); `task/`, `views/`, `board/`, `TaskCardView`, `BoardDialog`, `filter.ts`, `helpers.ts`; Kachel `widgets/MyTasksWidget` („Meine Aufgaben“) |
| `planning.endpoints.ts`, `templates.service.ts` | Phasen, Verschieben, Vorlagen (siehe „Aufgaben 2.0“) |
| `phases.ts`, `timeline.ts`, `templates.ts`, `dependencies.ts` | reine Logik (Server + UI) |
| `migrations/0001_init.sql` | `boards` (UNIQUE `action_id`), `board_shares`, `board_columns`, `tasks` (`column_id` RESTRICT, `completed_at`, `reminded_on`), `task_assignees`, `task_checklist` |
| `migrations/0002_planning.sql` | Phasen, Zeitraum/Meilenstein, Standardansicht, Kalender-Abo, Bezugsdatum, Vorlagen, Abhängigkeiten |

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `tasks.board.view` | Grundrecht aller Endpunkte; eigene, freigegebene, über Aktionen sichtbare Boards und Boards mit eigenen Aufgaben |
| `tasks.board.create` | Boards anlegen (mit Aktion nur bei Bearbeiten-Zugriff auf die Aktion) |
| `tasks.board.view-all` / `edit-all` | alle Boards lesen / bearbeiten, teilen, löschen |

## Zugriff (`access.ts`)
Bearbeiten: System, `edit-all`, Eigentümer*in, Freigabe `edit`, verknüpfte Aktion mit Bearbeiten-Zugriff. Lesen: Freigabe `read`, `view-all`,
Aktion lesbar, **einer Aufgabe oder Unteraufgabe zugewiesen**. Sonst 404. Teilen/Löschen/Aktion umhängen nur Eigentümer*in bzw. `edit-all`.
Zugewiesene mit Lesezugriff dürfen ihre Aufgaben **verschieben** und Unteraufgaben **abhaken** (`requireTask(…, 'move')`), sonst nichts (403).
Aktions-Zugriffe kommen über `ActionsService.accessibleActions(ctx)` (neu in `actions`, ≤ 1000 Aktionen), einmal je Request.

## Regeln
- Zuständige = aktive Konten mit `tasks.board.view` (`assertAssignable`, 422); gespeicherte bleiben ohne erneute Prüfung. Vorschläge
  (`GET /boards/:id/people`): Eigentümer*in, Konten hinter Freigaben (ohne „Stamm“), bisherige Zuständige; mit `search` alle mit Recht.
- Positionen je Spalte 0…n, beim Verschieben neu nummeriert (`reorder`, unter `lockBoard`). In der Erledigt-Spalte → `completed_at`; Wechsel
  der Erledigt-Spalte gleicht alle Aufgaben ab. Spalte mit Aufgaben nur mit `?moveTo=` löschbar (sonst 409), letzte Spalte bleibt.
- Grenzen: 20 Spalten, 2000 Aufgaben je Board, 20 Zuständige, 100 Unteraufgaben (409 bzw. 422).
- Audit `tasks.board.created|updated|deleted|shared`, `tasks.column.created|updated|deleted|reordered`, `tasks.task.created|updated|deleted` –
  nur IDs/Zähler/Feldnamen. Verschieben und Abhaken werden nicht auditiert (zu häufig).

## API (`/api/v1/modules/tasks/…`, alle `tasks.board.view`, sonst angegeben)
| Methode + Pfad | Besonderheiten |
|---|---|
| GET/POST `/boards` | POST braucht `create`; `actionId` optional (409 bei zweitem Board) |
| GET `/boards/by-action/:actionId` | `{ board, canCreate }` für die Karte in der Aktion; Aktion nicht sichtbar → 404 |
| GET/PATCH/DELETE `/boards/:id` | PATCH `actionId` nur Eigentümer*in; DELETE löscht alles |
| GET/PUT `/boards/:id/shares`, GET `/principals` | wie `events`/`galleries` (`requireShareCapability`) |
| GET `/boards/:id/people?search` | Bearbeiten-Zugriff |
| POST `/boards/:id/columns`, PUT `…/columns/order`, PATCH/DELETE `…/columns/:columnId[?moveTo]` | Antwort `BoardDetail` |
| POST `/boards/:id/tasks`, GET/PATCH/DELETE `/tasks/:id`, POST `/tasks/:id/move` | `move` `{ columnId, position }` |
| POST `/tasks/:id/checklist`, PUT `…/checklist/order`, PATCH/DELETE `…/checklist/:itemId` | PATCH nur `done` = `move`-Recht |
| GET `/my/tasks?limit&done` | zugewiesen (direkt oder offene Unteraufgabe), Fälligkeit, Priorität |

## Benachrichtigungen
`task-assigned` (neu zugewiesen, auch Unteraufgaben, Sammelmail möglich), `task-due` (Job, heute/morgen fällig, einmal je Tag über
`reminded_on`; neue Fälligkeit setzt es zurück), `board-shared` (neu/hochgestuft, ohne „Stamm“). Nie an die handelnde Person.

## Aktion
`actions` zeigt in der Übersicht die Karte `ActionTasksCard` (nur REST, kein Import): Zähler + „Board öffnen“ bzw. „Board anlegen“
(Name = Aktion). Die Freigabe der Aktion gilt für das Board zusätzlich zu dessen eigenen Freigaben.

## Tests
`tests/integration/tasks.test.ts` (Standardspalten, Zugriffsmatrix inkl. Gruppe/Zuweisung/Aktion, Aufgaben + Unteraufgaben, Verschieben/Erledigt,
Reihenfolge, Validierung, „Meine Aufgaben“, Spalten, Aktion-Board und Vererbung, Audit ohne Inhalte, Fälligkeits-Job, Konto löschen, Modul aus);
E2E `tests/e2e/tasks.spec.ts` (Board anlegen, Schnell-Anlegen, Unteraufgabe abhaken, per Spaltenauswahl erledigen, per Ziehen verschieben inkl. Neuladen, Board aus der Aktion anlegen).

## Fallen
- **Keine `defaultRoleGrants` an Rollen, die andere Module verleihen** (z. B. „Amtsinhaber*in“): Die Rechte stehen dann an der Rolle, sind aber bei
  inaktivem Modul niemandem wirksam → `assertCanGrant` lehnt das Besetzen von Ämtern als „Rechteausweitung“ ab (E2E `offices.spec.ts` fiel so um).
- Beim Ziehen nie das Element unter dem Mauszeiger aus dem DOM nehmen (Platzhalter „Keine Aufgaben“ bleibt), sonst kommt in Chromium kein `drop`;
  `onDrop` berechnet die Position selbst, weil `dragleave` das Ziel vorher löschen kann.

## Offen
- Ziehen & Ablegen nur mit Maus (Handy: Aktionsblatt nach langem Drücken, Tastatur Alt+←/→, „Stand“ im Seitenblatt).
- Keine Kommentare, Anhänge, Labels, wiederkehrenden Aufgaben; Unteraufgaben im Blatt nicht per Ziehen sortierbar (API `…/checklist/order` vorhanden).
- Zuständige ohne eigene Board-Freigabe sehen das ganze Board lesend (bewusst: Zuweisen = Einblick).
