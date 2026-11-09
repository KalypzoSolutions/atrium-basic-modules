/**
 * Änderungen an Elementen anwenden. Zusammenführung je Element: zuletzt geschrieben gewinnt (jede Änderung
 * ersetzt die ganzen Daten, `version` zählt hoch). Alle Änderungen einer Anfrage bekommen dieselbe neue
 * Änderungsnummer `seq` des Boards (unter `lockBoard`), Löschen setzt einen Grabstein (`deleted`), damit
 * wiederverbundene Clients es über `since` erfahren. Ein späteres Schreiben stellt ein gelöschtes Element
 * wieder her (Rückgängig).
 */
import { sql } from 'drizzle-orm';
import { errors, inList, num, type RequestContext, rowsOf, type Tx } from '$lib/sdk/server';
import { lockBoard, requireBoardAccess } from './access';
import { liveElementOf, mdb } from './boards.service';
import { broadcast } from './live';
import {
	ELEMENT_SCHEMAS,
	MAX_ELEMENT_BYTES,
	MAX_ELEMENTS,
	type ElementOp,
	type ElementType,
	type LiveElement,
	type OpsResult
} from './schemas';

type CheckedOp =
	| { id: string; deleted: true }
	| { id: string; type: ElementType; data: Record<string, unknown>; z: number; json: string };

/** Daten je Typ prüfen (422 mit Pfad `ops.<i>.data…`) und Größe begrenzen */
export function checkOps(ops: readonly ElementOp[]): CheckedOp[] {
	return ops.map((op, i): CheckedOp => {
		if ('deleted' in op) return { id: op.id, deleted: true };
		const res = ELEMENT_SCHEMAS[op.type].safeParse(op.data);
		if (!res.success) {
			const issue = res.error.issues[0];
			throw errors.validation([
				{
					path: [
						'ops',
						i,
						'data',
						...(issue?.path ?? []).map((p) => (typeof p === 'symbol' ? '' : p))
					],
					message: issue?.message ?? 'Ungültige Daten'
				}
			]);
		}
		const json = JSON.stringify(res.data);
		if (json.length > MAX_ELEMENT_BYTES) {
			throw errors.validation([{ path: ['ops', i, 'data'], message: 'Element ist zu groß' }]);
		}
		return { id: op.id, type: op.type, data: res.data as Record<string, unknown>, z: op.z, json };
	});
}

/** Verweise auf Dateien müssen zu diesem Board gehören */
async function assertAssets(tx: Tx, boardId: string, ops: CheckedOp[]): Promise<void> {
	const ids = new Set<string>();
	for (const op of ops) {
		if ('deleted' in op) continue;
		if ((op.type === 'image' || op.type === 'file') && typeof op.data.assetId === 'string') {
			ids.add(op.data.assetId);
		}
	}
	if (!ids.size) return;
	const found = await rowsOf(
		tx,
		sql`SELECT id FROM assets WHERE board_id = ${boardId} AND id IN (${inList([...ids])})`
	);
	if (found.length !== ids.size) {
		throw errors.validation([
			{ path: ['ops'], message: 'Datei gehört nicht zu diesem Whiteboard' }
		]);
	}
}

/** Änderungen in einer offenen Transaktion anwenden (ohne Zugriffsprüfung) */
export async function writeOps(
	tx: Tx,
	ctx: RequestContext,
	boardId: string,
	ops: CheckedOp[]
): Promise<{ seq: number; elements: LiveElement[] }> {
	await lockBoard(tx, boardId);
	await assertAssets(tx, boardId, ops);
	const [b] = await rowsOf(tx, sql`SELECT seq FROM boards WHERE id = ${boardId}`);
	const seq = num(b?.seq) + 1;
	const touched = new Set<string>();
	for (const op of ops) {
		touched.add(op.id);
		if ('deleted' in op) {
			await tx.execute(
				sql`UPDATE elements SET deleted = true, version = version + 1, seq = ${seq},
						updated_by = ${ctx.userId}, updated_at = now()
					WHERE board_id = ${boardId} AND id = ${op.id} AND NOT deleted`
			);
		} else {
			await tx.execute(
				sql`INSERT INTO elements (board_id, id, type, data, z, version, seq, deleted, updated_by)
					VALUES (${boardId}, ${op.id}, ${op.type}, ${op.json}::jsonb, ${op.z}, 1, ${seq}, false, ${ctx.userId})
					ON CONFLICT (board_id, id) DO UPDATE SET type = EXCLUDED.type, data = EXCLUDED.data,
						z = EXCLUDED.z, version = elements.version + 1, seq = EXCLUDED.seq, deleted = false,
						updated_by = EXCLUDED.updated_by, updated_at = now()`
			);
		}
	}
	const [count] = await rowsOf(
		tx,
		sql`SELECT count(*)::int AS n FROM elements WHERE board_id = ${boardId} AND NOT deleted`
	);
	const elementCount = num(count?.n);
	if (elementCount > MAX_ELEMENTS) {
		throw errors.conflict(`Ein Whiteboard kann höchstens ${MAX_ELEMENTS} Elemente enthalten`);
	}
	await tx.execute(
		sql`UPDATE boards SET seq = ${seq}, element_count = ${elementCount}, updated_at = now(),
			updated_by = ${ctx.userId} WHERE id = ${boardId}`
	);
	const rows = await rowsOf(
		tx,
		sql`SELECT id, type, data, z, version, deleted FROM elements
			WHERE board_id = ${boardId} AND seq = ${seq} AND id IN (${inList([...touched])})`
	);
	return { seq, elements: rows.map(liveElementOf) };
}

/** POST `/boards/:id/ops`: prüfen, anwenden, nach dem Commit verteilen */
export async function applyOps(
	ctx: RequestContext,
	boardId: string,
	input: { client: string; ops: ElementOp[] }
): Promise<OpsResult> {
	const ops = checkOps(input.ops);
	const result = await mdb().transaction(async (tx) => {
		await requireBoardAccess(tx, ctx, boardId, 'edit');
		return writeOps(tx, ctx, boardId, ops);
	});
	broadcast(
		boardId,
		{
			type: 'ops',
			seq: result.seq,
			client: input.client,
			userId: ctx.userId,
			elements: result.elements
		},
		input.client
	);
	return {
		seq: result.seq,
		applied: result.elements.map((e) => ({ id: e.id, version: e.version }))
	};
}
