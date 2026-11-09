/**
 * Öffentliche Links für Notizen (Personen ohne Konto): Anlegen, Auflisten, Widerrufen; öffentliche Auflösung.
 * Aufbau wie `files/links.service.ts`:
 *
 *   - Token: 32 Byte → base64url; gesucht über `core.crypto.forModule('notes').hash(token)` (`token_hash`), zusätzlich
 *     verschlüsselt (`token_enc`), damit Verwaltende die URL jederzeit wieder kopieren können.
 *   - Stufe `read` (ansehen) oder `edit` (live mitbearbeiten, nur Text – keine Uploads, Versionen, Export, KI, Einbettungen).
 *   - Gilt für die Seite **und alle Unterseiten** (wie die vererbte Freigabe); andere Seiten → 404.
 *   - Passwort: scrypt mit Salt, `timingSafeEqual`; danach Zugriffstoken `<linkId>.<exp>.<sig>` (eigene Domäne `access:`),
 *     gültig `LINK_ACCESS_TTL_SEC`. Höchstens `MAX_UNLOCK_FAILURES` Fehlversuche je Link und Stunde (atomar reserviert), danach 429.
 *   - Verwalten nur Eigentümer*in/`edit-all` (`requireNoteAccess(…, 'share')`), Anlegen zusätzlich `notes.link.create`.
 *   - Ungültig / abgelaufen / widerrufen / Seite im Papierkorb / Eigentümer*in der Wurzel fehlt oder ist deaktiviert →
 *     überall dieselbe 404 „Link nicht verfügbar“.
 *   - Audit `notes.link.accessed` höchstens 1× je Link und Stunde; nie Inhalte, Titel oder Namen von Gästen.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import {
	core,
	errors,
	logBestEffort,
	type RequestContext,
	type Row,
	rowsOf,
	toIso,
	type Tx
} from '$lib/sdk/server';
import { chainOf, MAX_WALK, requireNoteAccess, subtreeIds, type ChainNode } from './access';
import { filesCtx, mdb, refOf, userRefs } from './db';
import { recheckNotes } from './live';
import {
	LINK_ACCESS_TTL_SEC,
	MAX_LINKS_PER_NOTE,
	MAX_UNLOCK_FAILURES,
	MODULE_ID,
	PERM,
	PUBLIC_LINK_PATH,
	type NoteLink,
	type PublicLinkInfo,
	type PublicNoteNode,
	type ShareLevel
} from './schemas';

const scrypt = promisify(scryptCb) as (
	password: string,
	salt: Buffer,
	keylen: number
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const UNAVAILABLE = 'Link nicht verfügbar';
const AUDIT_ACTOR = { type: 'system' as const, id: 'notes-link', name: 'Öffentlicher Link' };
/** Seiten im Baum eines Links (Anzeige) */
const MAX_PUBLIC_PAGES = 500;

const unavailable = () => errors.notFound(UNAVAILABLE);
const lockedOut = () =>
	errors.rateLimited('Zu viele Fehlversuche – bitte in einer Stunde erneut versuchen');

const LOCKED_SQL = sql`(failed_count >= ${MAX_UNLOCK_FAILURES}
	AND failed_window_start IS NOT NULL AND failed_window_start > now() - interval '1 hour')`;

// ---------------------------------------------------------------------------
// Token, Passwort, Zugriffstoken
// ---------------------------------------------------------------------------

const hashValue = (value: string) => core.crypto.forModule(MODULE_ID).hash(value);

function newToken(): string {
	return randomBytes(32).toString('base64url');
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

function safeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}

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
	if (Number(expRaw) < Math.floor(Date.now() / 1000)) return false;
	return safeEqual(sig, accessSignature(id, expRaw));
}

/** Identität eines Gasts (aus seinem Geheimnis je Tab, nie das Geheimnis selbst) */
export const guestSubject = (key: string) => `guest:${hashValue(`guest:${key}`).slice(0, 32)}`;

// ---------------------------------------------------------------------------
// Zeilen
// ---------------------------------------------------------------------------

const todaySql = () => sql`${todayBerlin()}::date`;

const linkColumns =
	() => sql`l.id, l.note_id, l.level, l.token_enc, to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on,
	l.password_hash, l.created_by, l.created_at, l.revoked_at, l.last_access_at, l.access_count,
	(l.revoked_at IS NULL AND (l.expires_on IS NULL OR l.expires_on >= ${todaySql()})) AS active,
	(l.last_access_at IS NULL OR l.last_access_at < now() - interval '1 hour') AS audit_due`;

export interface LinkRow {
	id: string;
	noteId: string;
	level: ShareLevel;
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

function linkRowOf(r: Row): LinkRow {
	return {
		id: String(r.id),
		noteId: String(r.note_id),
		level: r.level === 'edit' ? 'edit' : 'read',
		tokenEnc: textOrNull(r.token_enc),
		expiresOn: textOrNull(r.expires_on),
		passwordHash: textOrNull(r.password_hash),
		createdBy: textOrNull(r.created_by),
		createdAt: toIso(r.created_at),
		revokedAt: r.revoked_at == null ? null : toIso(r.revoked_at),
		lastAccessAt: r.last_access_at == null ? null : toIso(r.last_access_at),
		accessCount: Number(r.access_count ?? 0),
		active: bool(r.active),
		auditDue: bool(r.audit_due)
	};
}

function urlOf(row: LinkRow): string | null {
	if (!row.tokenEnc) return null;
	try {
		const token = core.crypto.forModule(MODULE_ID).decrypt(row.tokenEnc);
		return `${core.app.origin()}${PUBLIC_LINK_PATH}/${token}`;
	} catch {
		return null;
	}
}

function toNoteLink(
	row: LinkRow,
	users: Map<string, { id: string; name: string; image: string | null }>
): NoteLink {
	return {
		id: row.id,
		noteId: row.noteId,
		level: row.level,
		url: urlOf(row),
		expiresOn: row.expiresOn,
		hasPassword: row.passwordHash !== null,
		active: row.active,
		revokedAt: row.revokedAt,
		accessCount: row.accessCount,
		lastAccessAt: row.lastAccessAt,
		createdBy: refOf(users, row.createdBy),
		createdAt: row.createdAt
	};
}

async function loadLinkById(tx: Tx, id: string): Promise<LinkRow | null> {
	const [r] = await rowsOf(tx, sql`SELECT ${linkColumns()} FROM note_links l WHERE l.id = ${id}`);
	return r ? linkRowOf(r) : null;
}

// ---------------------------------------------------------------------------
// Intern (Verwaltung)
// ---------------------------------------------------------------------------

/** GET `/notes/:id/links` (Eigentümer*in/`edit-all`) */
export async function listLinks(ctx: RequestContext, noteId: string): Promise<NoteLink[]> {
	const rows = await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId, 'share');
		const list = await rowsOf(
			tx,
			sql`SELECT ${linkColumns()} FROM note_links l WHERE l.note_id = ${noteId}
				ORDER BY l.created_at DESC, l.id`
		);
		return list.map(linkRowOf);
	});
	const users = await userRefs(
		ctx,
		rows.map((r) => r.createdBy)
	);
	return rows.map((r) => toNoteLink(r, users));
}

/** POST `/notes/:id/links` (Eigentümer*in/`edit-all` + `notes.link.create`) */
export async function createLink(
	ctx: RequestContext,
	noteId: string,
	input: { level: ShareLevel; expiresOn: string | null; password: string | null }
): Promise<NoteLink> {
	if (!core.permissions.has(ctx, PERM.linkCreate)) {
		throw errors.forbidden('Du darfst keine öffentlichen Links anlegen');
	}
	const passwordHash = input.password ? await hashPassword(input.password) : null;
	const token = newToken();
	const tokenEnc = core.crypto.forModule(MODULE_ID).encrypt(token);
	const id = crypto.randomUUID();
	const expiresOn = input.expiresOn;

	const row = await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId, 'share');
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
			sql`SELECT count(*)::int AS n FROM note_links
				WHERE note_id = ${noteId} AND revoked_at IS NULL
					AND (expires_on IS NULL OR expires_on >= ${todaySql()})`
		);
		if (Number(c?.n ?? 0) >= MAX_LINKS_PER_NOTE) {
			throw errors.conflict(
				`Höchstens ${MAX_LINKS_PER_NOTE} aktive Links je Notiz – bitte zuerst einen widerrufen`
			);
		}
		await tx.execute(
			sql`INSERT INTO note_links (id, note_id, token_hash, token_enc, level, expires_on, password_hash, created_by)
				VALUES (${id}, ${noteId}, ${hashValue(token)}, ${tokenEnc}, ${input.level}, ${expiresOn}::date,
					${passwordHash}, ${ctx.userId})`
		);
		const created = await loadLinkById(tx, id);
		if (!created) throw errors.notFound();
		return created;
	});

	const users = await userRefs(ctx, [row.createdBy]);
	await core.audit.logFromContext(ctx, 'notes.link.created', {
		target: id,
		metadata: {
			linkId: id,
			noteId,
			level: input.level,
			hasPassword: passwordHash !== null,
			expiresOn
		}
	});
	return toNoteLink(row, users);
}

/** DELETE `/links/:linkId`: ohne Zugriff 404, ohne Teilen-Recht 403; offene Gast-Verbindungen schließen sofort */
export async function revokeLink(ctx: RequestContext, linkId: string): Promise<NoteLink> {
	const { row, changed, ids } = await mdb().transaction(async (tx) => {
		const link = await loadLinkById(tx, linkId);
		if (!link) throw errors.notFound('Link nicht gefunden');
		await requireNoteAccess(tx, ctx, link.noteId, 'share').catch((e: unknown) => {
			// Existenz fremder Links nicht verraten
			if ((e as { status?: number }).status === 404) throw errors.notFound('Link nicht gefunden');
			throw e;
		});
		const wasOpen = link.revokedAt === null;
		if (wasOpen) {
			await tx.execute(sql`UPDATE note_links SET revoked_at = now() WHERE id = ${linkId}`);
		}
		const updated = await loadLinkById(tx, linkId);
		if (!updated) throw errors.notFound('Link nicht gefunden');
		return { row: updated, changed: wasOpen, ids: await subtreeIds(tx, link.noteId) };
	});
	if (changed) {
		await recheckNotes(ids);
		await core.audit.logFromContext(ctx, 'notes.link.revoked', {
			target: linkId,
			metadata: { linkId, noteId: row.noteId }
		});
	}
	const users = await userRefs(ctx, [row.createdBy]);
	return toNoteLink(row, users);
}

// ---------------------------------------------------------------------------
// Öffentliche Auflösung
// ---------------------------------------------------------------------------

interface ValidLink {
	link: LinkRow;
	/** Kette Wurzel → Link-Seite */
	chain: ChainNode[];
}

async function loadValidLink(tx: Tx, token: string): Promise<ValidLink> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT ${linkColumns()} FROM note_links l WHERE l.token_hash = ${hashValue(token)}`
	);
	if (!r) throw unavailable();
	const link = linkRowOf(r);
	if (!link.active) throw unavailable();
	const chain = await chainOf(tx, link.noteId);
	const self = chain[chain.length - 1];
	if (!self || self.id !== link.noteId || chain.some((n) => n.deletedAt !== null)) {
		throw unavailable();
	}
	return { link, chain };
}

/** Eigentümer*in der Wurzel aktiv? (Core-Aufruf, NIE in einer Transaktion; 30 s gemerkt – Live-Updates) */
const ownerCache = new Map<string, { at: number; ok: boolean }>();
const OWNER_TTL_MS = 30_000;

async function assertOwnerActive(chain: readonly ChainNode[]): Promise<void> {
	const ownerId = chain[0]?.ownerId;
	if (!ownerId) throw unavailable();
	const now = Date.now();
	const cached = ownerCache.get(ownerId);
	let ok: boolean;
	if (cached && now - cached.at < OWNER_TTL_MS) ok = cached.ok;
	else {
		const [owner] = await core.users.directory(filesCtx(), { ids: [ownerId], limit: 1 });
		ok = owner?.id === ownerId;
		if (ownerCache.size > 1000) ownerCache.clear();
		ownerCache.set(ownerId, { at: now, ok });
	}
	if (!ok) throw unavailable();
}

export function ownerCacheClearForTests(): void {
	ownerCache.clear();
}

function assertUnlocked(link: LinkRow, accessToken: string | undefined): void {
	if (link.passwordHash === null) return;
	if (!accessTokenValid(link.id, accessToken)) throw errors.forbidden('Passwort erforderlich');
}

/** Liegt `noteId` im Teilbaum des Links (inkl. Link-Seite) und nicht im Papierkorb? */
async function inLink(tx: Tx, linkNoteId: string, noteId: string): Promise<boolean> {
	if (noteId === linkNoteId) return true;
	const chain = await chainOf(tx, noteId);
	const self = chain[chain.length - 1];
	if (!self || self.id !== noteId) return false;
	const idx = chain.findIndex((n) => n.id === linkNoteId);
	if (idx < 0) return false;
	return !chain.some((n) => n.deletedAt !== null);
}

async function countAccess(tx: Tx, linkId: string): Promise<void> {
	await tx.execute(
		sql`UPDATE note_links SET access_count = access_count + 1, last_access_at = now() WHERE id = ${linkId}`
	);
}

async function auditAccess(ctx: RequestContext, link: LinkRow): Promise<void> {
	if (!link.auditDue) return;
	try {
		await core.audit.log({
			action: 'notes.link.accessed',
			actor: AUDIT_ACTOR,
			target: link.id,
			ip: ctx.ip,
			requestId: ctx.requestId,
			metadata: { linkId: link.id, noteId: link.noteId, accessCount: link.accessCount + 1 }
		});
	} catch (e) {
		logBestEffort('notes.link.audit-accessed', e, { ctx, target: link.id });
	}
}

/** Seitenbaum ab der Link-Seite (ohne Papierkorb), Eltern vor Kindern, Geschwister nach Position */
async function publicPages(tx: Tx, rootId: string): Promise<PublicNoteNode[]> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE down AS (
			SELECT n.id, n.parent_id, n.title, n.icon, n.color, n.position, 0 AS depth,
				ARRAY[n.position, 0] AS path
			FROM notes n WHERE n.id = ${rootId} AND n.deleted_at IS NULL
			UNION ALL
			SELECT c.id, c.parent_id, c.title, c.icon, c.color, c.position, down.depth + 1,
				down.path || ARRAY[c.position, 0]
			FROM notes c JOIN down ON c.parent_id = down.id
			WHERE c.deleted_at IS NULL AND down.depth < ${MAX_WALK}
		)
		SELECT id, parent_id, title, icon, color FROM down ORDER BY path, id
		LIMIT ${MAX_PUBLIC_PAGES}`
	);
	return rows.map((r, i) => ({
		id: String(r.id),
		// Link-Seite ist die Wurzel des öffentlichen Baums
		parentId: i === 0 || r.parent_id == null ? null : String(r.parent_id),
		title: String(r.title ?? ''),
		icon: textOrNull(r.icon),
		color: textOrNull(r.color)
	}));
}

/** GET `/public/links/:token?t=` */
export async function publicInfo(
	ctx: RequestContext,
	token: string,
	accessToken?: string
): Promise<PublicLinkInfo> {
	const { chain } = await mdb().transaction((tx) => loadValidLink(tx, token));
	await assertOwnerActive(chain);
	const { link, pages, needsPassword } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		await countAccess(tx, valid.link.id);
		const locked =
			valid.link.passwordHash !== null && !accessTokenValid(valid.link.id, accessToken);
		return {
			link: valid.link,
			needsPassword: locked,
			pages: locked ? [] : await publicPages(tx, valid.link.noteId)
		};
	});
	await auditAccess(ctx, link);
	const self = chain[chain.length - 1]!;
	return {
		// Titel erst nach dem Freischalten
		title: needsPassword ? '' : self.title,
		level: link.level,
		needsPassword,
		expiresOn: link.expiresOn,
		pages
	};
}

/** POST `/public/links/:token/unlock` (falsch 403, gesperrt 429) */
export async function unlockLink(
	token: string,
	password: string
): Promise<{ accessToken: string; expiresInSec: number }> {
	const { link, chain, locked } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		const [r] = await rowsOf(
			tx,
			sql`SELECT ${LOCKED_SQL} AS locked FROM note_links WHERE id = ${valid.link.id}`
		);
		return { ...valid, locked: bool(r?.locked) };
	});
	await assertOwnerActive(chain);
	if (link.passwordHash === null) {
		return { accessToken: issueAccessToken(link.id), expiresInSec: LINK_ACCESS_TTL_SEC };
	}
	if (locked) throw lockedOut();
	// Versuch VOR der langsamen Prüfung atomar reservieren (parallele Anfragen bekommen 429)
	const reserved = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`UPDATE note_links SET
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
	if (!(await verifyPassword(password, link.passwordHash)))
		throw errors.forbidden('Passwort falsch');
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE note_links SET failed_count = 0, failed_window_start = NULL WHERE id = ${link.id}`
		)
	);
	return { accessToken: issueAccessToken(link.id), expiresInSec: LINK_ACCESS_TTL_SEC };
}

export interface GuestAccess {
	linkId: string;
	level: ShareLevel;
}

/**
 * Zugriff eines Gasts auf eine Seite im Link (Zustand, Live, Änderungen, Bilder): Link gültig, Eigentümer*in aktiv,
 * freigeschaltet, Seite im Teilbaum. Sonst 404 (bzw. 403 „Passwort erforderlich“).
 */
export async function resolveGuest(
	token: string,
	noteId: string,
	accessToken: string | undefined,
	need: 'read' | 'edit' = 'read'
): Promise<GuestAccess> {
	const { link, chain } = await mdb().transaction(async (tx) => {
		const valid = await loadValidLink(tx, token);
		assertUnlocked(valid.link, accessToken);
		if (!(await inLink(tx, valid.link.noteId, noteId)))
			throw errors.notFound('Seite nicht gefunden');
		return valid;
	});
	await assertOwnerActive(chain);
	if (need === 'edit' && link.level !== 'edit') {
		throw errors.forbidden('Über diesen Link kannst du nur ansehen');
	}
	return { linkId: link.id, level: link.level };
}

/** Neuprüfung offener Gast-Verbindungen (Live-Hub): Stufe oder `null` */
export async function guestLevel(
	token: string,
	noteId: string,
	accessToken: string | undefined
): Promise<ShareLevel | null> {
	try {
		return (await resolveGuest(token, noteId, accessToken)).level;
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (status === 403 || status === 404) return null;
		throw e;
	}
}

/** Bild einer Seite im Link: Asset gehört zu einer Seite im Teilbaum? */
export async function guestAssetNote(tx: Tx, assetId: string): Promise<string | null> {
	const [r] = await rowsOf(tx, sql`SELECT note_id FROM note_assets WHERE id = ${assetId}`);
	return r ? String(r.note_id) : null;
}
