/** Reine Logik von Aufgaben 2.0: Phasen, Zeitleiste, Vorlagen, Abhängigkeiten, Filter, Schemas. */
import { afterEach, describe, expect, it } from 'vitest';
import { setTodayForTests } from '$lib/sdk/dates';
import { currentPhase, phaseState, taskRange } from '$modules/tasks/phases';
import {
	isoWeek,
	monthTicks,
	moveRange,
	pxToDays,
	resizeRange,
	timelineRange,
	weekTicks
} from '$modules/tasks/timeline';
import {
	applyTemplate,
	BUILTIN_TEMPLATES,
	builtinTemplate,
	earliestDate,
	templateDataSchema,
	templateFromBoard
} from '$modules/tasks/templates';
import { createsCycle, startsBeforeBlocker } from '$modules/tasks/dependencies';
import { activeFilterCount, emptyFilter, matchesFilter } from '$modules/tasks/pages/filter';
import { dueText } from '$modules/tasks/pages/helpers';
import { phaseInput, taskDateIssues, taskInput, type TaskCard } from '$modules/tasks/schemas';

afterEach(() => setTodayForTests(null));

const phase = (startsOn: string | null, endsOn: string | null, position = 0) => ({
	startsOn,
	endsOn,
	position
});

describe('Phasen', () => {
	it('Stand an einem Tag (offene Enden, ohne Datum)', () => {
		expect(phaseState(phase('2027-01-01', '2027-01-31'), '2027-01-15')).toBe('active');
		expect(phaseState(phase('2027-01-01', '2027-01-31'), '2027-01-31')).toBe('active');
		expect(phaseState(phase('2027-01-01', '2027-01-31'), '2027-02-01')).toBe('past');
		expect(phaseState(phase('2027-01-01', null), '2026-12-31')).toBe('planned');
		expect(phaseState(phase(null, '2027-01-31'), '2026-01-01')).toBe('active');
		expect(phaseState(phase(null, null), '2027-01-01')).toBe('undated');
	});

	it('aktuelle Phase: laufende nach Reihenfolge, sonst nächste geplante', () => {
		const a = { id: 'a', ...phase('2027-03-01', '2027-03-31', 0) };
		const b = { id: 'b', ...phase('2027-02-01', '2027-02-28', 1) };
		const c = { id: 'c', ...phase('2027-01-01', '2027-04-01', 2) };
		expect(currentPhase([a, b, c], '2027-02-10')?.id).toBe('b');
		expect(currentPhase([a, b], '2027-01-10')?.id).toBe('b');
		expect(currentPhase([a, b], '2027-05-01')).toBeNull();
	});

	it('Zeitraum einer Aufgabe', () => {
		expect(taskRange({ startsOn: '2027-01-05', dueOn: '2027-01-20', isMilestone: false })).toEqual({
			from: '2027-01-05',
			to: '2027-01-20'
		});
		expect(taskRange({ startsOn: null, dueOn: '2027-01-20', isMilestone: false })).toEqual({
			from: '2027-01-20',
			to: '2027-01-20'
		});
		expect(taskRange({ startsOn: '2027-01-05', dueOn: null, isMilestone: false })?.to).toBe(
			'2027-01-05'
		);
		expect(taskRange({ startsOn: '2027-01-05', dueOn: '2027-01-20', isMilestone: true })).toEqual({
			from: '2027-01-20',
			to: '2027-01-20'
		});
		expect(taskRange({ startsOn: null, dueOn: null, isMilestone: false })).toBeNull();
	});
});

describe('Zeitleiste', () => {
	it('ganze Monate, mindestens drei, inklusive heute', () => {
		expect(timelineRange([], '2027-01-15')).toEqual({ from: '2027-01-01', to: '2027-03-31' });
		expect(timelineRange(['2026-11-20', '2027-06-02'], '2027-01-15')).toEqual({
			from: '2026-11-01',
			to: '2027-06-30'
		});
		// Schaltjahr 2028
		expect(timelineRange(['2028-02-10'], '2028-01-01').to).toBe('2028-03-31');
		expect(timelineRange(['2027-12-24'], '2027-12-01').to).toBe('2028-02-29');
	});

	it('Monatsköpfe mit Jahr am Anfang und im Januar', () => {
		const ticks = monthTicks({ from: '2026-11-01', to: '2027-02-28' });
		expect(ticks.map((t) => [t.label, t.offset, t.days])).toEqual([
			['Nov 2026', 0, 30],
			['Dez', 30, 31],
			['Jan 2027', 61, 31],
			['Feb', 92, 28]
		]);
	});

	it('Wochen beginnen montags, ISO-Kalenderwoche', () => {
		const ticks = weekTicks({ from: '2027-01-01', to: '2027-01-31' });
		expect(ticks[0]).toMatchObject({ date: '2027-01-04', label: 'KW 1' });
		expect(isoWeek('2026-12-31')).toBe(53);
		expect(isoWeek('2027-01-03')).toBe(53);
		expect(isoWeek('2028-01-03')).toBe(1);
	});

	it('Verschieben und Größe ändern, Ende nie vor dem Beginn', () => {
		const r = { from: '2027-01-10', to: '2027-01-12' };
		expect(moveRange(r, -10)).toEqual({ from: '2026-12-31', to: '2027-01-02' });
		expect(resizeRange(r, 'end', 3)).toEqual({ from: '2027-01-10', to: '2027-01-15' });
		expect(resizeRange(r, 'end', -9)).toEqual({ from: '2027-01-10', to: '2027-01-10' });
		expect(resizeRange(r, 'start', 5)).toEqual({ from: '2027-01-12', to: '2027-01-12' });
		expect(pxToDays(41, 'week')).toBe(1);
		expect(pxToDays(-70, 'month')).toBe(-10);
	});
});

describe('Vorlagen', () => {
	it('mitgelieferte Vorlagen sind gültig', () => {
		for (const t of BUILTIN_TEMPLATES)
			expect(templateDataSchema.safeParse(t.data).success).toBe(true);
		expect(builtinTemplate('builtin:gibtsnicht')).toBeNull();
	});

	it('Pfingstlager: Daten relativ zu Beginn und Ende', () => {
		const applied = applyTemplate(builtinTemplate('builtin:fahrt')!.data, {
			startsOn: '2027-05-14',
			endsOn: '2027-05-17'
		});
		const p = Object.fromEntries(applied.phases.map((x) => [x.name, [x.startsOn, x.endsOn]]));
		expect(p.Planung).toEqual(['2026-10-30', '2026-12-11']);
		expect(p.Lager).toEqual(['2027-05-14', '2027-05-17']);
		expect(p.Nachbereitung).toEqual(['2027-05-18', '2027-06-28']);
		const schluss = applied.tasks.find((t) => t.title === 'Anmeldeschluss')!;
		expect(schluss).toMatchObject({ dueOn: '2027-03-15', startsOn: null, isMilestone: true });
		// ohne Ende = eintägig
		const day = applyTemplate(builtinTemplate('builtin:fahrt')!.data, { startsOn: '2027-05-14' });
		expect(day.phases.find((x) => x.name === 'Lager')).toMatchObject({
			startsOn: '2027-05-14',
			endsOn: '2027-05-14'
		});
	});

	it('Board → Vorlage → Board ergibt dieselben Daten; nach dem Ende relativ zum Ende', () => {
		const source = {
			columns: [{ name: 'Offen', isDone: false }],
			phases: [
				{
					id: 'p1',
					name: 'Vorbereitung',
					color: null,
					startsOn: '2027-04-01',
					endsOn: '2027-05-13'
				},
				{ id: 'p2', name: 'Nach', color: '#16a34a', startsOn: '2027-05-18', endsOn: null }
			],
			tasks: [
				{
					title: 'Material',
					description: null,
					priority: 'high' as const,
					phaseId: 'p1',
					startsOn: '2027-04-10',
					dueOn: '2027-04-20',
					isMilestone: false,
					checklist: ['Zelte']
				},
				{
					title: 'Abrechnung',
					description: 'bis Ende Juni',
					priority: 'medium' as const,
					phaseId: 'p2',
					startsOn: null,
					dueOn: '2027-06-28',
					isMilestone: true,
					checklist: []
				}
			]
		};
		const data = templateFromBoard(source, { startsOn: '2027-05-14', endsOn: '2027-05-17' });
		expect(data.phases[1]!.start).toEqual({ from: 'end', days: 1 });
		expect(data.tasks[1]!.due).toEqual({ from: 'end', days: 42 });
		expect(data.tasks[0]).toMatchObject({ phase: 0, start: { from: 'start', days: -34 } });
		const again = applyTemplate(data, { startsOn: '2027-05-14', endsOn: '2027-05-17' });
		expect(again.tasks.map((t) => [t.startsOn, t.dueOn, t.phase])).toEqual([
			['2027-04-10', '2027-04-20', 0],
			[null, '2027-06-28', 1]
		]);
		// längere Aktion: Nachbereitung wandert mit dem Ende
		const longer = applyTemplate(data, { startsOn: '2027-05-14', endsOn: '2027-05-21' });
		expect(longer.tasks[1]!.dueOn).toBe('2027-07-02');
		expect(earliestDate(source)).toBe('2027-04-01');
	});
});

describe('Abhängigkeiten', () => {
	it('erkennt Kreise über mehrere Stufen', () => {
		const edges = new Map([
			['b', ['a']],
			['c', ['b']]
		]);
		expect(createsCycle(edges, 'a', ['c'])).toBe(true);
		expect(createsCycle(edges, 'a', ['x'])).toBe(false);
		expect(createsCycle(edges, 'd', ['c'])).toBe(false);
		expect(createsCycle(new Map(), 'a', ['a'])).toBe(true);
	});

	it('Terminkonflikt nur mit beiden Daten', () => {
		expect(
			startsBeforeBlocker({ startsOn: '2027-01-05', dueOn: null }, { dueOn: '2027-01-10' })
		).toBe(true);
		expect(
			startsBeforeBlocker({ startsOn: null, dueOn: '2027-01-10' }, { dueOn: '2027-01-10' })
		).toBe(false);
		expect(startsBeforeBlocker({ startsOn: null, dueOn: null }, { dueOn: '2027-01-10' })).toBe(
			false
		);
	});
});

describe('Schemas und Anzeige', () => {
	it('Regeln für Zeitraum und Meilenstein', () => {
		expect(taskDateIssues({ startsOn: '2027-02-01', dueOn: '2027-01-01' })).toEqual([
			{ path: ['startsOn'], message: 'Der Beginn liegt nach der Fälligkeit' }
		]);
		expect(taskDateIssues({ isMilestone: true, startsOn: '2027-01-01', dueOn: null })).toHaveLength(
			2
		);
		expect(taskDateIssues({ isMilestone: true, dueOn: '2027-01-01' })).toEqual([]);
		expect(taskInput.safeParse({ title: 'x', isMilestone: true }).success).toBe(false);
		expect(
			taskInput.safeParse({ title: 'x', startsOn: '2027-01-01', dueOn: '2027-01-01' }).success
		).toBe(true);
		expect(
			phaseInput.safeParse({ name: 'P', startsOn: '2027-02-01', endsOn: '2027-01-01' }).success
		).toBe(false);
	});

	it('Fälligkeit als Kurztext', () => {
		setTodayForTests('2027-01-10');
		expect(dueText('2027-01-10')).toBe('Heute');
		expect(dueText('2027-01-11')).toBe('Morgen');
		expect(dueText('2027-01-09')).toBe('seit gestern');
		expect(dueText('2027-01-07')).toBe('seit 3 Tagen');
		expect(dueText('2027-01-07', true)).toBe('07.01.');
		expect(dueText('2027-01-20', false, '2027-01-12')).toBe('12.01.–20.01.');
		expect(dueText('2028-01-20')).toBe('20.01.2028');
		expect(dueText(null, false, '2027-02-01')).toBe('ab 01.02.');
	});

	it('Filter', () => {
		const card = (over: Partial<TaskCard>): TaskCard => ({
			id: 't',
			columnId: 'c1',
			title: 'Zeltplatz anfragen',
			priority: 'medium',
			dueOn: null,
			position: 0,
			assignees: [],
			checklist: { done: 0, total: 0 },
			hasDescription: false,
			completedAt: null,
			startsOn: null,
			isMilestone: false,
			phaseId: null,
			blockedBy: [],
			openBlockers: 0,
			canMove: false,
			...over
		});
		const ctx = { myId: 'me', canEdit: true, today: '2027-01-10', isDone: () => false };
		const f = emptyFilter();
		expect(activeFilterCount(f)).toBe(0);
		expect(matchesFilter(card({}), { ...f, search: 'zelt' }, ctx)).toBe(true);
		expect(matchesFilter(card({}), { ...f, onlyMine: true }, ctx)).toBe(false);
		expect(
			matchesFilter(
				card({ assignees: [{ id: 'me', name: 'Ich', image: null }] }),
				{ ...f, onlyMine: true },
				ctx
			)
		).toBe(true);
		expect(matchesFilter(card({ phaseId: 'p' }), { ...f, phaseId: 'none' }, ctx)).toBe(false);
		expect(matchesFilter(card({}), { ...f, phaseId: 'none' }, ctx)).toBe(true);
		expect(matchesFilter(card({ dueOn: '2027-01-09' }), { ...f, due: 'overdue' }, ctx)).toBe(true);
		expect(matchesFilter(card({ dueOn: '2027-01-17' }), { ...f, due: 'week' }, ctx)).toBe(true);
		expect(matchesFilter(card({ dueOn: '2027-01-18' }), { ...f, due: 'week' }, ctx)).toBe(false);
		expect(matchesFilter(card({ priority: 'high' }), { ...f, priorities: ['urgent'] }, ctx)).toBe(
			false
		);
		expect(activeFilterCount({ ...f, due: 'none', priorities: ['high'] })).toBe(2);
	});
});
