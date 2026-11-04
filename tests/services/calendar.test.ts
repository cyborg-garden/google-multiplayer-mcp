import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PermissionConfig } from "../../src/types.js";

vi.mock("googleapis", () => {
  const listEventsFn = vi.fn();
  const getEventFn = vi.fn();
  const listCalendarsFn = vi.fn();
  const insertEventFn = vi.fn();
  const updateEventFn = vi.fn();
  const deleteEventFn = vi.fn();
  const getCalendarFn = vi.fn();

  return {
    google: {
      calendar: () => ({
        events: {
          list: listEventsFn,
          get: getEventFn,
          insert: insertEventFn,
          update: updateEventFn,
          delete: deleteEventFn,
        },
        calendarList: { list: listCalendarsFn },
        calendars: { get: getCalendarFn },
      }),
    },
    _mocks: { getCalendarFn, listEventsFn, getEventFn, listCalendarsFn, insertEventFn, updateEventFn, deleteEventFn },
  };
});

const { _mocks } = await import("googleapis") as any;
const { getCalendarTools } = await import("../../src/services/calendar.js");

const readConfig: PermissionConfig = {
  identity: "test",
  permissions: { calendar: { access: "read", folders: ["cal-work"] } },
};

const writeConfig: PermissionConfig = {
  identity: "test",
  permissions: { calendar: { access: "write", folders: [] } },
};

describe("getCalendarTools", () => {
  it("returns read tools for read access", () => {
    const tools = getCalendarTools(readConfig, {} as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain("calendar_list_events");
    expect(names).toContain("calendar_get_event");
    expect(names).toContain("calendar_list_calendars");
    expect(names).not.toContain("calendar_create_event");
    expect(names).not.toContain("calendar_delete_event");
  });

  it("returns write tools for write access", () => {
    const tools = getCalendarTools(writeConfig, {} as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain("calendar_create_event");
    expect(names).toContain("calendar_update_event");
    expect(names).not.toContain("calendar_delete_event");
  });
});

describe("calendar_list_events handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses allowed calendar IDs when restricted", async () => {
    _mocks.listEventsFn.mockResolvedValue({
      data: {
        items: [
          { id: "ev1", summary: "Meeting", start: { dateTime: "2026-05-16T10:00:00Z" }, end: { dateTime: "2026-05-16T11:00:00Z" } },
        ],
      },
    });

    const tools = getCalendarTools(readConfig, {} as any);
    const listTool = tools.find((t) => t.name === "calendar_list_events")!;
    await listTool.handler({});

    expect(_mocks.listEventsFn).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "cal-work" }),
    );
  });
});

describe("calendar_list_calendars for an identity with an empty list", () => {
  const config: PermissionConfig = {
    identity: "t",
    permissions: { calendar: { access: "read", folders: ["cal-a", "cal-b"] } },
  };
  it("finds a shared calendar, and leaves out one it can't reach", async () => {
    _mocks.listCalendarsFn.mockResolvedValueOnce({ data: { items: [] } });
    _mocks.getCalendarFn.mockImplementation(async ({ calendarId }: { calendarId: string }) => {
      if (calendarId === "cal-a") return { data: { id: "cal-a", summary: "A" } };
      throw new Error("Not Found");
    });
    const tool = getCalendarTools(config, {} as any).find((t: any) => t.name === "calendar_list_calendars");
    const res = await tool.handler({});
    expect(res.calendars.map((c: any) => c.id)).toEqual(["cal-a"]);
  });
});
