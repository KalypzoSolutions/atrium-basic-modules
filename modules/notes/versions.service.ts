/**
 * Versionsverlauf der Notizen: eine Version ist der eingefrorene Yjs-Zustand (`fullState`). Automatisch
 * stündlich bei Änderungen (höchstens `MAX_VERSIONS_AUTO` je Notiz), manuell mit Namen (höchstens
 * `MAX_VERSIONS_MANUAL`). Wiederherstellen sichert vorher den aktuellen Stand und ersetzt den Inhalt als normales
 * Update (`replaceContent`) – offene Editoren übernehmen es live.
 * `fullState`/`replaceContent` öffnen eigene Transaktionen: nie aus einer offenen heraus aufrufen.
 */
import { sql } from 'drizzle-orm';
import {
	errors,
	num,
	type RequestContext,
	rowsOf,
	type Row,
	toIso,
	type Tx
} from '$lib/sdk/server';
import { lockNote, requireNoteAccess } from './access';
import { mdb, refOf, userRefs } from './db';
import { bytesOf, fullState, jsonFromState, replaceContent } from './doc.service';
import {
	MAX_VERSIONS_AUTO,
	MAX_VERSIONS_MANUAL,
	type NoteVersion,
	type NoteVersionDetail
} from './schemas';

const AUTO_BATCH = 100;

async function insertVersion(
	tx: Tx,
	noteId: string,
	state: Uint8Array,
	input: { label: string | null; auto: boolean; userId: string | null }
): Promise<string> {
	const id = crypto.randomUUID();
	await tx.execute(
		sql`INSERT INTO note_versions (id, note_id, label, auto, ydoc, size_bytes, created_by)
			VALUES (${id}, ${noteId}, ${input.label}, ${input.auto}, ${Buffer.from(state)},
				${state.byteLength}, ${input.userId})`
	);
	if (input.auto) {
		await tx.execute(
			sql`DELETE FROM note_versions WHERE id IN (
				SELECT id FROM note_versions WHERE note_id = ${noteId} AND auto
				ORDER BY created_at DESC, id DESC OFFSET ${MAX_VERSIONS_AUTO})`
		);
	}
	return id;
}

async function manualCount(tx: Tx, noteId: string): Promise<number> {
	const [n] = await rowsOf(
		tx,
		sql`SELECT count(*)::int AS n FROM note_versions WHERE note_id = ${noteId} AND NOT auto`
	);
	return num(n?.n);
}

function versionOf(
	r: Row,
	users: ReadonlyMap<string, { id: string; name: string; image: string | null }>
): NoteVersion {
	return {
		id: String(r.id),
		label: r.label == null ? null : String(r.label),
		auto: r.auto === true || r.auto === 't',
		sizeBytes: num(r.size_bytes),
		createdAt: toIso(r.created_at),
		createdBy: refOf(users, r.created_by == null ? null : String(r.created_by))
	};
}

export async function listVersions(ctx: RequestContext, noteId: string): Promise<NoteVersion[]> {
	const rows = await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId);
		return rowsOf(
			tx,
			sql`SELECT id, label, auto, size_bytes, created_by, created_at FROM note_versions
				WHERE note_id = ${noteId} ORDER BY created_at DESC, id DESC`
		);
	});
	const users = await userRefs(
		ctx,
		rows.map((r) => (r.created_by == null ? null : String(r.created_by)))
	);
	return rows.map((r) => versionOf(r, users));
}

/** Benannte Version (Bearbeiten-Zugriff; höchstens `MAX_VERSIONS_MANUAL` → 409) */
export async function saveVersion(
	ctx: RequestContext,
	noteId: string,
	label: string
): Promise<NoteVersion> {
	await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId, 'edit');
		if ((await manualCount(tx, noteId)) >= MAX_VERSIONS_MANUAL) {
			throw errors.conflict(
				`Höchstens ${MAX_VERSIONS_MANUAL} benannte Versionen je Notiz – lösche ältere zuerst`
			);
		}
	});
	const state = await fullState(noteId);
	const id = await mdb().transaction(async (tx) => {
		await lockNote(tx, noteId);
		if ((await manualCount(tx, noteId)) >= MAX_VERSIONS_MANUAL) {
			throw errors.conflict(
				`Höchstens ${MAX_VERSIONS_MANUAL} benannte Versionen je Notiz – lösche ältere zuerst`
			);
		}
		return insertVersion(tx, noteId, state, { label, auto: false, userId: ctx.userId });
	});
	const users = await userRefs(ctx, [ctx.userId]);
	return versionOf(
		{
			id,
			label,
			auto: false,
			size_bytes: state.byteLength,
			created_by: ctx.userId,
			created_at: new Date().toISOString()
		},
		users
	);
}

export async function getVersion(
	ctx: RequestContext,
	noteId: string,
	versionId: string
): Promise<NoteVersionDetail> {
	const row = await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId);
		const [r] = await rowsOf(
			tx,
			sql`SELECT id, label, auto, ydoc, size_bytes, created_by, created_at FROM note_versions
				WHERE id = ${versionId} AND note_id = ${noteId}`
		);
		return r;
	});
	if (!row) throw errors.notFound('Version nicht gefunden');
	const users = await userRefs(ctx, [row.created_by == null ? null : String(row.created_by)]);
	const state = bytesOf(row.ydoc);
	return {
		...versionOf(row, users),
		content: state ? jsonFromState(state) : { type: 'doc', content: [{ type: 'paragraph' }] }
	};
}

/** Version wiederherstellen (Bearbeiten-Zugriff) → ID der Sicherung „Vor dem Wiederherstellen“ */
export async function restoreVersion(
	ctx: RequestContext,
	noteId: string,
	versionId: string
): Promise<{ backupId: string }> {
	const row = await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId, 'edit');
		const [r] = await rowsOf(
			tx,
			sql`SELECT ydoc FROM note_versions WHERE id = ${versionId} AND note_id = ${noteId}`
		);
		return r;
	});
	if (!row) throw errors.notFound('Version nicht gefunden');
	const target = bytesOf(row.ydoc);
	const json = target ? jsonFromState(target) : { type: 'doc', content: [{ type: 'paragraph' }] };
	const current = await fullState(noteId);
	const backupId = await mdb().transaction(async (tx) => {
		await lockNote(tx, noteId);
		return insertVersion(tx, noteId, current, {
			label: 'Vor dem Wiederherstellen',
			auto: false,
			userId: ctx.userId
		});
	});
	await replaceContent(noteId, json, ctx.userId);
	return { backupId };
}

/** Version löschen (Eigentümer*in/`edit-all`) */
export async function deleteVersion(
	ctx: RequestContext,
	noteId: string,
	versionId: string
): Promise<void> {
	await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId, 'share');
		const [row] = await rowsOf(
			tx,
			sql`DELETE FROM note_versions WHERE id = ${versionId} AND note_id = ${noteId} RETURNING id`
		);
		if (!row) throw errors.notFound('Version nicht gefunden');
	});
}

/** Job: geänderte Notizen als automatische Version sichern → Anzahl Versionen */
export async function runAutoVersions(): Promise<number> {
	const due = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT id, update_count FROM notes
				WHERE update_count > version_count AND deleted_at IS NULL
				ORDER BY updated_at, id LIMIT ${AUTO_BATCH}`
		)
	);
	let n = 0;
	for (const r of due) {
		const noteId = String(r.id);
		try {
			const state = await fullState(noteId);
			await mdb().transaction(async (tx) => {
				await lockNote(tx, noteId);
				await insertVersion(tx, noteId, state, { label: null, auto: true, userId: null });
				await tx.execute(
					sql`UPDATE notes SET version_count = ${num(r.update_count)} WHERE id = ${noteId}`
				);
			});
			n++;
		} catch (e) {
			// Notiz inzwischen gelöscht o. Ä.: nächste
			console.warn('[notes] Automatische Version fehlgeschlagen', e);
		}
	}
	return n;
}
