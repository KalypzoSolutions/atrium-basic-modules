/**
 * Kalender-Abos (iCal): eigene Abos verwalten (`events.event.view`) und der öffentliche Abruf durch
 * Kalender-Apps über den geheimen Link (`public: true`, Rate-Limit). Feste Pfade vor `:id`.
 */
import { type AnyApiEndpoint, defineEndpoint } from '$lib/sdk/server';
import {
	createFeed,
	deleteFeed,
	listFeeds,
	renderFeed,
	rotateFeed,
	updateFeed
} from './calendar-feeds.service';
import { calendarFeedInput, feedTokenParams, idParams } from './schemas';

const tags = ['Modul: events'];
const PERMISSION = 'events.event.view';
const WRITE_LIMIT = { limit: 30, windowSec: 60 };

export const calendarEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/public/calendar/:token',
		summary:
			'Kalender-Abo als iCal (`text/calendar`) für Kalender-Apps – Zugang über den geheimen Link',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 120, windowSec: 60 },
		params: feedTokenParams,
		handler: ({ params }) => renderFeed(params.token)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/calendar-feeds',
		summary: 'Eigene Kalender-Abos mit Abo-Adresse',
		tags,
		permission: PERMISSION,
		handler: ({ ctx }) => listFeeds(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/calendar-feeds',
		summary: 'Kalender-Abo anlegen (Name, Termine/Aktionen, Filter nach Gruppen und Tags)',
		tags,
		permission: PERMISSION,
		rateLimit: WRITE_LIMIT,
		body: calendarFeedInput,
		handler: ({ ctx, body }) => createFeed(ctx, body)
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/calendar-feeds/:id',
		summary: 'Kalender-Abo ändern (der Link bleibt gleich)',
		tags,
		permission: PERMISSION,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		body: calendarFeedInput,
		handler: ({ ctx, params, body }) => updateFeed(ctx, params.id, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/calendar-feeds/:id/rotate',
		summary: 'Neuen Link erzeugen – der alte gilt sofort nicht mehr',
		tags,
		permission: PERMISSION,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		handler: ({ ctx, params }) => rotateFeed(ctx, params.id)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/calendar-feeds/:id',
		summary: 'Kalender-Abo löschen (Link wird ungültig)',
		tags,
		permission: PERMISSION,
		rateLimit: WRITE_LIMIT,
		params: idParams,
		handler: ({ ctx, params }) => deleteFeed(ctx, params.id)
	})
];
