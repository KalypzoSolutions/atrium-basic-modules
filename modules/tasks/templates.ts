/**
 * Board-Vorlagen (rein, Server und UI): Phasen und Aufgaben mit Daten relativ zu Beginn bzw. Ende einer Aktion.
 * Mitgelieferte Vorlagen stehen hier im Code (`builtin:<id>`), eigene als JSON in `board_templates.data`.
 */
import { z } from 'zod';
import { addDays, daysBetween } from '$lib/sdk/dates';
import {
	DEFAULT_COLUMNS,
	MAX_CHECKLIST,
	MAX_CHECKLIST_TITLE,
	MAX_COLUMN_NAME,
	MAX_COLUMNS,
	MAX_PHASE_NAME,
	MAX_PHASES,
	MAX_SHIFT_DAYS,
	MAX_TASK_DESCRIPTION,
	MAX_TASK_TITLE,
	PRIORITIES,
	type Priority
} from './schemas';

/** Aufgaben je Vorlage */
export const MAX_TEMPLATE_TASKS = 500;

const offset = z
	.object({
		from: z.enum(['start', 'end']),
		days: z.number().int().min(-MAX_SHIFT_DAYS).max(MAX_SHIFT_DAYS)
	})
	.strict();
export type TemplateOffset = z.infer<typeof offset>;

const colorValue = z
	.string()
	.regex(/^#[0-9a-f]{6}$/)
	.nullable();

export const templateDataSchema = z
	.object({
		version: z.literal(1),
		columns: z
			.array(
				z.object({ name: z.string().min(1).max(MAX_COLUMN_NAME), isDone: z.boolean() }).strict()
			)
			.min(1)
			.max(MAX_COLUMNS),
		phases: z
			.array(
				z
					.object({
						name: z.string().min(1).max(MAX_PHASE_NAME),
						color: colorValue,
						start: offset.nullable(),
						end: offset.nullable()
					})
					.strict()
			)
			.max(MAX_PHASES),
		tasks: z
			.array(
				z
					.object({
						title: z.string().min(1).max(MAX_TASK_TITLE),
						description: z.string().max(MAX_TASK_DESCRIPTION).nullable(),
						priority: z.enum(PRIORITIES),
						/** Index in `phases` */
						phase: z.number().int().min(0).max(MAX_PHASES).nullable(),
						start: offset.nullable(),
						due: offset.nullable(),
						milestone: z.boolean(),
						checklist: z.array(z.string().min(1).max(MAX_CHECKLIST_TITLE)).max(MAX_CHECKLIST)
					})
					.strict()
			)
			.max(MAX_TEMPLATE_TASKS)
	})
	.strict();
export type TemplateData = z.infer<typeof templateDataSchema>;

export interface BuiltinTemplate {
	id: string;
	name: string;
	description: string;
	data: TemplateData;
}

const s = (days: number): TemplateOffset => ({ from: 'start', days });
const e = (days: number): TemplateOffset => ({ from: 'end', days });
const columns = DEFAULT_COLUMNS.map((c) => ({ name: c.name, isDone: c.isDone }));

function task(
	title: string,
	phase: number,
	due: TemplateOffset,
	more: {
		start?: TemplateOffset;
		milestone?: boolean;
		priority?: Priority;
		checklist?: string[];
	} = {}
): TemplateData['tasks'][number] {
	return {
		title,
		description: null,
		priority: more.priority ?? 'medium',
		phase,
		start: more.start ?? null,
		due,
		milestone: more.milestone ?? false,
		checklist: more.checklist ?? []
	};
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
	{
		id: 'builtin:fahrt',
		name: 'Fahrt / Lager',
		description:
			'Planung, Anmeldung, Vorbereitung, Lager und Nachbereitung für Fahrten mit Übernachtung.',
		data: {
			version: 1,
			columns,
			phases: [
				{ name: 'Planung', color: '#7c3aed', start: s(-196), end: s(-154) },
				{ name: 'Anmeldung', color: '#d97706', start: s(-133), end: s(-60) },
				{ name: 'Vorbereitung', color: '#0891b2', start: s(-59), end: s(-1) },
				{ name: 'Lager', color: '#dc2626', start: s(0), end: e(0) },
				{ name: 'Nachbereitung', color: '#16a34a', start: e(1), end: e(42) }
			],
			tasks: [
				task('Termin und Budget festlegen', 0, s(-182), { start: s(-196) }),
				task('Zeltplatz oder Haus anfragen', 0, s(-168), {
					priority: 'high',
					checklist: ['Kontakt raussuchen', 'Anfrage schicken', 'Bestätigung ablegen']
				}),
				task('Kalkulation anlegen', 0, s(-154), { start: s(-175) }),
				task('Anmeldelink freischalten', 1, s(-133)),
				task('Elternbrief schreiben', 1, s(-120)),
				task('Zuschussantrag vorbereiten', 1, s(-75), { start: s(-100) }),
				task('Anmeldeschluss', 1, s(-60), { milestone: true }),
				task('Programm planen', 2, s(-10), { start: s(-59) }),
				task('Material reservieren', 2, s(-35)),
				task('Packliste verschicken', 2, s(-30)),
				task('Einkauf planen', 2, s(-7)),
				task('Rückmeldungen sammeln', 4, e(14)),
				task('Fotos in die Galerie hochladen', 4, e(21)),
				task('Abrechnung abschließen', 4, e(42), { milestone: true })
			]
		}
	},
	{
		id: 'builtin:tagesaktion',
		name: 'Tagesaktion',
		description: 'Kurze Vorbereitung, Aktionstag und Nachbereitung.',
		data: {
			version: 1,
			columns,
			phases: [
				{ name: 'Vorbereitung', color: '#0891b2', start: s(-28), end: s(-1) },
				{ name: 'Aktion', color: '#dc2626', start: s(0), end: e(0) },
				{ name: 'Nachbereitung', color: '#16a34a', start: e(1), end: e(14) }
			],
			tasks: [
				task('Ort und Ablauf klären', 0, s(-28)),
				task('Einladung verschicken', 0, s(-21)),
				task('Material zusammenstellen', 0, s(-3)),
				task('Abrechnung abschließen', 2, e(14), { milestone: true })
			]
		}
	}
];

export function builtinTemplate(id: string): BuiltinTemplate | null {
	return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? null;
}

export interface AppliedTemplate {
	columns: { name: string; isDone: boolean }[];
	phases: { name: string; color: string | null; startsOn: string | null; endsOn: string | null }[];
	tasks: {
		title: string;
		description: string | null;
		priority: Priority;
		phase: number | null;
		startsOn: string | null;
		dueOn: string | null;
		isMilestone: boolean;
		checklist: string[];
	}[];
}

/** Vorlage auf echte Daten umrechnen (`endsOn` fehlt = eintägig) */
export function applyTemplate(
	data: TemplateData,
	anchor: { startsOn: string; endsOn?: string | null }
): AppliedTemplate {
	const end = anchor.endsOn && anchor.endsOn >= anchor.startsOn ? anchor.endsOn : anchor.startsOn;
	const at = (o: TemplateOffset | null) =>
		o ? addDays(o.from === 'end' ? end : anchor.startsOn, o.days) : null;
	const phases = data.phases.map((p) => {
		let startsOn = at(p.start);
		let endsOn = at(p.end);
		if (startsOn && endsOn && endsOn < startsOn) [startsOn, endsOn] = [endsOn, startsOn];
		return { name: p.name, color: p.color, startsOn, endsOn };
	});
	const tasks = data.tasks.map((t) => {
		let startsOn = t.milestone ? null : at(t.start);
		let dueOn = at(t.due);
		if (startsOn && dueOn && startsOn > dueOn) [startsOn, dueOn] = [dueOn, startsOn];
		return {
			title: t.title,
			description: t.description,
			priority: t.priority,
			phase: t.phase !== null && t.phase < phases.length ? t.phase : null,
			startsOn,
			dueOn,
			isMilestone: t.milestone && !!dueOn,
			checklist: t.checklist
		};
	});
	return { columns: data.columns, phases, tasks };
}

export interface TemplateSource {
	columns: { name: string; isDone: boolean }[];
	phases: {
		id: string;
		name: string;
		color: string | null;
		startsOn: string | null;
		endsOn: string | null;
	}[];
	tasks: {
		title: string;
		description: string | null;
		priority: Priority;
		phaseId: string | null;
		startsOn: string | null;
		dueOn: string | null;
		isMilestone: boolean;
		checklist: string[];
	}[];
}

/**
 * Board → Vorlage. Daten werden relativ zu `anchor.startsOn` gespeichert, Daten nach `anchor.endsOn`
 * relativ zum Ende (so wandern Nachbereitungs-Fristen bei längeren Aktionen mit).
 */
export function templateFromBoard(
	board: TemplateSource,
	anchor: { startsOn: string; endsOn?: string | null }
): TemplateData {
	const end = anchor.endsOn && anchor.endsOn >= anchor.startsOn ? anchor.endsOn : null;
	const rel = (date: string | null): TemplateOffset | null => {
		if (!date) return null;
		if (end && date > end) return { from: 'end', days: daysBetween(end, date) };
		return { from: 'start', days: daysBetween(anchor.startsOn, date) };
	};
	const phaseIndex = new Map(board.phases.map((p, i) => [p.id, i]));
	return {
		version: 1,
		columns: board.columns.slice(0, MAX_COLUMNS),
		phases: board.phases.slice(0, MAX_PHASES).map((p) => ({
			name: p.name,
			color: p.color,
			start: rel(p.startsOn),
			end: rel(p.endsOn)
		})),
		tasks: board.tasks.slice(0, MAX_TEMPLATE_TASKS).map((t) => ({
			title: t.title,
			description: t.description,
			priority: t.priority,
			phase: t.phaseId ? (phaseIndex.get(t.phaseId) ?? null) : null,
			start: t.isMilestone ? null : rel(t.startsOn),
			due: rel(t.dueOn),
			milestone: t.isMilestone,
			checklist: t.checklist.slice(0, MAX_CHECKLIST)
		}))
	};
}

/** Frühestes Datum eines Boards (Bezug, wenn weder Aktion noch Bezugsdatum bekannt sind) */
export function earliestDate(board: Pick<TemplateSource, 'phases' | 'tasks'>): string | null {
	const dates = [
		...board.phases.flatMap((p) => [p.startsOn, p.endsOn]),
		...board.tasks.flatMap((t) => [t.startsOn, t.dueOn])
	].filter((d): d is string => !!d);
	return dates.length ? dates.sort()[0]! : null;
}
