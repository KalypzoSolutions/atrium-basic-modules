---
paths: ["modules/events/**", "tests/**/events*", "src/lib/sdk/**/sharing.ts", "tests/**/sharing*"]
---

# Modul `events` (Termine)

Interne Termine des Stammes und Termine für die **Stammeswebsite**, auch als **Serien** (Wiederholungstermine).
Schema `mod_events`, Version 1.5.0, keine harten
Abhängigkeiten; `optionalDependencies: ['members', 'actions']` (`actions` nur fürs Kalender-Abo) (Gruppen für Zuordnung, Gruppen/Mitglieder als Freigabe-Ziele –
ohne `members` nur Stamm, Rollen, Benutzer*innen). Erstes Modul mit der generischen **Freigabe an Principals**
(`$lib/sdk/server/sharing.ts`, siehe `architecture.md` → „Freigabe an Principals“). Navigation „Termine“ (Icon `calendar`)
als eigener Eintrag (`order` 10, ganz oben nach dem Dashboard).

## Dateien (`modules/events/`)
| Datei | Inhalt |
|---|---|
| `module.ts` | Manifest (Rechte, `defaultRoleGrants`, Navigation), Einstellung `events.stamm.name`, Migrationen, `search`, `resetAreas`/`resetUsers`, `onUserDeleted`, `subjectExport`, `provides` (`EventRefsService`), Endpoints (Reihenfolge `website` → `meta` → `events`); Dashboard-Kachel `upcoming` in `ui.ts` |
| `ui.ts` | Route `''` → `EventsPage` |
| `schemas.ts` | API-Vertrag (Server + UI): `eventInput` (inkl. `recurrence`), `recurrenceRule`/`recurrenceEnd`, `checkRecurrence`, `occurrenceParams`, `detailQuery`, `occurrenceOverride`, `occurrenceInput`, `shareInput`, `listQuery`, `websiteQuery`, `websiteEventQuery` (`occurrence`), `principalSearchQuery`, `tagsQuery`, `idParams`, `checkEventDates`, `normalizeTag(s)`, `isRealDate`, Konstanten (`STAMM_GROUP_ID = 'stamm'`, `MAX_TAGS` 20, `MAX_TAG_LENGTH` 40, `MAX_GROUPS` 50, `MAX_SHARES` 200, `COLOR_PRESETS`, `SHARE_LEVEL_LABELS` Sehen/Bearbeiten, `RECURRENCE_FREQS`/`_LABELS`, `MONTHLY_MODES`, `MAX_RECURRENCE_COUNT` 500, `MAX_OCCURRENCES` 2000, `OPEN_WINDOW_DAYS` 366), DTOs `EventItem`, `EventDetail`, `EventList`, `EventShare`, `EventAccess`, `EventGroupRef` (mit `meeting*`), `WebsiteEvent` |
| `recurrence.ts` (rein) | Serienlogik nur auf `YYYY-MM-DD`-Strings (UTC): `expandOccurrences`, `isOccurrence`, `lastOccurrence`, `minGapDays`, `describeRecurrence` (deutscher Text), Helfer `addDays`, `daysBetween`, `isoWeekday`, `nextWeekday` – Server **und** UI |
| `access.ts` | Nur Konfiguration des SDK-Bausteins `createShareAccess` (#35): `eventAccess` → `resolveAccess`, `requireAccess` (404/403), `visibleEventsFilter` (SQL, Alias `e`), `accessForMany`, `loadShares`, `replaceShares` |
| `events.service.ts` | In der Transaktion: `hydrateRows`, `loadEventRow`, `loadShares`, `insertEvent`, `updateEvent` (Tags/Gruppen/Freigaben komplett ersetzen, verwaiste Ausnahmen löschen), `loadExceptions`, `upsertException`, `deleteException`. Rein: `expandRow`, `singleOccurrence`, `occurrenceAt`, `mergeOccurrenceDates`, `validateOverride`, `compareOccurrences`, `resolveDetailOccurrence`, `resolveWebsiteOccurrence` (Website-Detail), `seriesInfo`, `todayBerlin()`. Danach (Core): `validateGroupIds`, `buildItems`, `buildDetail` (Besitzer via `core.users.directory`, Freigaben via `describePrincipals`) |
| `events.endpoints.ts` | CRUD `/events`, Vorkommen `/events/:id/occurrences/:date` |
| `meta.endpoints.ts` | `/groups`, `/tags`, `/principals`, `/settings/stamm` |
| `website.schemas.ts` | Zod-Vertrag `websiteEventSchema`, `websiteEventPageSchema` (strikt, Typgleichheit zu `WebsiteEvent`/`WebsiteEventPage` geprüft), Query `websiteEventsQuery` (`offset`, `paged`) |
| `website.endpoints.ts` | `/website/events` (Paging), `/website/events/:id`; gemeinsamer DTO-Aufbau `toWebsiteEvents` (Gruppennamen + `groupIds`, nach der Transaktion); re-exportiert `todayBerlin` aus dem Service |
| `contract.ts` / `refs.service.ts` | Dienst `EventRefsService` (`provides`) für andere Module, z. B. `galleries`: `searchEventRefs(ctx,{search,limit})`, `describeEventRefs(ctx, ids)` (nur für `ctx` sichtbare Termine, ohne `events.event.view` → `[]`, System sieht alles), `websiteEventRefs(ids)` (nur `on_website`, ohne Rechteprüfung); Abruf per `core.modules.useOptional('events', …)`, nie in offener Transaktion |
| `groups.ts` | `stammName()` (Einstellung, Fallback „Stamm Edelweißpiraten“), `loadGroupMap()` (Stamm + `members.listGroups()`) – ruft Core auf, **nie in einer Transaktion** |
| `format.ts` (rein) | `isAllDay`, `formatEventTime`, `formatEventDate`, `formatEventRange` (de-DE, für UI) |
| `reset.ts` | Reset-Bereich `all` (alle fünf Tabellen inkl. `event_exceptions`, `rebuild`, keine `implies`, keine Dateien), `resetUsers` (Benutzer-Freigaben löschen, Termine/`created_by`/`event_exceptions.updated_by` auf den verbleibenden Benutzer) |
| `search.ts` | Globale Suche (`eventsSearch`): Termine nach Titel, Ort und Tags, sichtbar wie `GET /events` (`visibleEventsFilter`, Principal-Schlüssel vor der Transaktion); Serien einmal mit nächstem (sonst letztem) Vorkommen, Link `?event=` |
| `user-deleted.ts` | `onUserDeleted`: Freigaben `user:<id>` löschen, Eigentum an `transferTo` (sonst unverändert), `created_by`/`event_exceptions.updated_by`/`event_shares.created_by` → `NULL` |
| `subject-export.ts` | Datenauskunft (`subjectExport`): eigene/angelegte Termine, Freigaben an das Konto oder an Mitglieder der Person, von der Person geänderte Einzeltermine; Gruppen-Zuordnungen sind keine Personendaten |
| `pages/EventsPage.svelte` | Hauptseite: Tabs Monat (Standard)/Liste (URL `view=list`, `month`), Filter Suche/Gruppe/Tag, „Auch vergangene“ (`past=1`), Pagination; Einträge per `key` (Vorkommen) |
| `pages/EventDialog.svelte` | Ansicht (gesperrter Dialog), Anlegen, Bearbeiten (Serie) und Bearbeiten eines Vorkommens (`edit-occurrence`); Felder, `TagInput`, `ColorPicker`, Gruppen, Sichtbarkeit per `SharePanel` lokal, Website-Checkbox, Wiederholung, Absagen/Wieder ansetzen/Auf Serie zurücksetzen |
| `pages/RecurrenceField.svelte` | Eingabe der Wiederholung (Rhythmus, Intervall, Wochentage, Monatsmodus, Ende nie/bis/Anzahl) mit Zusammenfassung per `describeRecurrence`; `readonly` zeigt nur den Text |
| `pages/SeriesChoiceDialog.svelte` | Generische Auswahl (`options` mit `label`/`description`/`destructive`, `onchoose`) für „Nur diesen Termin / Ganze Serie“ |
| `migrations/0001_init.sql` | Schema |
| `migrations/0002_recurrence.sql` | Serien: `recurrence`, `recurrence_until`, `event_exceptions` |
| `export.ts` | PDF-Export, reine Aufbereitung: `ExportEntry` aus `EventItem`/`CalendarAction` (`entryFromEvent`/`entryFromAction`), `listBlocks` (Terminliste), `monthCalendarHtml`/`calendarBlocks` (Monatskalender), `yearPlanHtml`/`yearBlocks` (Jahresplan), `exportTitle`, `exportFileName`, `tint`, `monthsBetween`, `monthWeeks` |
| `export.endpoints.ts` | `GET /events/export.pdf`, `GET /events/export/options` (siehe „Export“) |
| `pages/ExportDialog.svelte` | Dialog „Termine exportieren“ (Knopf „Exportieren“ im Seitenkopf der Terminseite) |
| `ical.ts` (rein) | iCalendar (RFC 5545): `buildCalendar`, `eventTimes`, `escapeText`, `foldLine` (75 Bytes, UTF-8-sicher), `utcStamp`; `TZID=Europe/Berlin` + `VTIMEZONE` |
| `calendar-feeds.service.ts` | Kalender-Abos: `listFeeds`/`createFeed`/`updateFeed`/`rotateFeed`/`deleteFeed`, `renderFeed` (öffentlicher Abruf), `feedUrl`, Backup-Hook `calendarFeedsBackup.rehash` |
| `calendar.endpoints.ts` | `/calendar-feeds[/:id[/rotate]]`, öffentlich `/public/calendar/:token` |
| `pages/CalendarFeedsPanel.svelte`, `CalendarFeedDialog.svelte`, `CalendarFeedsCard.svelte` | Abos verwalten (Profilkarte „Kalender-Abo“ und Dialog „Kalender abonnieren“ auf der Terminseite) |
| `migrations/0004_calendar_feeds.sql` | `calendar_feeds` |
| `migrations/0003_checks.sql` | DB-CHECKs als Rückhalt zur Zod-Prüfung (#73): `starts_at`/`ends_at` `HH:MM`, Enduhrzeit nur mit Enddatum, `ends_on ≥ starts_on`, gleicher Tag `ends_at ≥ starts_at`; Altbestand vorher bereinigt (ungültige Werte → `NULL`), dann `VALIDATE`. Test `tests/integration/db-constraints.test.ts` |

## Datenmodell (0001)
- `events`: `id` (UUID), `title`, `description`, `location`, `color` (CHECK `#rrggbb` klein oder NULL), `starts_on date`,
  `starts_at text` (`HH:MM`), `ends_on date`, `ends_at text`, `on_website boolean` (Standard `false`), `owner_id text`
  (ohne FK), `created_by`, `created_at`, `updated_at`. Indizes auf `starts_on`, `owner_id`, `(on_website, starts_on)`.
- `event_tags` (PK event+tag, `position`, FK CASCADE; Index `lower(tag)`). Tags werden normalisiert (NFC, trimmen,
  Leerzeichen zusammenfassen) und ohne Groß-/Kleinschreibung dedupliziert; Reihenfolge = `position`.
- `event_groups` (PK event+group, FK CASCADE): **Zuordnung** (für wen ist der Termin, Anzeige/Filter/Website) –
  `group_id = 'stamm'` (ganzer Stamm) oder Gruppen-ID aus `members` (ohne FK). Wirkt **nicht** auf die Sichtbarkeit.
- `event_shares` (PK event+`principal_type`+`principal_id`, FK CASCADE): **Sichtbarkeit/Bearbeitung**, `principal_type`
  CHECK `everyone|group|role|user|member`, `level` CHECK `read|edit`, `created_by`, `created_at`; Index `(principal_type, principal_id)`.
- Zeiten wie bei Aktionen: Ende optional; Enduhrzeit braucht Enddatum; Ende ≥ Start (am selben Tag auch Uhrzeit). Datum
  wird per `to_char(…,'YYYY-MM-DD')` gelesen (treiberunabhängig).

## Datenmodell (0002, Serien)
- `events.recurrence jsonb` (Regel, siehe unten; `NULL` = einmaliger Termin), `events.recurrence_until date` = **letztes
  Vorkommen** (Startdatum) aus `lastOccurrence`; `NULL` bei einmaligen Terminen und offenen Serien (`end.type = never`).
  Teilindex `(starts_on, recurrence_until) WHERE recurrence IS NOT NULL`. Die Startfelder der Zeile sind das **erste**
  Vorkommen, Titel/Ort/Zeiten gelten für alle Vorkommen.
- `event_exceptions` (PK `event_id` + `occurrence_date`, FK CASCADE): je Vorkommen (Schlüssel = **ursprüngliches** Datum)
  `cancelled boolean`, `override jsonb` (abweichende Felder), `updated_by`, `updated_at`. Eine Ausnahme ohne Absage und ohne
  Override wird gelöscht statt gespeichert.

## Serien (Wiederholungstermine)
- **Regel** (`recurrenceRule`, strikt): `freq` `daily|weekly|monthly|yearly`, `interval` 1–99 (Standard 1), `byWeekday`
  (nur `weekly`, ISO 1 = Mo … 7 = So, dedupliziert/sortiert; leer = Wochentag des Starts), `monthlyMode`
  (nur `monthly`/`yearly`: `day` Standard | `nth-weekday` | `last-weekday`), `end` `{type:'never'}` (Standard) |
  `{type:'until', date}` | `{type:'count', count 1–500}`.
- `checkRecurrence` (422): Serienende vor Start (`recurrence.end.date`), `byWeekday` ohne `weekly`, `monthlyMode` ohne
  monatlich/jährlich, Dauer eines mehrtägigen Vorkommens ≥ kleinster Abstand (`minGapDays`, Pfad `endsOn`).
- **Semantik** (`recurrence.ts`, angelehnt an RFC 5545, nur Tage): erstes Vorkommen = `startsOn`; bei `weekly` mit
  `byWeekday` zählt der Start nur, wenn sein Wochentag enthalten ist. `interval` = jeder N-te Tag / jede N-te Woche (Woche ab
  Montag der Startwoche) / Monat / Jahr. `day`: gleicher Tag im Monat, Monate ohne diesen Tag **fallen aus** (31., 29.02.);
  `nth-weekday`: n-ter Wochentag wie beim Start (5. fällt in Monaten ohne 5. aus); `last-weekday`: letzter Wochentag wie
  beim Start. `end.count` zählt ab dem Start, **Absagen zählen mit**. Mehrtägige Serien: Ende je Vorkommen um die Dauer verschoben.
- **Fenster/Kappung**: Serien werden in JS expandiert (nie in SQL). Ohne `to` gilt ein Fenster von `OPEN_WINDOW_DAYS` (366)
  ab `from` bzw. heute. Je Abfrage höchstens `MAX_OCCURRENCES` (2000) Vorkommen; SQL lädt höchstens `LIST_ROW_CAP` 5000
  Kandidaten-Zeilen (Website `WEBSITE_ROW_CAP` 5000). `/events` sortiert und paginiert erst **nach** dem Expandieren
  (`offset`/`limit` auf Vorkommen, `total` = gekappte Anzahl). SQL-Vorfilter für Serien: `starts_on ≤ to` und
  `recurrence_until + Dauer ≥ from` (oder offen).
- **Ausnahmen**: absagen (`cancelled`) und/oder einzeln ändern (`override`: `title`, `description`, `location`, `startsOn`,
  `startsTime`, `endsOn`, `endsTime`, alles optional). Nur `startsOn` verschoben → Ende wandert mit. `validateOverride` prüft
  die zusammengeführten Daten mit `checkEventDates` (422, Pfade `override.<feld>`). Abgesagte Vorkommen fehlen in Listen und
  auf der Website; verschobene erscheinen am neuen Datum (auch wenn sie von außerhalb ins Fenster geschoben wurden).
  `isException` am Item markiert abweichende Vorkommen. Suche durchsucht auch Override-Texte.
- **PUT der Serie** (`updateEvent`) räumt auf: Ausnahmen, deren Datum kein Vorkommen der neuen Regel mehr ist, werden gelöscht;
  ohne Serie (`recurrence: null`) alle Ausnahmen.
- **Detail** (`GET /events/:id?occurrence=YYYY-MM-DD`): `occurrenceDate`, Start-/Endfelder und Texte des Vorkommens (mit
  Override); `series` = Werte der Serie selbst (Titel/Beschreibung/Ort/Daten, sonst `null`); nur bei `edit`: `override`
  (gespeicherter Override dieses Vorkommens), `cancelledDates`, `exceptionDates` (sonst `null`/`[]`). Ohne `occurrence`:
  erstes nicht abgesagtes Vorkommen ab heute, sonst das erste. `occurrence` kein Vorkommen bzw. bei einmaligem Termin → 404;
  abgesagtes Vorkommen für Lesende → 404.
- `EventItem.key` = `id` bzw. `id:occurrenceDate` (eindeutig in Listen/Kalender), dazu `occurrenceDate`, `recurrence`, `isException`.

## Rechte
| Schlüssel | Bedeutung |
|---|---|
| `events.event.view` | Grundrecht für alle internen Endpoints; sieht eigene und freigegebene Termine. Rolle „Mitglied“ bekommt es per `defaultRoleGrants` |
| `events.event.create` | Termine anlegen (Handler prüft zusätzlich `view`; nur Benutzer, nicht System → 400) |
| `events.event.view-all` | alle Termine lesen |
| `events.event.edit-all` | alle Termine bearbeiten/löschen (impliziert Lesen); System-Kontext ebenso |
| `events.event.publish` | `onWebsite` beim Anlegen setzen bzw. von nein auf ja ändern (sonst 403; #67 01b-06); Zurücknehmen geht mit edit. Audit `events.event.published`/`unpublished`. Nur „Administrator“ bekommt es automatisch |
| `events.website.read` | **nur** `GET /website/events[/:id]` – Scope für den API-Key der Stammeswebsite; gibt keinen Zugriff auf interne Endpoints |

## Zugriffsregeln (`access.ts`)
1. System oder `edit-all` → bearbeiten. 2. Eigentümer*in (`owner_id`) → bearbeiten. 3. Freigabe `edit` an einen passenden
Principal → bearbeiten. 4. Freigabe `read` oder `view-all` → lesen. 5. Sonst **404** (Existenz nicht verraten); Lesen ohne
Bearbeiten bei `PUT`/`DELETE` → **403**.
- Principal-Schlüssel des Aufrufers immer **vor** der Transaktion: `principalKeysFor(ctx, 'events')`.
- `PUT` ersetzt Tags, Gruppen **und Freigaben** komplett – auch Freigabe-Bearbeiter*innen dürfen Freigaben ändern
  (auch sich selbst entfernen; die Antwort bestimmt den Zugriff danach neu). Eigentümer*in ist nicht änderbar.
- `shares` erscheinen im Detail nur bei Bearbeiten-Zugriff (sonst `[]`).

## Sichtbarkeit (Principals)
| Typ | ID | Wirkt für |
|---|---|---|
| `everyone` | `*` | jeden angemeldeten Benutzer mit `events.event.view` (also auch verknüpfte Konten mit Rolle „Mitglied“) – Anzeige mit dem Stammesnamen |
| `group` | Gruppen-ID (`members`) | Konten, die mit einem aktiven Mitglied der Gruppe verknüpft sind (Mitgliedschaft **oder** Leitung) |
| `role` | Rollen-ID | Benutzer mit dieser Rolle |
| `user` | Benutzer-ID | dieses Konto |
| `member` | Mitglieds-ID (`members`) | alle mit dem Mitglied verknüpften Konten (ausgetretene Mitglieder zählen nicht) |
- Eingabe `shares: [{ type, id, level }]` (≤ 200, keine Duplikate `typ:id`, `everyone` nur mit `*`), Prüfung auf Existenz
  per `validatePrincipals` → 422 mit Pfad `['shares', i, 'id']`. Ohne `members` sind `group`/`member` unbekannt (422).
- Suche: `GET /principals?search=` (ab 2 Zeichen) → `searchPrincipals` (Reihenfolge Stamm, Gruppen, Rollen, Mitglieder,
  Benutzer*innen; je Typ ≤ 10; „Stamm“/„alle“/Stammesname finden `everyone`).

## API (`/api/v1/modules/events/…`, Session oder API-Key, nicht öffentlich)
| Methode + Pfad | Recht | Besonderheiten |
|---|---|---|
| GET `/events` | event.view | Nur sichtbare Termine. Query `from`/`to` (Überlappung: `COALESCE(ends_on,starts_on) ≥ from`, `starts_on ≤ to`), `search` (Titel/Ort/Beschreibung ILIKE, maskiert), `tag` (exakt, ohne Groß-/Kleinschreibung), `groupId`, `limit` 1–500 (200), `offset`; `{ items, total }`, je Item `access { level, isOwner }`, sortiert nach Beginn |
| GET `/events/:id` | event.view | `EventDetail`; Query `occurrence` (Vorkommen einer Serie, siehe „Serien“); 404 ohne Zugriff; `shares` nur bei `edit` |
| POST `/events` | event.create (+ view) | `eventInput` strikt (inkl. `recurrence`); Eigentümer*in = Aufrufer; Gruppen-IDs geprüft (422 `groupIds[i]`), Principals geprüft |
| PUT `/events/:id` | event.view + Objekt-`edit` | ersetzt alles (gleiches Schema wie POST), bei Serien die **ganze Serie**; verwaiste Ausnahmen werden gelöscht |
| DELETE `/events/:id` | event.view + Objekt-`edit` | hartes Löschen (CASCADE, ganze Serie samt Ausnahmen) → `{ id, deleted: true }` |
| PUT `/events/:id/occurrences/:date` | event.view + Objekt-`edit` | Vorkommen (ursprüngliches Datum) absagen/ändern, Body `{ cancelled = false, override = null }`; beides leer → Ausnahme gelöscht; → `EventDetail` des Vorkommens. 400 kein Serientermin, 404 kein Vorkommen, 422 Override |
| DELETE `/events/:id/occurrences/:date` | event.view + Objekt-`edit` | Vorkommen auf die Serie zurücksetzen (Absage/Override entfernen) → `EventDetail` |
| GET `/groups` | event.view | `[{ id, name, color, meetingWeekday, meetingTime, meetingEndTime, meetingPlace }]` (Gruppenstunde aus `members`, beim Stamm `null`), `stamm` zuerst, danach `members`-Gruppen nach Name |
| GET `/tags` | event.view | verwendete Tags über **alle** Termine (häufigste zuerst, case-insensitiv zusammengefasst, ≤ 50), optional `search` (Teilstring) |
| GET `/principals` | event.view | Query `search` (2–100 Zeichen, sonst 422) → `PrincipalInfo[]`; nur mit `create`/`edit-all`/eigenem Termin/`edit`-Freigabe (sonst 403), 60/60 s; Mitglieder nur mit `members.member.view`, E-Mail nur mit `core.users.view` |
| GET `/settings/stamm` | event.view | `{ name }` (Einstellung `events.stamm.name`) |
| GET `/website/events` | **website.read** | siehe unten; Rate-Limit 120/60 s |
| GET `/website/events/:id` | **website.read** | ein `WebsiteEvent`, Query `occurrence`; siehe unten; Rate-Limit 120/60 s |

Audit: `events.event.created|updated|deleted` (`target` = ID; metadata nur `onWebsite` und Zähler `tags`, `groups`, `shares`),
`events.event.occurrence_updated` (metadata `cancelled`, Zähler `fields`) und `events.event.occurrence_reset` – ohne Inhalte.

## Website-Anbindung
- Termine mit „auf der Website“ (`onWebsite: true`) liefert `GET /website/events` – **unabhängig von Freigaben**
  (die Website-Markierung ist die Veröffentlichung). Nur öffentliche Felder (`WebsiteEvent`): `id`, `title`, `description`,
  `location`, `color`, `startsOn`, `startsTime`, `endsOn`, `endsTime`, `tags`, `groups` (Namen, inkl. Stammesname; keine
  Gruppenstunden-Daten), `groupIds` (gleiche Reihenfolge wie `groups`: `stamm` zuerst, dann `members`-Gruppen nach Name;
  Zuordnungen zu unbekannten Gruppen – z. B. `members` aus – fehlen in beiden), `recurring`, `occurrenceDate` – keine Freigaben,
  Eigentümer*innen, Zeitstempel.
- **Serien**: jedes Vorkommen ist ein **eigener Eintrag** mit gleicher `id`, `recurring: true` und `occurrenceDate`
  (ursprüngliches Datum; stabiler Schlüssel `id` + `occurrenceDate`), Felder inkl. Override; abgesagte Vorkommen fehlen.
  Einmalige Termine: `recurring: false`, `occurrenceDate: null`. Ohne `to` höchstens `OPEN_WINDOW_DAYS` (366) voraus.
- Query: `from` (Standard **heute in Europe/Berlin**, `todayBerlin()`), `to` (optional; `to < from` → 422), `tag`,
  `group` (Gruppen-ID als UUID oder `stamm`, sonst 422; SQL-`EXISTS` auf `event_groups`, unbekannte Gruppe → leere Liste),
  `limit` 1–200 (50, zählt Vorkommen), `offset` (0, Vorkommen), `paged` (`1`/`true`/`0`/`false`, sonst 422): mit `paged=1` Antwort
  `WebsiteEventPage { items, total, offset, limit, hasMore }` statt Array (#48, abwärtskompatibel; Schemas `website.schemas.ts`). Überlappungslogik wie `/events`; Sortierung Beginn, Uhrzeit (ohne zuerst), Titel.
- **Detail** `GET /website/events/:id?occurrence=YYYY-MM-DD` (`idParams`, `websiteEventQuery`): **404**, wenn unbekannt oder nicht
  `on_website` (keine UUID → 422). Logik in `resolveWebsiteOccurrence` (nutzt `resolveDetailOccurrence`/`expandRow`):
  einmaliger Termin → der Termin (mit `occurrence` → 404); Serie **mit** `occurrence` → genau dieses Vorkommen mit Override
  (kein Vorkommen oder **abgesagt** → 404); Serie **ohne** `occurrence` → nächstes nicht abgesagtes Vorkommen, das heute
  (Europe/Berlin) noch nicht vorbei ist (inkl. laufender und hineinverschobener; Suche bis 366 Tage voraus), sonst das **letzte**
  nicht abgesagte (Rückwärtssuche in wachsenden Fenstern), alle abgesagt → 404. Anders als das interne Detail (dort Fallback = erstes).
- Einrichtung:
  1. Benutzer*in mit `events.website.read` (z. B. Admin) legt unter Administration → API-Keys (`POST /api/v1/api-keys`,
     Session) einen Key mit **nur** dem Scope `events.website.read` an (Rechte = Scopes ∩ Besitzerrechte; Besitzer*in
     muss das Recht behalten, sonst 403). Key wird nur einmal angezeigt.
  2. Die Website ruft **serverseitig** ab (Key nie im Browser; kein CORS vorgesehen), Antwort `{ data: WebsiteEvent[] }`:
     ```bash
     curl -H "Authorization: Bearer epk_…" \
       "https://intern.example.org/api/v1/modules/events/website/events?from=2026-10-01&to=2026-12-31&limit=20"
     ```
  3. Antwort cachen (z. B. einige Minuten); Modul deaktiviert → `404 module_disabled`.
- Ein Key nur mit diesem Scope bekommt auf `/events` usw. **403** (Test vorhanden).
- Die Stammeswebsite (`website/`, siehe `website.md`) nutzt Liste (Startseite, `/termine`, Gruppenseiten mit `group`) und Detail
  (`/termine/[id]?am=`); Übersicht aller vier Website-APIs in `docs/api.md` → „Stammeswebsite“. Demo: `scripts/seed-demo-website.mjs`.

## UI
- `EventsPage`: Tabs „Monat“ (**Standard**; `MonthCalendar`, lädt das ganze Raster inkl. Randwochen, `limit` 500, `onday` → Dialog
  mit Datum bei `create`-Recht; Serien mit `recurring`-Symbol, `key` je Vorkommen) und „Liste“ (`?view=list`; `DataTable mobile="cards"`,
  ab heute, „Auch vergangene“, Serien-Hinweis). Klick → `EventDialog` im Modus `view` (mit `occurrenceDate`); „Neuer Termin“ nur mit
  `events.event.create`.
- `EventDialog`: Titel, Beschreibung, Ort, Start/Ende mit optionaler Uhrzeit, Farbe (`COLOR_PRESETS`), Gruppen (`MultiSelect`), Tags
  (`TagInput`, Vorschläge `GET /tags`), **Sichtbarkeit** (`SharePanel` im lokalen Modus, `everyoneLabel` = Stammesname aus `GET /groups`,
  Suche `GET /principals`), Checkbox „Auf der Stammeswebsite anzeigen“. Bei neuen Terminen **folgt die Sichtbarkeit den gewählten Gruppen**
  (Stamm → `everyone`, Gruppe → `group`, Stufe „Sehen“), bis man sie selbst ändert. **Wiederholung** über `RecurrenceField`.
  **Vorschlag Gruppenstunde**: solange keine Wiederholung gesetzt ist, bietet der Dialog je gewählter Gruppe mit `meetingWeekday`
  „Gruppenstunde <Gruppe>: dienstags 17:00, <Ort>“ an → übernimmt wöchentliche Serie (offen), Uhrzeit, Ende der Gruppenstunde (`meetingEndTime`, am selben Tag, wenn kein anderes Enddatum gesetzt ist), Ort (falls leer) und
  schiebt den Start auf den passenden Wochentag.
- **Ansicht = gesperrter Dialog** (kein Sheet mehr): dasselbe Formular im deaktivierten `fieldset`, Freigaben + Bearbeiten/Löschen
  nur bei `edit`. Abgesagtes Vorkommen: Hinweis „ist abgesagt“ + „Wieder ansetzen“.
- **Serien** bearbeiten/löschen: `SeriesChoiceDialog` mit „Nur diesen Termin (Datum)“ / „Ganze Serie“ bzw. „Nur diesen Termin
  absagen“ (Rückgängig-Toast) / „Ganze Serie löschen“ (danach Bestätigung). „Nur diesen Termin“ ändert Titel, Beschreibung, Ort
  und Zeit (Override; Farbe, Gruppen, Tags, Sichtbarkeit, Website gelten für die ganze Serie) und bietet „Auf Serie zurücksetzen“.
  „Ganze Serie“ lädt die Seriendaten (`series`), zeigt die Zahl einzeln geänderter Termine und die abgesagten Termine mit
  „Wieder ansetzen“.
- E2E: `tests/e2e/events.spec.ts` (Monat als Standard, anlegen/ansehen/bearbeiten, Serie anzeigen und ein Vorkommen absagen).

## Benachrichtigungen (2026-10-25, `notify.ts`, core.notifications)
- Typen `event-new` (angelegt oder neu sichtbar geworden), `event-changed` (nur Datum/Uhrzeit/Ort/Wiederholung bzw. Vorkommen verschoben),
  `event-cancelled` (Termin gelöscht oder Vorkommen abgesagt) – alle **Standard „Aus“** (sonst Mail an alle Eltern bei jedem Termin), neu/geändert mit „Täglich“.
- Empfänger = wer den Termin sehen darf: Eigentümer*in + Freigaben über `principalUserIds` (`everyone` = alle mit `events.event.view`), nie die handelnde Person,
  nur kommende Termine. `eventSnapshot` vor PUT/DELETE, Vergleich der Zielgruppen (neu sichtbar → „Neuer Termin“).

## Tests
- Unit: `tests/unit/events-schemas.test.ts` (Daten, Tags, Freigaben, Query-Grenzen), `events-format.test.ts`,
  `events-reset.test.ts` (Tabellen aus Migrationen abgedeckt, Reihenfolge Kind vor Eltern), `sharing.test.ts`
  (`principalMatchSql`, Schlüssel), `month-calendar.test.ts`, `tag-input.test.ts`, `events-recurrence.test.ts`
  (Datums-Helfer, Rhythmen, Ende/Fenster/Grenzen, `isOccurrence`, `lastOccurrence`, `minGapDays`, `describeRecurrence`).
- Integration `events-recurrence.test.ts`: Liste (Expansion, `recurrence_until`, `OPEN_WINDOW_DAYS`, Pagination über Vorkommen),
  Absage/Override/Detail mit `occurrence`, Lesende ohne Ausnahme-Daten, Fehlerfälle 404/422/403/400, Zurücksetzen, Website,
  Aufräumen verwaister Ausnahmen beim Ändern der Serie, Audit ohne Inhalte.
- Integration: `events-module.test.ts` (Tabellen, Rechte, `defaultRoleGrants`, Stammesname, `resetUsers`),
  `events-crud.test.ts` (CRUD, fremd → 404, Freigabe `everyone`), `events-website.test.ts` (Filter inkl. `group`/`stamm`/422,
  Felder inkl. `groupIds`, Detail einmalig/Serie mit und ohne `occurrence`/abgesagt/nicht auf Website, Scope, Meta-Endpoints, ohne `members`), `sharing.test.ts` (`principalKeysFor`, `searchPrincipals`, `describePrincipals`,
  `validatePrincipals`, `members` deaktiviert), `members-principals.test.ts`.
- `events.test.ts` (Zugriffsmatrix aller Principal-Typen inkl. Leitung/ausgetreten, view-all/edit-all, 422-Pfade, Website-Scope, Audit, `members`/`events` deaktiviert).
- PUT prüft zuerst den Zugriff (Fremde → 404) und akzeptiert bereits gespeicherte Freigaben/Gruppen ungeprüft (`validatePrincipals(…, { keep })`), damit ein deaktiviertes `members` das Speichern nicht blockiert.

## Entscheidungen und offen
- Zuordnung (`event_groups`) und Sichtbarkeit (`event_shares`) sind **getrennt**: ein Termin „für die Wölflinge“ ist nicht
  automatisch für deren Eltern sichtbar – dafür eine Freigabe an `group:<id>` setzen.
- `everyone` heißt in der UI „Stamm“ (bzw. Stammesname), umfasst aber **alle** Konten mit `events.event.view`, auch Elternkonten.
- Website-Termine sind öffentlich gemeint; Beschreibung/Ort daher ohne personenbezogene Daten pflegen.
- Keine Erinnerungen (VALARM) im Kalender-Abo – mögliche Folgeschritte.
- **Offen (Serien):** Kein „diesen und alle folgenden“ – nur ein Vorkommen oder die ganze Serie (zum Teilen: Serie mit Ende
  versehen und neue anlegen). Verschobene Vorkommen, die **außerhalb des Serienzeitraums** landen (vor `starts_on` bzw. nach
  `recurrence_until` + Dauer), fallen durch den SQL-Vorfilter und erscheinen in Listen/Website-Abfragen für diesen Zeitraum
  nicht (`expandRow` könnte sie liefern, bekommt die Zeile aber nicht). Speicher/Rechenzeit: alle Kandidaten-Zeilen
  (≤ 5000) werden expandiert, bevor auf `MAX_OCCURRENCES` gekappt wird – viele offene Tagesserien in langen Zeiträumen
  erzeugen bis zu 2000 Vorkommen je Serie im Speicher. Kappung auf 2000 Vorkommen ist für Nutzer*innen nur am `total` erkennbar.
- `actions` nutzt seit 2026-10-25 dasselbe Muster (`action_shares` mit `principal_type`/`principal_id`, Migr. 0022).

## Meilensteine aus Aufgaben im Abo (2026-10-29, v1.4.0, Migr. 0005)
`calendar_feeds.include_tasks` (Standard aus, CHECK jetzt Termine **oder** Aktionen **oder** Meilensteine, Constraint `calendar_feeds_content_check`),
`optionalDependencies` + `tasks`; `renderFeed` holt `TaskRefsService.calendarMilestones(ctx, window)` (nur Boards mit „Meilensteine im Kalender-Abo“,
siehe `module-tasks.md`), ganztägig „◆ Titel“, UID `milestone-<id>@tasks.<host>`, Kategorie „Meilenstein“. `CalendarFeedList.tasksAvailable`, Schalter im
`CalendarFeedDialog`, Datenauskunft mit `includeTasks`. Test: `tests/integration/tasks-planning.test.ts`.

## Export als PDF – Monats- und Jahrespläne (2026-11-03, v1.5.0, keine Migration)
Nutzerentscheidung: drei Ausführungen **Terminliste**, **Monatskalender**, **Jahresplan** (kein CSV/iCal); Zeitraum Monat, Jahr oder frei
(≤ `MAX_EXPORT_DAYS` 400 Tage, z. B. Schuljahr); **Aktionen** wählbar (Standard an); **Briefkopf** wählbar (Standard: Liste an, Kalender/Jahresplan aus).
- `GET /events/export.pdf` (Recht `events.event.view`, 30/60 s, Query `exportQuery` strikt: `layout`, `from`, `to`, `search`, `tag`, `groupId`,
  `includeActions`, `letterhead`, `withDescription` als `true|false|1|0`; `to < from` bzw. > 400 Tage → 422). Inhalt = **dieselben Vorkommen wie
  `GET /events`** (`listVisibleOccurrences` in `events.endpoints.ts`, auch von `GET /events` genutzt; Absagen fehlen, Änderungen gelten).
  Aktionen über `ActionsService.listCalendarActions` (sichtbare + eigene Anmeldungen), nur ohne `tag`/`groupId`, `search` auf Name/Ort, Farbe `ACTION_COLOR`.
  Antwort `application/pdf`, `attachment` (`termine-2026-11.pdf`, `jahresplan-2027.pdf`, …), `no-store`. Audit `events.events.exported`
  (`layout`, `count`, `withActions`, `letterhead` – keine Titel).
- Vorlagen: Liste `briefkopf` bzw. `compact` hochkant; Monatskalender `briefkopf-quer` bzw. `compact` quer (Ränder 10/14 mm, ohne Kopfzeile);
  Jahresplan ohne Briefkopf `compact` quer mit 12 Monaten auf **einer** Seite, mit Briefkopf `briefkopf` **hochkant je Halbjahr** (6 Spalten) –
  31 Zeilen passen quer unter dem Briefkopf (45 mm Kopf) nicht.
- Kalender/Jahresplan sind `richText`-Tabellen: `sanitizeDocumentHtml` erlaubt nur `color`/`background-color`/`font-size`/`text-align`/`width`
  (kein `height`, `padding`, `vertical-align`) → gleich hohe Kalenderzellen über aufgefüllte Leerzeilen (`minLines` 6 bzw. 4 mit Briefkopf),
  Titel im Jahresplan auf `cellChars` gekürzt („…“), nur am ersten Tag bzw. am Monatsersten, Folgetage nur getönt (`tint`). Wochenende/
  Randtage grau. Test prüft, dass das HTML die Bereinigung unverändert übersteht.
- `GET /events/export/options` → `{ actionsAvailable, maxDays }`.
- UI `ExportDialog` (`SegmentedSlider` Ausführung + Zeitraum, `SelectField` Monat/Jahr, Datumsfelder, Checkboxen), übernimmt Suche/Gruppe/Tag der
  Seite (Hinweiszeile), Download per `downloadPdf`. Tests: `tests/unit/events-export.test.ts`, `tests/integration/events-export.test.ts`.
- Offen: keine Legende/Liste der gekürzten Titel im Jahresplan; sehr viele Termine an einem Tag verlängern die Kalenderzeile (ggf. zweite Seite).

## Kalender-Abo (iCal, 2026-10-24, v1.3.0, Migr. 0004)
Nutzerentscheidung: Termine **und** Aktionen; **mehrere Abos je Person** mit Filter.
- **Daten** `calendar_feeds(id, user_id, name ≤ 80, token_hash UNIQUE, token_enc, include_events, include_actions, group_ids jsonb, tags jsonb,
  created_at, updated_at, last_used_at)`, CHECK Termine oder Aktionen. Token 32 Zufallsbytes base64url, nur als Hash (`core.crypto.forModule('events').hash`)
  + verschlüsselt (Link wieder anzeigbar); Backup-Hook `backup.rehash` (nicht entschlüsselbar → toter Hash, Person erneuert). ≤ 10 Abos je Person
  (`MAX_CALENDAR_FEEDS`, Advisory-Sperre je Person).
- **API** (Recht `events.event.view`): GET `/calendar-feeds` → `{ feeds, actionsAvailable, max }` (je Abo `url` https und `webcalUrl`), POST (`calendarFeedInput`
  strikt: `name`, `includeEvents`, `includeActions`, `groupIds` (geprüft, 422 `groupIds.<i>`), `tags`; weder noch → 422; > 10 → 409), PUT `/:id` (Link bleibt,
  gespeicherte Gruppen bleiben gültig), POST `/:id/rotate` (alter Link sofort 404), DELETE `/:id`; fremde Abos → 404. Audit `events.calendar-feed.created|updated|
  rotated|deleted` nur mit Zählern.
- **Abruf** GET `/public/calendar/:token[.ics]` (`public: true`, 120/60 s, Token im `api_log` maskiert): Rechte der **Besitzer*in** (`core.auth.contextForUser`);
  deaktiviert, gelöscht oder ohne `events.event.view` → 404 wie ein unbekannter Link. Fenster −90 bis +400 Tage. Termine wie `GET /events` (Freigaben, Serien
  je Vorkommen als eigenes `VEVENT` mit UID `<id>-<datum>@events.<host>`, Absagen fehlen, Änderungen übernommen), Filter Gruppen/Tags (ODER innerhalb, UND
  zwischen beiden). Aktionen über `ActionsService.listCalendarActions(ctx, window)` (neu in `actions/calendar.ts`): mit `actions.action.view` die sichtbaren,
  mit `actions.own.view` die mit eigener Anmeldung (Konto oder verknüpfte Mitglieder) – dann **ohne Beschreibung und ohne Link**, aber „Angemeldet: <Namen>“.
  `text/calendar; charset=utf-8`, `private, max-age=300`; `last_used_at` höchstens alle 10 min. Kategorien = Tags bzw. „Aktion“; Beschreibung mit Link in die App.
- **UI**: Profil „Kalender-Abo“ und Knopf „Kalender abonnieren“ auf der Terminseite: Liste mit Link, Kopieren, „In Kalender-App öffnen“ (`webcal://`),
  „Google Kalender“ (`calendar.google.com/calendar/r?cid=`), Menü Bearbeiten / Neuen Link erzeugen / Löschen (Bestätigung), Status „Aktiv“ + letzter Abruf.
- **Datenschutz**: `onUserDeleted` löscht die Abos der Person, `resetUsers` die fremder Konten, Reset-Bereich `all` umfasst die Tabelle; Datenauskunft
  `calendarFeeds` ohne Link. Wer den Link hat, sieht die Termine der Person – Hinweis in der UI, Erneuern jederzeit.
- **Tests**: `tests/unit/events-ical.test.ts`, `tests/integration/events-calendar-feeds.test.ts`.
- **Grenzen**: Kalender-Apps rufen selbst nur alle paar Stunden ab (Google bis zu 24 h); keine Erinnerungen; Gruppenfilter wirkt nur auf Termine;
  Google Kalender braucht eine öffentlich erreichbare Adresse (`ORIGIN`).

## Datenauskunft (#30)
- `subject-export.ts` (Hook `subjectExport` in `module.ts`): eigene bzw. angelegte Termine (mit Tags), Freigaben an `user:<id>` und `member:<id>` der Person, von ihr geänderte Serien-Vorkommen. Test `tests/integration/privacy-subject-export.test.ts`.

## Verweise auf `members`, Löschen und Reset (Stand 2026-10-21, Issue #76 10-09)
- `event_groups.group_id` (Gruppe aus `members`, ohne FK) und `event_shares` mit `principal_type` `group`/`member`: `events` hat **kein**
  `onMemberDeleted`, und beim Löschen einer Gruppe meldet `members` nichts – die Zeilen bleiben stehen. Reset `members:all` impliziert keinen
  `events`-Bereich, löscht sie also nicht mit. Lesepfade tolerieren das: unbekannte Freigaben erscheinen als „Unbekannt“ (`describePrincipals`),
  bereits gespeicherte Gruppen-IDs werden beim Speichern akzeptiert (`validateGroupIds(…, keep)`).
- Benutzerkonten: `onUserDeleted` (`user-deleted.ts`) bzw. `resetUsers` bereinigen `user:`-Freigaben und Eigentum.
