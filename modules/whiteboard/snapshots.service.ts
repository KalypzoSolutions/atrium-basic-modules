/**
 * Versionsverlauf und Aufräumen. Eine Version ist ein eingefrorenes Abbild aller sichtbaren Elemente
 * (`snapshots.elements`). Automatisch stündlich bei Änderungen (höchstens `MAX_SNAPSHOTS_AUTO` je Board),
 * manuell mit Namen. Wiederherstellen sichert vorher den aktuellen Stand und schreibt die Elemente
 * als normale Änderungen (neue Änderungsnummer), danach bekommen alle Verbindungen `reset`.
 */
import { sql } from 'drizzle-orm';
import { errors, num, type RequestContext, rowsOf, toIso, type Tx } from '$lib/sdk/server';
import { lockBoard, requireBoardAccess } from './access';
import { mdb, userRefs } from './boards.service';
import { broadcast } from './live';
import { checkOps, writeOps } from './ops.service';
import { removeFiles } from './storage';
import {
	MAX_SNAPSHOTS_AUTO,
	MAX_SNAPSHOTS_MANUAL,
	type ElementOp,
	type ElementType,
	type Snapshot
} from './schemas';

/** Gelöschte Elemente so lange behalten (Wiederverbinden mit `since`) */
const TOMBSTONE_DAYS = 30;
/** Nicht mehr verwendete Dateien erst nach dieser Zeit entfernen (Rückgängig, offene Editoren) */
const ASSET_GRACE_HOURS = 24;

/** Abbild anlegen (in der Transaktion, unter `lockBoard`) */
export async function createSnapshot(
	tx: Tx,
	boardId: string,
	input: { label: string | null; auto: boolean; userId: string | null }
): Promise<string> {
	const id = crypto.randomUUID();
	await tx.execute(
		sql`INSERT INTO snapshots (id, board_id, label, auto, seq, elements, element_count, created_by)
			SELECT ${id}, b.id, ${input.label}, ${input.auto}, b.seq,
				COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type, 'data', e.data, 'z', e.z)
					ORDER BY e.z, e.id) FROM elements e WHERE e.board_id = b.id AND NOT e.deleted), '[]'::jsonb),
				b.element_count, ${input.userId}
			FROM boards b WHERE b.id = ${boardId}`
	);
	if (input.auto) {
		await tx.execute(
			sql`DELETE FROM snapshots WHERE id IN (
				SELECT id FROM snapshots WHERE board_id = ${boardId} AND auto
				ORDER BY created_at DESC, id DESC OFFSET ${MAX_SNAPSHOTS_AUTO})`
		);
	}
	return id;
}

export async function listSnapshots(ctx: RequestContext, boardId: string): Promise<Snapshot[]> {
	const rows = await mdb().transaction(async (tx) => {
		await requireBoardAccess(tx, ctx, boardId);
		return rowsOf(
			tx,
			sql`SELECT id, label, auto, element_count, created_by, created_at FROM snapshots
				WHERE board_id = ${boardId} ORDER BY created_at DESC, id DESC`
		);
	});
	const users = await userRefs(
		ctx,
		rows.map((r) => (r.created_by == null ? null : String(r.created_by)))
	);
	return rows.map((r) => ({
		id: String(r.id),
		label: r.label == null ? null : String(r.label),
		auto: r.auto === true || r.auto === 't',
		elementCount: num(r.element_count),
		createdAt: toIso(r.created_at),
		createdBy: r.created_by == null ? null : (users.get(String(r.created_by)) ?? null)
	}));
}

/** Manuelle Version (Name), Bearbeiten-Zugriff */
export async function saveSnapshot(
	ctx: RequestContext,
	boardId: string,
	label: string
): Promise<string> {
	return mdb().transaction(async (tx) => {
		await requireBoardAccess(tx, ctx, boardId, 'edit');
		await lockBoard(tx, boardId);
		const [n] = await rowsOf(
			tx,
			sql`SELECT count(*)::int AS n FROM snapshots WHERE board_id = ${boardId} AND NOT auto`
		);
		if (num(n?.n) >= MAX_SNAPSHOTS_MANUAL) {
			throw errors.conflict(
				`Höchstens ${MAX_SNAPSHOTS_MANUAL} benannte Versionen je Whiteboard – lösche ältere zuerst`
			);
		}
		return createSnapshot(tx, boardId, { label, auto: false, userId: ctx.userId });
	});
}

export async function deleteSnapshot(
	ctx: RequestContext,
	boardId: string,
	snapshotId: string
): Promise<void> {
	await mdb().transaction(async (tx) => {
		await requireBoardAccess(tx, ctx, boardId, 'edit');
		const [row] = await rowsOf(
			tx,
			sql`DELETE FROM snapshots WHERE id = ${snapshotId} AND board_id = ${boardId} RETURNING id`
		);
		if (!row) throw errors.notFound('Version nicht gefunden');
	});
}

/** Version wiederherstellen → Anzahl Elemente */
export async function restoreSnapshot(
	ctx: RequestContext,
	boardId: string,
	snapshotId: string
): Promise<number> {
	const count = await mdb().transaction(async (tx) => {
		await requireBoardAccess(tx, ctx, boardId, 'edit');
		await lockBoard(tx, boardId);
		const [snap] = await rowsOf(
			tx,
			sql`SELECT elements FROM snapshots WHERE id = ${snapshotId} AND board_id = ${boardId}`
		);
		if (!snap) throw errors.notFound('Version nicht gefunden');
		const elements = (
			typeof snap.elements === 'string' ? JSON.parse(snap.elements) : snap.elements
		) as { id: string; type: ElementType; data: unknown; z: number }[];
		await createSnapshot(tx, boardId, {
			label: 'Vor dem Wiederherstellen',
			auto: false,
			userId: ctx.userId
		});
		// Bilder/Dateien, deren Datei inzwischen entfernt wurde, fallen weg
		const assets = new Set(
			(await rowsOf(tx, sql`SELECT id FROM assets WHERE board_id = ${boardId}`)).map((r) =>
				String(r.id)
			)
		);
		const keep = elements.filter((e) => {
			if (e.type !== 'image' && e.type !== 'file') return true;
			const assetId = (e.data as { assetId?: unknown })?.assetId;
			return typeof assetId === 'string' && assets.has(assetId);
		});
		const keepIds = new Set(keep.map((e) => e.id));
		const current = await rowsOf(
			tx,
			sql`SELECT id FROM elements WHERE board_id = ${boardId} AND NOT deleted`
		);
		const ops: ElementOp[] = [
			...current
				.map((r) => String(r.id))
				.filter((id) => !keepIds.has(id))
				.map((id) => ({ id, deleted: true as const })),
			...keep.map((e) => ({ id: e.id, type: e.type, data: e.data, z: e.z }))
		];
		if (ops.length) await writeOps(tx, ctx, boardId, checkOps(ops));
		return keep.length;
	});
	broadcast(boardId, { type: 'reset', reason: 'restore' });
	return count;
}

/** Job `snapshots` (stündlich): automatische Version je geändertem Board */
export async function runAutoSnapshots(): Promise<number> {
	const boards = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT id FROM boards WHERE seq > snapshot_seq ORDER BY updated_at LIMIT 500`)
	);
	let n = 0;
	for (const b of boards) {
		const id = String(b.id);
		await mdb().transaction(async (tx) => {
			await lockBoard(tx, id);
			await createSnapshot(tx, id, { label: null, auto: true, userId: null });
			await tx.execute(sql`UPDATE boards SET snapshot_seq = seq WHERE id = ${id}`);
		});
		n++;
	}
	return n;
}

/**
 * Job `cleanup` (täglich): alte Grabsteine entfernen (`purged_seq` merkt die Grenze für `since`) und
 * Dateien löschen, die kein Element (auch kein gelöschtes) und keine Version mehr verwendet.
 */
export async function runCleanup(): Promise<{ tombstones: number; assets: number }> {
	const result = await mdb().transaction(async (tx) => {
		const purged = await rowsOf(
			tx,
			sql`DELETE FROM elements WHERE deleted AND updated_at < now() - make_interval(days => ${TOMBSTONE_DAYS})
				RETURNING board_id, seq`
		);
		const maxByBoard = new Map<string, number>();
		for (const r of purged) {
			const id = String(r.board_id);
			maxByBoard.set(id, Math.max(maxByBoard.get(id) ?? 0, num(r.seq)));
		}
		for (const [id, seq] of maxByBoard) {
			await tx.execute(
				sql`UPDATE boards SET purged_seq = GREATEST(purged_seq, ${seq}) WHERE id = ${id}`
			);
		}
		const unused = await rowsOf(
			tx,
			sql`DELETE FROM assets a
				WHERE a.created_at < now() - make_interval(hours => ${ASSET_GRACE_HOURS})
					AND NOT EXISTS (SELECT 1 FROM elements e WHERE e.board_id = a.board_id
						AND e.type IN ('image', 'file') AND e.data->>'assetId' = a.id)
					AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.board_id = a.board_id
						AND s.elements::text LIKE '%' || a.id || '%')
				RETURNING a.paths`
		);
		return {
			tombstones: purged.length,
			paths: unused.flatMap((a) =>
				Object.values(
					(typeof a.paths === 'string' ? JSON.parse(a.paths) : a.paths) as Record<string, string>
				)
			),
			assets: unused.length
		};
	});
	await removeFiles(result.paths);
	return { tombstones: result.tombstones, assets: result.assets };
}
