/**
 * Öffentliche Links (für Personen ohne Konto): Anlegen, Auflisten, Widerrufen; öffentliche Auflösung.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.5, Umbau 0003 (Link-Arten, wieder abrufbare URL, öffentlicher Upload).
 *
 * Sicherheit:
 *   - Token: 32 Byte `crypto.getRandomValues` → base64url; gesucht wird über `core.crypto.forModule('files').hash(token)`
 *     (`token_hash`). Seit 0003 zusätzlich AES-256-GCM-verschlüsselt (`token_enc`), damit Verwaltende die URL später
 *     wieder sehen/kopieren können; alte Links ohne `token_enc` liefern `url = null`.
 *   - Link-Art (`mode`): `view` (ansehen), `upload` (nur hochladen, Inhalt bleibt verborgen), `view-upload`. Upload-Arten
 *     nur für Ordner. Ansehen (`nodes`/`content`) ohne Ansehen-Art → 403, Upload ohne Upload-Art → 403.
 *   - Öffentlicher Upload: nur in den Link-Ordner selbst, Eigentum und Kontingent = Eigentümer*in des Ordners,
 *     `created_by = NULL`, `uploaded_by_name`/`uploaded_via_link` gesetzt; Link wird in jeder Speicher-Transaktion erneut geprüft.
 *   - Passwort: scrypt (`node:crypto`, Salt 16 Byte, Format `scrypt$<salt>$<hash>`), Vergleich `timingSafeEqual`.
 *   - Nach `unlock`: Zugriffstoken `<linkId>.<exp>.<sig>` mit `sig = hash('access:' + linkId + '.' + exp)`
 *     (Präfix trennt die Domäne vom Token-Hash), gültig `LINK_ACCESS_TTL_SEC`.
 *   - Passwort-Raten: höchstens `MAX_UNLOCK_FAILURES` Fehlversuche je Link und Stunde, danach 429 (auch bei
 *     richtigem Passwort), Erfolg setzt den Zähler zurück.
 *   - Verwalten (Auflisten, Anlegen, Widerrufen) nur für Bereichsberechtigte (`canManageShares`).
 *   - Ungültig / abgelaufen / widerrufen / Knoten im Papierkorb → überall dieselbe 404-Meldung „Link nicht verfügbar“.
 *   - Knoten-Zugriff nur innerhalb des Link-Teilbaums (Vorfahren-Prüfung), gelöschte Knoten nie.
 *   - Audit `files.link.accessed` höchstens 1× je Link und Stunde (über `last_access_at`), `access_count` zählt jeden Aufruf von Info/Inhalt.
 *
 * Ablaufdatum: gültig bis einschließlich `expires_on`, verglichen mit „heute“ in Europe/Berlin
 * (`todayBerlin`, nicht `CURRENT_DATE` der Datenbank, die in UTC läuft; beim Anlegen und Abruf dieselbe Quelle).
 */
import { notifyLinkUpload } from './notify';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import {
	core,
	errors,
	isCoreError,
	logBestEffort,
	type RequestContext,
	type Row,
	rowsOf,
	toIso,
	type Tx
} from '$lib/sdk/server';
import { requireNode, resolveAccess } from './access';
import { normalizeName } from './names';
import { storeIntoFolder } from './upload.service';
import {
	NODE_COLUMNS,
	ancestorsOf,
	filesCtx,
	mdb,
	nodeRowOf,
	filesSettings,
	userRefs,
	type NodeRow
} from './db';
import { contentResponse, quotaLimitFor, quotaUsed, storageLimits, thumbResponse } from './storage';
import {
	LINK_ACCESS_TTL_SEC,
	MAX_LINKS_PER_NODE,
	MAX_PUBLIC_UPLOAD_BYTES,
	MAX_PUBLIC_UPLOAD_FILES,
	MAX_UNLOCK_FAILURES,
	MODULE_ID,
	PERMISSIONS,
	isRealDate,
	linkCanUpload,
	linkCanView,
	type Breadcrumb,
	type LinkCreateInput,
	type LinkMode,
	type PublicUploadFields,
	type PublicUploadResult,
	type PublicLinkInfo,
	type PublicListing,
	type PublicNode,
	type ShareLink,
	type UserRef
} from './schemas';
import { assertCanManageShares, keysFor } from './shares.service';

const scrypt = promisify(scryptCb) as (
	password: string,
	salt: Buffer,
	keylen: number
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const PUBLIC_PATH = '/p/files/link';
const UNAVAILABLE = 'Link nicht verfügbar';
const AUDIT_ACTOR = { type: 'system' as const, id: 'files-link', name: 'Öffentlicher Link' };

const unavailable = () => errors.notFound(UNAVAILABLE);
const lockedOut = () =>
	errors.rateLimited('Zu viele Fehlversuche – bitte in einer Stunde erneut versuchen');

/** SQL-Bedingung (ohne Alias, Tabelle `share_links`): Link wegen Fehlversuchen gesperrt */
const LOCKED_SQL = sql`(failed_count >= ${MAX_UNLOCK_FAILURES}
	AND failed_window_start IS NOT NULL AND failed_window_start > now() - interval '1 hour')`;

// ---------------------------------------------------------------------------
// Hilfen: Token, Passwort, Zugriffstoken
// ---------------------------------------------------------------------------

const hashValue = (value: string) => core.crypto.forModule(MODULE_ID).hash(value);

function newToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
	return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
	const salt = Buffer.from(parts[1]!, 'base64');
	const expected = Buffer.from(parts[2]!, 'base64');
	if (salt.length === 0 || expected.length === 0) return false;
	const actual = await scrypt(password, salt, expected.length);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeEqualHex(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Signatur des Zugriffstokens (eigene Domäne, damit sie nie mit einem Token-Hash übereinstimmt) */
const accessSignature = (linkId: string, exp: string) => hashValue(`access:${linkId}.${exp}`);

function issueAccessToken(linkId: string): string {
	const exp = String(Math.floor(Date.now() / 1000) + LINK_ACCESS_TTL_SEC);
	return `${linkId}.${exp}.${accessSignature(linkId, exp)}`;
}

function accessTokenValid(linkId: string, token: string | undefined): boolean {
	if (!token) return false;
	const parts = token.split('.');
	if (parts.length !== 3) return false;
	const [id, expRaw, sig] = parts as [string, string, string];
	if (id !== linkId || !/^\d{1,12}$/.test(expRaw)) return false;
	const exp = Number(expRaw);
	if (exp < Math.floor(Date.now() / 1000)) return false;
	return safeEqualHex(sig, accessSignature(id, expRaw));
}

// ---------------------------------------------------------------------------
// Zeilen
// ---------------------------------------------------------------------------

/** „Heute“ (Europe/Berlin) als SQL-Datum */
const todaySql = () => sql`${todayBerlin()}::date`;

/** Spalten für `share_links l`; `active`/`audit_due` in SQL, Datum als Text */
const linkColumns =
	() => sql`l.id, l.node_id, l.mode, l.token_enc, to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on,
	l.password_hash, l.created_by, l.created_at, l.revoked_at, l.last_access_at, l.access_count,
	(l.revoked_at IS NULL AND (l.expires_on IS NULL OR l.expires_on >= ${todaySql()})) AS active,
	(l.last_access_at IS NULL OR l.last_access_at < now() - interval '1 hour') AS audit_due`;

interface LinkRow {
	id: string;
	nodeId: string;
	mode: LinkMode;
	tokenEnc: string | null;
	expiresOn: string | null;
	passwordHash: string | null;
	createdBy: string | null;
	createdAt: string;
	revokedAt: string | null;
	lastAccessAt: string | null;
	accessCount: number;
	active: boolean;
	auditDue: boolean;
}

const textOrNull = (v: unknown): string | null =>
	v === null || v === undefined ? null : String(v);
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true' || v === 1;

/** Unbekannte Werte (sollte der CHECK verhindern) → `view` */
function modeOf(v: unknown): LinkMode {
	return v === 'upload' || v === 'view-upload' ? v : 'view';
}

function linkRowOf(r: Row): LinkRow {
	return {
		id: String(r.id),
		nodeId: String(r.node_id),
		mode: modeOf(r.mode),
		tokenEnc: textOrNull(r.token_enc),
		expiresOn: textOrNull(r.expires_on),
		passwordHash: textOrNull(r.password_hash),
		createdBy: textOrNull(r.created_by),
		createdAt: toIso(r.created_at),
		revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : toIso(r.revoked_at),
		lastAccessAt:
			r.last_access_at === null || r.last_access_at === undefined ? null : toIso(r.last_access_at),
		accessCount: Number(r.access_count ?? 0),
		active: bool(r.active),
		auditDue: bool(r.audit_due)
	};
}

const publicUrl = (token: string) => `${core.app.origin()}${PUBLIC_PATH}/${token}`;

/** URL aus `token_enc`; `null` bei alten Links oder nicht entschlüsselbarem Wert (z. B. geänderter Schlüssel) */
function urlOf(row: LinkRow): string | null {
	if (!row.tokenEnc) return null;
	try {
		return publicUrl(core.crypto.forModule(MODULE_ID).decrypt(row.tokenEnc));
	} catch {
		return null;
	}
}

function toShareLink(row: LinkRow, users: Map<string, UserRef>): ShareLink {
	return {
		id: row.id,
		nodeId: row.nodeId,
		mode: row.mode,
		url: urlOf(row),
		expiresOn: row.expiresOn,
		hasPassword: row.passwordHash !== null,
		active: row.active,
		revokedAt: row.revokedAt,
		accessCount: row.accessCount,
		lastAccessAt: row.lastAccessAt,
		createdBy: row.createdBy ? (users.get(row.createdBy) ?? null) : null,
		createdAt: row.createdAt
	};
}

async function loadLinkById(tx: Tx, id: string): Promise<LinkRow | null> {
	const [r] = await rowsOf(tx, sql`SELECT ${linkColumns()} FROM share_links l WHERE l.id = ${id}`);
	return r ? linkRowOf(r) : null;
}

function toPublicNode(n: NodeRow): PublicNode {
	return {
		id: n.id,
		kind: n.kind,
		name: n.name,
		icon: n.kind === 'folder' ? n.icon : null,
		color: n.kind === 'folder' ? n.color : null,
		contentType: n.kind === 'file' ? n.contentType : null,
		sizeBytes: n.kind === 'file' ? n.sizeBytes : null,
		hasThumb: n.kind === 'file' && n.thumbPath !== null,
		updatedAt: n.updatedAt
	};
}

// ---------------------------------------------------------------------------
// Öffentliche Auflösung
// ---------------------------------------------------------------------------

interface ValidLink {
	link: LinkRow;
	node: NodeRow;
}

/** Gültigen Link samt Knoten laden; sonst überall dieselbe 404 */
async function loadValidLink(tx: Tx, token: string): Promise<ValidLink> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT ${linkColumns()} FROM share_links l WHERE l.token_hash = ${hashValue(token)}`
	);
	if (!r) throw unavailable();
	const link = linkRowOf(r);
	if (!link.active) throw unavailable();
	const chain = await ancestorsOf(tx, link.nodeId);
	const node = chain[chain.length - 1];
	if (!node || node.id !== link.nodeId || chain.some((n) => n.deletedAt !== null)) {
		throw unavailable();
	}
	return { link, node };
}

/**
 * Eigentümer*in des Link-Knotens muss existieren und aktiv sein: Links gelöschter oder deaktivierter
 * Konten sind gesperrt (dieselbe 404). Core-Aufruf – nur AUSSERHALB der Transaktion.
 */
async function assertOwnerActive(node: NodeRow): Promise<void> {
	const [owner] = await core.users.directory(filesCtx(), { ids: [node.ownerId], limit: 1 });
	if (owner?.id !== node.ownerId) throw unavailable();
}

/** Ansehen (Ordnerinhalt, Dateien) nur bei Link-Arten mit Ansehen */
function assertCanView(link: LinkRow): void {
	if (!linkCanView(link.mode)) {
		throw errors.forbidden('Über diesen Link kann nur hochgeladen werden');
	}
}

/** Zugriffstoken prüfen, wenn der Link ein Passwort hat */
function assertUnlocked(link: LinkRow, accessToken: string | undefined): void {
	if (link.passwordHash === null) return;
	if (!accessTokenValid(link.id, accessToken)) throw errors.forbidden('Passwort erforderlich');
}

/**
 * Knoten im Teilbaum des Links (inkl. Link-Knoten) mit Pfad ab dem Link-Knoten.
 * Fremde, gelöschte oder unbekannte Knoten → `null`.
 */
async function nodeInLink(tx: Tx, linkNode: NodeRow, nodeId: string): Promise<NodeRow[] | null> {
	const chain = await ancestorsOf(tx, nodeId);
	const last = chain[chain.length - 1];
	if (!last || last.id !== nodeId) return null;
	const idx = chain.findIndex((n) => n.id === linkNode.id);
	if (idx < 0) return null;
	const path = chain.slice(idx);
	if (path.some((n) => n.deletedAt !== null)) return null;
	return path;
}

async function countAccess(tx: Tx, linkId: string): Promise<void> {
	await tx.execute(
		sql`UPDATE share_links SET access_count = access_count + 1, last_access_at = now()
			WHERE id = ${linkId}`
	);
}

/** Audit höchstens 1× je Link und Stunde (NACH der Transaktion) */
async function auditAccess(ctx: RequestContext, link: LinkRow, counted: boolean): Promise<void> {
	if (!counted || !link.auditDue) return;
	try {
		await core.audit.log({
			action: 'files.link.accessed',
			actor: AUDIT_ACTOR,
			target: link.id,
			ip: ctx.ip,
			requestId: ctx.requestId,
			metadata: { linkId: link.id, nodeId: link.nodeId, accessCount: link.accessCount + 1 }
		});
	} catch (e) {
		// Audit-Fehler dürfen den Abruf nicht verhindern – aber nicht unbemerkt bleiben
		logBestEffort('files.link.audit-accessed', e, { ctx, target: link.id });
	}
}

// ---------------------------------------------------------------------------
// Intern
// ---------------------------------------------------------------------------

/** GET `/nodes/:id/links` (nur Bereichsberechtigte) */
export async function listLinks(ctx: RequestContext, nodeId: string): Promise<ShareLink[]> {
	const keys = await keysFor(ctx);
	const rows = await mdb().transaction(async (tx) => {
		assertCanManageShares(ctx, await requireNode(tx, ctx, nodeId, keys, 'edit'));
		const list = await rowsOf(
			tx,
			sql`SELECT ${linkColumns()} FROM share_links l WHERE l.node_id = ${nodeId}
				ORDER BY l.created_at DESC, l.id`
		);
		return list.map(linkRowOf);
	});
	const users = await userRefs(
		ctx,
		rows.map((r) => r.createdBy)
	);
	return rows.map((r) => toShareLink(r, users));
}

/**
 * POST `/nodes/:id/links` (Bereichsberechtigte + `files.link.create`): Ablaufdatum nicht in der Vergangenheit (422),
 * max `MAX_LINKS_PER_NODE` aktive (409), Upload-Arten nur für Ordner (422, Pfad `mode`).
 * `url` = `<origin>/p/files/link/<token>` (auch später über `listLinks` abrufbar).
 */
export async function createLink(
	ctx: RequestContext,
	nodeId: string,
	input: LinkCreateInput
): Promise<ShareLink> {
	if (!core.permissions.has(ctx, PERMISSIONS.linkCreate)) {
		throw errors.forbidden('Du darfst keine öffentlichen Links anlegen');
	}
	const expiresOn = input.expiresOn ?? null;
	if (expiresOn !== null && !isRealDate(expiresOn)) {
		throw errors.validation([{ path: ['expiresOn'], message: 'Ungültiges Datum' }]);
	}
	const mode: LinkMode = input.mode ?? 'view';
	const keys = await keysFor(ctx);
	const passwordHash = input.password ? await hashPassword(input.password) : null;
	const token = newToken();
	const tokenEnc = core.crypto.forModule(MODULE_ID).encrypt(token);
	const id = crypto.randomUUID();

	const row = await mdb().transaction(async (tx) => {
		const access = await requireNode(tx, ctx, nodeId, keys, 'edit');
		assertCanManageShares(ctx, access);
		if (linkCanUpload(mode) && access.node.kind !== 'folder') {
			throw errors.validation(
				[{ path: ['mode'], message: 'Hochladen ist nur bei Ordnern möglich' }],
				'Hochladen ist nur bei Ordnern möglich'
			);
		}
		if (expiresOn !== null) {
			const [r] = await rowsOf(tx, sql`SELECT (${expiresOn}::date < ${todaySql()}) AS past`);
			if (r && bool(r.past)) {
				throw errors.validation([
					{ path: ['expiresOn'], message: 'Das Ablaufdatum liegt in der Vergangenheit' }
				]);
			}
		}
		const [c] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n FROM share_links
				WHERE node_id = ${nodeId} AND revoked_at IS NULL
					AND (expires_on IS NULL OR expires_on >= ${todaySql()})`
		);
		if (Number(c?.n ?? 0) >= MAX_LINKS_PER_NODE) {
			throw errors.conflict(
				`Höchstens ${MAX_LINKS_PER_NODE} aktive Links je Eintrag – bitte zuerst einen widerrufen`
			);
		}
		await tx.execute(
			sql`INSERT INTO share_links
					(id, node_id, token_hash, token_enc, mode, expires_on, password_hash, created_by)
				VALUES (${id}, ${nodeId}, ${hashValue(token)}, ${tokenEnc}, ${mode}, ${expiresOn}::date,
					${passwordHash}, ${ctx.userId})`
		);
		const created = await loadLinkById(tx, id);
		if (!created) throw errors.notFound();
		return created;
	});

	const users = await userRefs(ctx, [row.createdBy]);
	await core.audit.logFromContext(ctx, 'files.link.created', {
		target: id,
		metadata: { linkId: id, nodeId, mode, hasPassword: passwordHash !== null, expiresOn }
	});
	return toShareLink(row, users);
}

/**
 * DELETE `/links/:id`: ohne edit auf dem Knoten 404; mit edit nur über eine Freigabe 403
 * (nur Bereichsberechtigte dürfen widerrufen)
 */
export async function revokeLink(ctx: RequestContext, linkId: string): Promise<ShareLink> {
	const keys = await keysFor(ctx);
	const { row, changed } = await mdb().transaction(async (tx) => {
		const link = await loadLinkById(tx, linkId);
		if (!link) throw errors.notFound('Link nicht gefunden');
		const access = await resolveAccess(tx, ctx, link.nodeId, keys);
		if (!access || access.level !== 'edit') throw errors.notFound('Link nicht gefunden');
		assertCanManageShares(ctx, access);
		const wasOpen = link.revokedAt === null;
		if (wasOpen) {
			await tx.execute(sql`UPDATE share_links SET revoked_at = now() WHERE id = ${linkId}`);
		}
		const updated = await loadLinkById(tx, linkId);
		if (!updated) throw errors.notFound('Link nicht gefunden');
		return { row: updated, changed: wasOpen };
	});
	const users = await userRefs(ctx, [row.createdBy]);
	if (changed) {
		await core.audit.logFromContext(ctx, 'files.link.revoked', {
			target: linkId,
			metadata: { linkId, nodeId: row.nodeId }
		});
	}
	return toShareLink(row, users);
}

// ---------------------------------------------------------------------------
// Öffentlich
// ---------------------------------------------------------------------------

/** GET `/public/links/:token` */
export async function publicInfo(
	ctx: RequestContext,
	token: string,
	accessToken?: string
): Promise<PublicLinkInfo> {
	const { link, node } = await mdb().transaction((tx) => loadValidLink(tx, token));
	await assertOwnerActive(node);
	await mdb().transaction((tx) => countAccess(tx, link.id));
	await auditAccess(ctx, link, true);
	// Nach dem Freischalten (gültiges `t`) gibt es den Datei-Knoten auch bei Passwort-Links
	const needsPassword = link.passwordHash !== null && !accessTokenValid(link.id, accessToken);
	let upload: PublicLinkInfo['upload'] = null;
	if (linkCanUpload(link.mode) && node.kind === 'folder') {
		const limits = await storageLimits();
		upload = {
			maxFileBytes: Math.min(limits.maxFileBytes, MAX_PUBLIC_UPLOAD_BYTES),
			maxFiles: MAX_PUBLIC_UPLOAD_FILES,
			maxRequestBytes: MAX_PUBLIC_UPLOAD_BYTES,
			allowedContentTypes: limits.allowedContentTypes
		};
	}
	return {
		name: node.name,
		kind: node.kind,
		mode: link.mode,
		needsPassword,
		expiresOn: link.expiresOn,
		upload,
		// Nur-Hochladen-Links verraten keinen Inhalt
		node:
			!needsPassword && linkCanView(link.mode) && node.kind === 'file' ? toPublicNode(node) : null
	};
}

/**
 * POST `/public/links/:token/unlock`: falsches Passwort → 403 „Passwort falsch“.
 * Ab `MAX_UNLOCK_FAILURES` Fehlversuchen innerhalb einer Stunde (Fenster je Link) → 429, auch bei
 * richtigem Passwort. Jeder Versuch wird vor der scrypt-Prüfung atomar reserviert (gezählt); Erfolg setzt zurück.
 */
export async function unlockLink(
	_ctx: RequestContext,
	token: string,
	password: string
): Promise<{ accessToken: string; expiresInSec: number }> {
	const { link, node, locked } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		const [r] = await rowsOf(
			tx,
			sql`SELECT ${LOCKED_SQL} AS locked FROM share_links WHERE id = ${valid.link.id}`
		);
		return { link: valid.link, node: valid.node, locked: bool(r?.locked) };
	});
	await assertOwnerActive(node);
	if (link.passwordHash === null) {
		return { accessToken: issueAccessToken(link.id), expiresInSec: LINK_ACCESS_TTL_SEC };
	}
	if (locked) throw lockedOut();

	// Versuch VOR der (langsamen) scrypt-Prüfung atomar reservieren (#67, 01b-10): Der Zähler steigt nur,
	// solange der Link nicht gesperrt ist. Parallele Anfragen können so höchstens `MAX_UNLOCK_FAILURES`
	// Passwörter je Fenster prüfen lassen, der Rest bekommt 429. Fenster neu starten, wenn älter als 1 h.
	const reserved = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`UPDATE share_links SET
					failed_count = CASE
						WHEN failed_window_start IS NULL OR failed_window_start <= now() - interval '1 hour'
						THEN 1 ELSE failed_count + 1 END,
					failed_window_start = CASE
						WHEN failed_window_start IS NULL OR failed_window_start <= now() - interval '1 hour'
						THEN now() ELSE failed_window_start END
				WHERE id = ${link.id} AND NOT ${LOCKED_SQL}
				RETURNING id`
		);
		return rows.length > 0;
	});
	if (!reserved) throw lockedOut();

	const ok = await verifyPassword(password, link.passwordHash);
	// Fehlversuch: bleibt gezählt (die Reservierung war der Zähler)
	if (!ok) throw errors.forbidden('Passwort falsch');
	// Erfolg (innerhalb des Kontingents geprüft) setzt den Zähler zurück
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE share_links SET failed_count = 0, failed_window_start = NULL WHERE id = ${link.id}`
		)
	);
	return { accessToken: issueAccessToken(link.id), expiresInSec: LINK_ACCESS_TTL_SEC };
}

/** GET `/public/links/:token/nodes?parent=&t=`: Ordnerinhalt im Link-Teilbaum (Passwort → `t` Pflicht, sonst 403) */
export async function publicList(
	_ctx: RequestContext,
	token: string,
	input: { parentId: string | null; accessToken?: string }
): Promise<PublicListing> {
	const { node: owned } = await mdb().transaction((tx) => loadValidLink(tx, token));
	await assertOwnerActive(owned);
	return mdb().transaction(async (tx) => {
		const { link, node: linkNode } = await loadValidLink(tx, token);
		assertCanView(link);
		assertUnlocked(link, input.accessToken);

		let path: NodeRow[];
		if (input.parentId === null) {
			path = [linkNode];
		} else {
			const found = await nodeInLink(tx, linkNode, input.parentId);
			if (!found) throw errors.notFound('Ordner nicht gefunden');
			path = found;
		}
		const folder = path[path.length - 1]!;
		if (folder.kind !== 'folder') {
			throw errors.validation([{ path: ['parent'], message: 'Kein Ordner' }]);
		}

		const breadcrumbs: Breadcrumb[] = [
			{ id: null, name: linkNode.name },
			...path.slice(1).map((n) => ({ id: n.id, name: n.name }))
		];
		const rows = await rowsOf(
			tx,
			sql`SELECT ${NODE_COLUMNS} FROM nodes n
				WHERE n.parent_id = ${folder.id} AND n.deleted_at IS NULL`
		);
		const items = rows
			.map(nodeRowOf)
			.sort(
				(a, b) =>
					(a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
					a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
			)
			.map(toPublicNode);
		return { breadcrumbs, items };
	});
}

/** GET `/public/links/:token/content/:nodeId?t=&download=&thumb=`: Datei/Thumbnail als Response (`storage.ts`) */
export async function publicContent(
	ctx: RequestContext,
	token: string,
	nodeId: string,
	input: { accessToken?: string; download: boolean; thumb: boolean }
): Promise<Response> {
	// Vorschaubilder einer Ordneransicht zählen nicht als Abruf
	const counted = !input.thumb;
	const { node: owned } = await mdb().transaction((tx) => loadValidLink(tx, token));
	await assertOwnerActive(owned);
	const { link, file } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		assertCanView(valid.link);
		assertUnlocked(valid.link, input.accessToken);
		const path = await nodeInLink(tx, valid.node, nodeId);
		const target = path?.[path.length - 1];
		if (!target || target.kind !== 'file' || !target.storagePath) {
			throw errors.notFound('Datei nicht gefunden');
		}
		if (input.thumb && !target.thumbPath) throw errors.notFound('Keine Vorschau vorhanden');
		if (counted) await countAccess(tx, valid.link.id);
		return { link: valid.link, file: target };
	});
	await auditAccess(ctx, link, counted);
	if (input.thumb) return thumbResponse(file.thumbPath!);
	return contentResponse({
		path: file.storagePath!,
		name: file.name,
		contentType: file.contentType ?? 'application/octet-stream',
		download: input.download
	});
}

const uploadNotAllowed = () => errors.forbidden('Über diesen Link kann nicht hochgeladen werden');
/** Neutrale Meldungen im öffentlichen Upload: keine Belegungszahlen der Eigentümer*in, keine Link-Summen */
const NO_SPACE = 'In diesem Ordner ist nicht genug Speicherplatz frei';
const LINK_FULL = 'Über diesen Link kann nichts mehr hochgeladen werden';
const noSpace = () => errors.tooLarge(NO_SPACE);
const linkFull = () => errors.tooLarge(LINK_FULL);

/** Kontingent-Fehler (`assertQuota`, 413 mit Belegungszahlen) erkennen; eigene neutrale Meldungen ausgenommen */
function isQuotaError(e: unknown): boolean {
	return (
		isCoreError(e) &&
		e.code === 'payload_too_large' &&
		e.message !== LINK_FULL &&
		/Speicherplatz/u.test(e.message)
	);
}

/** Summe der Dateien, die über diesen Link hochgeladen wurden (inkl. Papierkorb; endgültig gelöschte fehlen) */
async function linkUploadedBytes(tx: Tx, linkId: string): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM nodes
			WHERE uploaded_via_link = ${linkId} AND kind = 'file'`
	);
	return Number(r?.used ?? 0);
}

/** Audit des öffentlichen Uploads (NACH dem Speichern; ohne Namen der Person und ohne Dateinamen) */
async function auditUpload(
	ctx: RequestContext,
	link: LinkRow,
	count: number,
	bytes: number
): Promise<void> {
	if (count === 0) return;
	try {
		await core.audit.log({
			action: 'files.link.uploaded',
			actor: AUDIT_ACTOR,
			target: link.id,
			ip: ctx.ip,
			requestId: ctx.requestId,
			metadata: { linkId: link.id, nodeId: link.nodeId, count, bytes }
		});
	} catch (e) {
		// Audit-Fehler dürfen den Upload nicht scheitern lassen – aber nicht unbemerkt bleiben
		logBestEffort('files.link.audit-uploaded', e, { ctx, target: link.id });
	}
}

/**
 * POST `/public/links/:token/upload` (multipart, Dateien in `files`): Dateien in den Link-Ordner hochladen.
 * Link gültig (sonst 404), Link-Art mit Upload und Ordner (403), Passwort → gültiges `t` (403), mindestens
 * eine Datei (422). Vorab für ALLE Dateien: Größe (413), Obergrenze des Links (`linkUploadBytes`, 413) und
 * Kontingent der Eigentümer*in (413, neutrale Meldung ohne Belegungszahlen), damit ein Request nach
 * Möglichkeit ganz oder gar nicht gespeichert wird. Die Link-Obergrenze prüft `recheck` je Datei erneut. Danach je Datei `storeIntoFolder`
 * (Typ/Name/Kontingent erneut, Namenskonflikt → „Name (2)“). Scheitert eine spätere Datei trotzdem (z. B. Typ
 * nicht erlaubt, paralleler Upload füllt das Kontingent, Link inzwischen widerrufen), bleiben die bereits
 * gespeicherten Dateien erhalten und der Fehler wird weitergegeben; das Audit nennt dann nur die gespeicherten.
 * Antwort bei „Hochladen“ (ohne Ansehen): angefragter, normalisierter Name statt „X (2)“ (kein Namens-Orakel).
 */
export async function publicUpload(
	ctx: RequestContext,
	token: string,
	body: PublicUploadFields,
	files: readonly File[]
): Promise<PublicUploadResult> {
	const { link, node } = await mdb().transaction((tx) => loadValidLink(tx, token));
	await assertOwnerActive(node);
	if (!linkCanUpload(link.mode) || node.kind !== 'folder') throw uploadNotAllowed();
	assertUnlocked(link, body.t);

	if (files.length === 0) {
		throw errors.validation(
			[{ path: ['file'], message: 'Bitte mindestens eine Datei auswählen' }],
			'Bitte mindestens eine Datei auswählen'
		);
	}
	if (files.length > MAX_PUBLIC_UPLOAD_FILES) {
		throw errors.validation(
			[{ path: ['file'], message: `Höchstens ${MAX_PUBLIC_UPLOAD_FILES} Dateien auf einmal` }],
			`Höchstens ${MAX_PUBLIC_UPLOAD_FILES} Dateien auf einmal`
		);
	}

	const ownerId = node.ownerId;
	const [{ maxFileBytes }, { quotaBytes, linkUploadBytes }] = await Promise.all([
		storageLimits(),
		filesSettings()
	]);
	const total = files.reduce((sum, f) => sum + f.size, 0);
	for (const f of files) {
		if (f.size > maxFileBytes) {
			throw errors.tooLarge(
				`Die Datei ist zu groß (höchstens ${Math.floor(maxFileBytes / (1024 * 1024))} MB)`
			);
		}
	}
	{
		const { used, limit, viaLink } = await mdb().transaction(async (tx) => ({
			used: await quotaUsed(tx, ownerId),
			limit: await quotaLimitFor(tx, ownerId, quotaBytes),
			viaLink: linkUploadBytes !== null ? await linkUploadedBytes(tx, link.id) : 0
		}));
		if (linkUploadBytes !== null && viaLink + total > linkUploadBytes) throw linkFull();
		if (limit !== null && used + total > limit) throw noSpace();
	}

	/** Größe der Datei, die gerade gespeichert wird (für die Link-Obergrenze im `recheck`) */
	let pendingBytes = 0;
	/**
	 * In jeder Speicher-Transaktion: Link noch gültig, Art mit Upload, Ordner nicht im Papierkorb,
	 * Link-Obergrenze inkl. der aktuellen Datei. Die Advisory-Sperre je Link serialisiert parallele
	 * Uploads über denselben Link bis zum Ende der Transaktion (sonst könnten beide die Grenze unterschreiten).
	 */
	const recheck = async (tx: Tx): Promise<void> => {
		if (linkUploadBytes !== null) {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${'files:link-upload:' + link.id}))`
			);
		}
		const current = await loadLinkById(tx, link.id);
		if (!current || !current.active) throw unavailable();
		if (!linkCanUpload(current.mode)) throw uploadNotAllowed();
		const chain = await ancestorsOf(tx, current.nodeId);
		const folder = chain[chain.length - 1];
		if (!folder || folder.id !== current.nodeId || chain.some((n) => n.deletedAt !== null)) {
			throw unavailable();
		}
		if (folder.kind !== 'folder' || folder.ownerId !== ownerId) throw unavailable();
		if (linkUploadBytes !== null) {
			if ((await linkUploadedBytes(tx, link.id)) + pendingBytes > linkUploadBytes) throw linkFull();
		}
	};

	const uploaded: PublicUploadResult['uploaded'] = [];
	let bytes = 0;
	try {
		for (const file of files) {
			pendingBytes = file.size;
			const stored = await storeIntoFolder({
				parentId: link.nodeId,
				ownerId,
				bytes: new Uint8Array(await file.arrayBuffer()),
				name: file.name,
				contentType: file.type || null,
				conflict: 'rename',
				createdBy: null,
				// `storeIntoFolder` bereinigt den Namen selbst (`cleanUploaderName`)
				uploadedByName: body.name ?? null,
				viaLinkId: link.id,
				quotaBytes,
				recheck
			}).catch((e: unknown) => {
				// Belegung der Eigentümer*in nicht verraten
				if (isQuotaError(e)) throw noSpace();
				throw e;
			});
			// Nur-Hochladen: den angefragten Namen zurückgeben, sonst verrät „X (2).pdf“, was im Ordner liegt
			const name = linkCanView(link.mode) ? stored.name : normalizeName(file.name);
			uploaded.push({ name, sizeBytes: stored.sizeBytes });
			bytes += stored.sizeBytes;
		}
	} finally {
		await auditUpload(ctx, link, uploaded.length, bytes);
		await notifyLinkUpload(ctx, {
			ownerId,
			folderId: node.id,
			folderName: node.name,
			count: uploaded.length,
			uploader: body.name ?? null
		});
	}
	return { uploaded };
}
