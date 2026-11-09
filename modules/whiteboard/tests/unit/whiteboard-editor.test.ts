/**
 * Modul `whiteboard` – reine Bausteine: Geometrie (Drehung, Anker, Rahmen-Inhalt), Verbinder, Textumbruch,
 * Freihand (Ausdünnen, natürliche Größe), Ansicht (Zoom am Punkt, Einpassen), Element-Schemas und Links.
 */
import { describe, expect, it } from 'vitest';
import {
	anchorPoint,
	borderPoint,
	boundsOfPoints,
	corners,
	frameChildren,
	hitBox,
	rotatePoint,
	shapePath
} from '$modules/whiteboard/pages/editor/geometry';
import {
	arrowHeadPath,
	connectorDistance,
	connectorGeometry,
	resolveConnector
} from '$modules/whiteboard/pages/editor/connectors';
import {
	approxMeasure,
	fitFontSize,
	textHeight,
	layoutText,
	wrapText
} from '$modules/whiteboard/pages/editor/text-layout';
import { finalizeStroke, strokePath } from '$modules/whiteboard/pages/editor/freehand';
import {
	fitRect,
	stepZoom,
	toScreen,
	toWorld,
	zoomAt
} from '$modules/whiteboard/pages/editor/viewport';
import {
	fileKind,
	fixedPalette,
	hostOf,
	ink,
	LIGHT,
	textOn
} from '$modules/whiteboard/pages/editor/render';
import {
	connectorData,
	isAllowedLink,
	linkData,
	MAX_POINTS,
	parseElementData,
	shapeData,
	type WbElement
} from '$modules/whiteboard/schemas';

const shape = (id: string, x: number, y: number, w = 100, h = 50, rotation = 0): WbElement => ({
	id,
	z: 1,
	version: 1,
	type: 'shape',
	data: shapeData.parse({ kind: 'rect', x, y, w, h, rotation })
});

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
	expect(a.x).toBeCloseTo(b.x, 5);
	expect(a.y).toBeCloseTo(b.y, 5);
};

describe('Geometrie', () => {
	it('dreht Punkte um einen Mittelpunkt', () => {
		close(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 10 });
		close(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 0), { x: 10, y: 0 });
	});

	it('Ecken eines gedrehten Rahmens und Hüllrechteck', () => {
		const pts = corners({ x: 0, y: 0, w: 100, h: 100, rotation: 45 });
		const b = boundsOfPoints(pts);
		expect(b.w).toBeCloseTo(Math.SQRT2 * 100, 5);
		expect(b.x + b.w / 2).toBeCloseTo(50, 5);
	});

	it('Treffer berücksichtigt Drehung und Toleranz', () => {
		const box = { x: 0, y: 0, w: 100, h: 10, rotation: 90 };
		// um 90° gedreht: senkrecht durch die Mitte (50, 5)
		expect(hitBox({ x: 50, y: -30 }, box)).toBe(true);
		expect(hitBox({ x: 5, y: 5 }, box)).toBe(false);
		expect(hitBox({ x: 49, y: 5 + 50 + 3 }, box, 4)).toBe(true);
	});

	it('Randpunkt in Richtung eines Ziels (Rechteck und Ellipse)', () => {
		const box = { x: 0, y: 0, w: 100, h: 50, rotation: 0 };
		close(borderPoint(box, { x: 500, y: 25 }), { x: 100, y: 25 });
		close(borderPoint(box, { x: 50, y: -400 }), { x: 50, y: 0 });
		const e = borderPoint(box, { x: 500, y: 25 }, true);
		close(e, { x: 100, y: 25 });
		close(anchorPoint(box, 'bottom', { x: 0, y: 0 }), { x: 50, y: 50 });
	});

	it('Formen liefern geschlossene Pfade im Rahmen', () => {
		for (const kind of [
			'rect',
			'ellipse',
			'diamond',
			'triangle',
			'hexagon',
			'star',
			'speech',
			'cloud',
			'rounded'
		] as const) {
			const d = shapePath(kind, 120, 80);
			expect(d.startsWith('M'), kind).toBe(true);
			expect(d.trim().endsWith('Z'), kind).toBe(true);
			const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
			expect(Math.min(...nums), kind).toBeGreaterThanOrEqual(-0.01);
		}
	});

	it('Rahmen nimmt nur vollständig enthaltene Elemente mit (keine anderen Rahmen)', () => {
		const frame: WbElement = {
			id: 'f',
			z: 0,
			version: 1,
			type: 'frame',
			data: {
				x: 0,
				y: 0,
				w: 500,
				h: 500,
				rotation: 0,
				locked: false,
				title: 'Tag 1',
				color: null,
				fill: 'transparent'
			}
		};
		const inner = shape('a', 10, 10);
		const half = shape('b', 450, 450);
		const other: WbElement = {
			...frame,
			id: 'g',
			data: { ...frame.data, x: 20, y: 20, w: 50, h: 50 }
		};
		expect(frameChildren(frame, [frame, inner, half, other])).toEqual(['a']);
	});
});

describe('Verbinder', () => {
	const A = crypto.randomUUID();
	const B = crypto.randomUUID();
	const a = shape(A, 0, 0, 100, 50);
	const b = shape(B, 300, 0, 100, 50);
	const lookup = (id: string) => [a, b].find((e) => e.id === id);

	it('gebundene Enden folgen den Elementen (Randpunkte, gespeicherte Koordinaten egal)', () => {
		const data = connectorData.parse({
			from: { elementId: A, x: -999, y: -999 },
			to: { elementId: B, x: 999, y: 999 }
		});
		const geo = resolveConnector(data, lookup);
		close(geo.a, { x: 100, y: 25 });
		close(geo.b, { x: 300, y: 25 });
		expect(geo.endAngle).toBeCloseTo(0, 5);
	});

	it('fehlendes Element → freies Ende an den gespeicherten Koordinaten', () => {
		const data = connectorData.parse({
			from: { elementId: A, x: 0, y: 0 },
			to: { elementId: crypto.randomUUID(), x: 500, y: 80 }
		});
		close(resolveConnector(data, lookup).b, { x: 500, y: 80 });
	});

	it('gewinkelt: drei Segmente, Knick über `bend`', () => {
		const ends = {
			a: { x: 0, y: 0 },
			b: { x: 200, y: 100 },
			dirA: { x: 1, y: 0 },
			dirB: { x: -1, y: 0 }
		};
		const mid = connectorGeometry('elbow', ends, 0);
		expect(mid.path).toBe('M0,0 L100,0 L100,100 L200,100');
		const bent = connectorGeometry('elbow', ends, 0.5);
		expect(bent.mid.x).toBe(150);
	});

	it('Treffer-Abstand und Pfeilspitzen', () => {
		const geo = connectorGeometry('straight', {
			a: { x: 0, y: 0 },
			b: { x: 100, y: 0 },
			dirA: null,
			dirB: null
		});
		expect(connectorDistance(geo, 'straight', { x: 50, y: 7 })).toBeCloseTo(7, 5);
		expect(arrowHeadPath('none', geo.b, 0, 2)).toBeNull();
		expect(arrowHeadPath('triangle', geo.b, 0, 2)?.filled).toBe(true);
		const curve = connectorGeometry(
			'curve',
			{ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, dirA: null, dirB: null },
			0.5
		);
		expect(curve.path).toMatch(/^M0,0 C/);
		expect(connectorDistance(curve, 'curve', curve.mid)).toBeLessThan(1);
	});
});

describe('Text', () => {
	it('bricht nach Wörtern um, lange Wörter zeichenweise, harte Umbrüche bleiben', () => {
		const m = approxMeasure; // 0,54 × fontSize je Zeichen → 10 px bei 18,5
		const lines = wrapText('Zelte aufbauen und Lagerplatz erkunden', 100, 18.5, { measure: m });
		expect(lines.every((l) => m(l, 18.5, false, false) <= 100)).toBe(true);
		expect(lines.join(' ')).toBe('Zelte aufbauen und Lagerplatz erkunden');
		expect(wrapText('Donaudampfschifffahrt', 50, 18.5, { measure: m }).join('')).toBe(
			'Donaudampfschifffahrt'
		);
		expect(wrapText('A\n\nB', 100, 18, { measure: m })).toEqual(['A', '', 'B']);
	});

	it('ordnet Zeilen an und kürzt zu viele mit „…“', () => {
		const lay = layoutText(
			'eins zwei drei vier fünf sechs',
			{ x: 0, y: 0, w: 40, h: 50 },
			{ fontSize: 20, align: 'center', valign: 'top' }
		);
		expect(lay.overflow).toBe(true);
		expect(lay.lines).toHaveLength(2);
		expect(lay.lines[1]!.text.endsWith('…')).toBe(true);
		expect(lay.anchor).toBe('middle');
		expect(lay.lines[0]!.x).toBe(20);
	});
});

describe('Textfelder', () => {
	const style = { fontSize: 40, align: 'center' as const, valign: 'middle' as const };

	it('verkleinert die Schrift, bis alles passt (nie unter 8 px)', () => {
		const area = { w: 180, h: 160 };
		const text = 'Geländespiel mit Schatzsuche und Kartenkunde am Nachmittag';
		const size = fitFontSize(text, area, style);
		expect(size).toBeLessThan(40);
		expect(size).toBeGreaterThanOrEqual(8);
		const lay = layoutText(text, { x: 0, y: 0, ...area }, { ...style, autoFit: true });
		expect(lay.overflow).toBe(false);
		expect(lay.fontSize).toBe(size);
		// passt schon → unverändert
		expect(fitFontSize('Hi', area, style)).toBe(40);
		expect(fitFontSize('x'.repeat(5000), { w: 50, h: 20 }, style)).toBe(8);
	});

	it('Höhe wächst mit den Zeilen; Monoschrift misst breiter', () => {
		const s = { fontSize: 20, align: 'left' as const, valign: 'top' as const };
		expect(textHeight('', 200, s)).toBe(25);
		expect(textHeight('a\nb\nc', 200, s)).toBe(75);
		const sans = approxMeasure('abc', 20, false, false, 'sans');
		expect(approxMeasure('abc', 20, false, false, 'mono')).toBeGreaterThan(sans);
	});

	it('neue Felder haben Standardwerte (ältere Elemente bleiben gültig)', () => {
		const old = parseElementData('shape', { kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'alt' });
		expect(old).toMatchObject({
			fontFamily: 'sans',
			underline: false,
			strike: false,
			autoFit: false,
			autoHeight: false
		});
		expect(
			parseElementData('shape', { kind: 'note', x: 0, y: 0, w: 10, h: 10, fontFamily: 'comic' })
		).toBeNull();
	});
});

describe('Freihand', () => {
	it('dünnt aus, bleibt unter MAX_POINTS und liefert Rahmen = natürliche Größe', () => {
		const pts: [number, number, number][] = Array.from({ length: MAX_POINTS * 3 }, (_, i) => [
			i / 10,
			Math.sin(i / 50) * 20,
			0.5
		]);
		const f = finalizeStroke(pts, 4);
		expect(f.points.length).toBeLessThanOrEqual(MAX_POINTS);
		expect(f.box.w).toBe(f.vw);
		expect(f.box.h).toBe(f.vh);
		expect(f.box.x).toBeCloseTo(-4, 5);
		expect(strokePath(f.points, { size: 4 })).toMatch(/^M.*Z$/);
		// einzelner Punkt → kleine geschlossene Fläche
		expect(strokePath([[5, 5, 0.5]], { size: 4 })).toMatch(/^M.*Z$/);
	});
});

describe('Ansicht', () => {
	it('Zoom am Punkt hält die Board-Stelle unter dem Zeiger', () => {
		const v = { panX: 30, panY: -20, zoom: 1 };
		const at = { x: 400, y: 300 };
		const w = toWorld(v, at);
		const z = zoomAt(v, at, 2.5);
		close(toScreen(z, w), at);
		expect(zoomAt(v, at, 99).zoom).toBe(4);
		expect(zoomAt(v, at, 0).zoom).toBe(0.1);
	});

	it('Einpassen und Zoomstufen', () => {
		const v = fitRect({ x: 0, y: 0, w: 1000, h: 500 }, { w: 1100, h: 600 }, { padding: 50 });
		expect(v.zoom).toBe(1);
		const small = fitRect({ x: 0, y: 0, w: 4000, h: 1000 }, { w: 1100, h: 600 }, { padding: 50 });
		expect(small.zoom).toBeCloseTo(0.25, 5);
		expect(stepZoom(1, 1)).toBe(1.25);
		expect(stepZoom(1, -1)).toBe(0.9);
		expect(stepZoom(4, 1)).toBe(4);
	});
});

describe('Schemas und Darstellung', () => {
	it('Links: nur http(s), mailto und interne Pfade', () => {
		for (const ok of [
			'https://example.org/a?b=1',
			'http://x.de',
			'mailto:a@b.de',
			'/modules/actions/1'
		]) {
			expect(isAllowedLink(ok), ok).toBe(true);
		}
		for (const bad of [
			'javascript:alert(1)',
			'data:text/html,x',
			'//evil.org',
			'/\\evil',
			'https://a b.de',
			'ftp://x',
			''
		]) {
			expect(isAllowedLink(bad), bad).toBe(false);
		}
		expect(
			linkData.safeParse({ x: 0, y: 0, w: 10, h: 10, url: 'javascript:alert(1)' }).success
		).toBe(false);
	});

	it('Elemente: Standardwerte, strikte Felder, Grenzen', () => {
		const s = parseElementData('shape', { kind: 'note', x: 0, y: 0, w: 10, h: 10 });
		expect(s).toMatchObject({
			fill: '#fff59d',
			fontSize: 18,
			align: 'center',
			rotation: 0,
			locked: false
		});
		expect(
			parseElementData('shape', { kind: 'note', x: 0, y: 0, w: 10, h: 10, onclick: 'x' })
		).toBeNull();
		expect(parseElementData('shape', { kind: 'note', x: 0, y: 0, w: 0, h: 10 })).toBeNull();
		expect(parseElementData('shape', { kind: 'note', x: 2e6, y: 0, w: 10, h: 10 })).toBeNull();
		expect(
			parseElementData('shape', { kind: 'note', x: 0, y: 0, w: 10, h: 10, fill: 'red' })
		).toBeNull();
		expect(
			parseElementData('ref', { x: 0, y: 0, w: 10, h: 10, refType: 'unbekannt', refId: '1' })
		).toBeNull();
	});

	it('feste Fläche: helle Farbe = helle Palette, dunkle Farbe = helle Tinte', () => {
		expect(fixedPalette('#ffffff')).toEqual(LIGHT);
		expect(fixedPalette('#fef3c7')).toMatchObject({
			dark: false,
			paper: '#fef3c7',
			ink: LIGHT.ink
		});
		const black = fixedPalette('#111827');
		expect(black.dark).toBe(true);
		expect(black.paper).toBe('#111827');
		expect(ink('#1f2937', black)).toBe(black.ink);
		expect(ink('#dc2626', black)).toBe('#dc2626');
		expect(ink('#1f2937', LIGHT)).toBe('#1f2937');
	});

	it('Kontrastfarbe, Dateiart, Host', () => {
		expect(textOn('#fff59d')).toBe('#1f2937');
		expect(textOn('#212121')).toBe('#ffffff');
		expect(textOn('transparent')).toBe('#1f2937');
		expect(fileKind('application/pdf')).toBe('pdf');
		expect(fileKind('application/octet-stream', 'liste.xlsx')).toBe('sheet');
		expect(hostOf('https://www.example.org/x')).toBe('example.org');
		expect(hostOf('/modules/x')).toBe('Intern');
	});
});
