/** Calendar service — tools for Google Calendar access with calendar ID filtering. */

import { google } from "googleapis";
import type { PermissionConfig, ToolDef } from "../types.js";
import { hasAccess } from "../types.js";
import { getAllowedFolders } from "../permissions.js";

type AuthClient = InstanceType<typeof google.auth.OAuth2>;

interface CalendarEvent {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  start?: string | null;
  end?: string | null;
  attendees?: string[];
  location?: string | null;
  htmlLink?: string | null;
}

function normalizeEvent(event: Record<string, any>): CalendarEvent {
  return {
    id: event.id ?? null,
    summary: event.summary ?? null,
    description: event.description ?? null,
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    attendees: (event.attendees ?? []).map((a: any) => a.email).filter(Boolean),
    location: event.location ?? null,
    htmlLink: event.htmlLink ?? null,
  };
}

/**
 * Returns an array of ToolDef objects for Google Calendar, filtered by access level.
 * The `folders` field in the permission config represents allowed calendar IDs.
 */
export function getCalendarTools(
  config: PermissionConfig,
  auth: AuthClient,
): ToolDef[] {
  const calendarAccess = config.permissions.calendar?.access ?? "none";

  if (calendarAccess === "none") return [];

  const cal = google.calendar({ version: "v3", auth });
  // For calendar, "folders" in config = allowed calendar IDs
  const allowedCalendars = getAllowedFolders(config, "calendar");

  const tools: ToolDef[] = [];

  // ── Read tools ──────────────────────────────────────────────────────────

  tools.push({
    name: "calendar_list_events",
    description: "List events in a calendar within a time range.",
    service: "calendar",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: {
          type: "string",
          description: "Calendar ID to list events from. Defaults to first allowed calendar or 'primary'.",
        },
        timeMin: {
          type: "string",
          description: "Lower bound (RFC3339) for event start time. Defaults to now.",
        },
        timeMax: {
          type: "string",
          description: "Upper bound (RFC3339) for event start time. Defaults to 14 days from now.",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of events to return (default 50).",
        },
      },
    },
    handler: async (args) => {
      const now = new Date();
      const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

      // Determine effective calendarId
      const requestedId = args.calendarId as string | undefined;
      let calendarId: string;

      if (requestedId) {
        // Validate against allowed list
        if (allowedCalendars.length > 0 && !allowedCalendars.includes(requestedId)) {
          throw new Error(`Calendar ${requestedId} is not in allowed calendars`);
        }
        calendarId = requestedId;
      } else {
        calendarId = allowedCalendars.length > 0 ? allowedCalendars[0] : "primary";
      }

      const timeMin = (args.timeMin as string | undefined) ?? now.toISOString();
      const timeMax = (args.timeMax as string | undefined) ?? twoWeeks.toISOString();
      const maxResults = (args.maxResults as number | undefined) ?? 50;

      const res = await cal.events.list({
        calendarId,
        timeMin,
        timeMax,
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = (res.data.items ?? []).map(normalizeEvent);
      return { events, calendarId };
    },
  });

  tools.push({
    name: "calendar_get_event",
    description: "Get details of a specific calendar event by ID.",
    service: "calendar",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      required: ["eventId"],
      properties: {
        eventId: {
          type: "string",
          description: "The ID of the event to retrieve.",
        },
        calendarId: {
          type: "string",
          description: "Calendar ID the event belongs to. Defaults to first allowed calendar or 'primary'.",
        },
      },
    },
    handler: async (args) => {
      const eventId = args.eventId as string;
      const requestedId = args.calendarId as string | undefined;

      let calendarId: string;
      if (requestedId) {
        if (allowedCalendars.length > 0 && !allowedCalendars.includes(requestedId)) {
          throw new Error(`Calendar ${requestedId} is not in allowed calendars`);
        }
        calendarId = requestedId;
      } else {
        calendarId = allowedCalendars.length > 0 ? allowedCalendars[0] : "primary";
      }

      const res = await cal.events.get({ calendarId, eventId });
      return normalizeEvent(res.data as Record<string, any>);
    },
  });

  tools.push({
    name: "calendar_list_calendars",
    description: "List available calendars. Filtered to allowed calendar IDs if restricted.",
    service: "calendar",
    requiredAccess: "read",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (_args) => {
      const res = await cal.calendarList.list({});
      let calendars = res.data.items ?? [];

      if (allowedCalendars.length > 0) {
        calendars = calendars.filter((c) => allowedCalendars.includes(c.id ?? ""));
        // A service account's list stays empty until something adds to it, so
        // look up any allowed calendar it doesn't show.
        const listed = new Set(calendars.map((c) => c.id));
        for (const calendarId of allowedCalendars.filter((id) => !listed.has(id))) {
          try {
            const found = await cal.calendars.get({ calendarId });
            calendars.push({ id: found.data.id, summary: found.data.summary, description: found.data.description });
          } catch {
            // Not shared with this identity, so it isn't available.
          }
        }
      }

      return {
        calendars: calendars.map((c) => ({
          id: c.id,
          summary: c.summary,
          description: c.description,
          primary: c.primary,
          accessRole: c.accessRole,
        })),
      };
    },
  });

  // ── Write tools ─────────────────────────────────────────────────────────

  if (hasAccess(calendarAccess, "write")) {
    tools.push({
      name: "calendar_create_event",
      description: "Create a new calendar event.",
      service: "calendar",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["summary", "start", "end"],
        properties: {
          summary: {
            type: "string",
            description: "Title of the event.",
          },
          start: {
            type: "string",
            description: "Start datetime (RFC3339) or date (YYYY-MM-DD).",
          },
          end: {
            type: "string",
            description: "End datetime (RFC3339) or date (YYYY-MM-DD).",
          },
          description: {
            type: "string",
            description: "Event description.",
          },
          calendarId: {
            type: "string",
            description: "Calendar ID to create the event in. Defaults to first allowed calendar or 'primary'.",
          },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Array of attendee email addresses.",
          },
          location: {
            type: "string",
            description: "Location of the event.",
          },
        },
      },
      handler: async (args) => {
        const requestedId = args.calendarId as string | undefined;
        let calendarId: string;

        if (requestedId) {
          if (allowedCalendars.length > 0 && !allowedCalendars.includes(requestedId)) {
            throw new Error(`Calendar ${requestedId} is not in allowed calendars`);
          }
          calendarId = requestedId;
        } else {
          calendarId = allowedCalendars.length > 0 ? allowedCalendars[0] : "primary";
        }

        const summary = args.summary as string;
        const startStr = args.start as string;
        const endStr = args.end as string;

        // Detect date-only vs datetime
        const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
        const startField = isDateOnly(startStr) ? { date: startStr } : { dateTime: startStr };
        const endField = isDateOnly(endStr) ? { date: endStr } : { dateTime: endStr };

        const requestBody: Record<string, any> = {
          summary,
          start: startField,
          end: endField,
        };

        if (args.description) requestBody.description = args.description;
        if (args.location) requestBody.location = args.location;
        if (args.attendees) {
          requestBody.attendees = (args.attendees as string[]).map((email) => ({ email }));
        }

        const res = await cal.events.insert({ calendarId, requestBody });
        return normalizeEvent(res.data as Record<string, any>);
      },
    });

    tools.push({
      name: "calendar_update_event",
      description: "Update fields of an existing calendar event.",
      service: "calendar",
      requiredAccess: "write",
      inputSchema: {
        type: "object",
        required: ["eventId"],
        properties: {
          eventId: {
            type: "string",
            description: "ID of the event to update.",
          },
          calendarId: {
            type: "string",
            description: "Calendar ID the event belongs to. Defaults to first allowed calendar or 'primary'.",
          },
          summary: {
            type: "string",
            description: "New title for the event.",
          },
          description: {
            type: "string",
            description: "New description.",
          },
          start: {
            type: "string",
            description: "New start datetime (RFC3339) or date (YYYY-MM-DD).",
          },
          end: {
            type: "string",
            description: "New end datetime (RFC3339) or date (YYYY-MM-DD).",
          },
          location: {
            type: "string",
            description: "New location.",
          },
        },
      },
      handler: async (args) => {
        const eventId = args.eventId as string;
        const requestedId = args.calendarId as string | undefined;
        let calendarId: string;

        if (requestedId) {
          if (allowedCalendars.length > 0 && !allowedCalendars.includes(requestedId)) {
            throw new Error(`Calendar ${requestedId} is not in allowed calendars`);
          }
          calendarId = requestedId;
        } else {
          calendarId = allowedCalendars.length > 0 ? allowedCalendars[0] : "primary";
        }

        const requestBody: Record<string, any> = {};

        if (args.summary !== undefined) requestBody.summary = args.summary;
        if (args.description !== undefined) requestBody.description = args.description;
        if (args.location !== undefined) requestBody.location = args.location;

        if (args.start !== undefined) {
          const s = args.start as string;
          requestBody.start = /^\d{4}-\d{2}-\d{2}$/.test(s) ? { date: s } : { dateTime: s };
        }
        if (args.end !== undefined) {
          const e = args.end as string;
          requestBody.end = /^\d{4}-\d{2}-\d{2}$/.test(e) ? { date: e } : { dateTime: e };
        }

        const res = await cal.events.update({ calendarId, eventId, requestBody });
        return normalizeEvent(res.data as Record<string, any>);
      },
    });
  }

  // ── Admin tools ──────────────────────────────────────────────────────────

  if (hasAccess(calendarAccess, "admin")) {
    tools.push({
      name: "calendar_delete_event",
      description: "Delete a calendar event permanently.",
      service: "calendar",
      requiredAccess: "admin",
      inputSchema: {
        type: "object",
        required: ["eventId"],
        properties: {
          eventId: {
            type: "string",
            description: "ID of the event to delete.",
          },
          calendarId: {
            type: "string",
            description: "Calendar ID the event belongs to. Defaults to first allowed calendar or 'primary'.",
          },
        },
      },
      handler: async (args) => {
        const eventId = args.eventId as string;
        const requestedId = args.calendarId as string | undefined;
        let calendarId: string;

        if (requestedId) {
          if (allowedCalendars.length > 0 && !allowedCalendars.includes(requestedId)) {
            throw new Error(`Calendar ${requestedId} is not in allowed calendars`);
          }
          calendarId = requestedId;
        } else {
          calendarId = allowedCalendars.length > 0 ? allowedCalendars[0] : "primary";
        }

        await cal.events.delete({ calendarId, eventId });
        return { success: true, eventId, calendarId };
      },
    });
  }

  return tools;
}
