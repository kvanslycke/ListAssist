import { requestUrl } from "obsidian";
import { OAuthConfig, OAuthTokens, refreshAccessToken } from "./oauth";

const API_BASE = "https://www.googleapis.com/calendar/v3";

export const EVENT_TAG = "[list-assistant]";
export const PROP_SOURCE = "listAssistantSource";
export const PROP_KIND = "listAssistantKind";
export const PROP_OWNED = "listAssistantOwned";

export type EventKind = "due-q1" | "due-q2-reminder" | "rapids-class";

export const KNOWN_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "due-q1",
  "due-q2-reminder",
  "rapids-class",
]);

export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface EventReminders {
  useDefault: boolean;
  overrides?: Array<{ method: "popup" | "email"; minutes: number }>;
}

export interface CalendarEventSpec {
  sourceKey: string;
  kind: EventKind;
  summary: string;
  description: string;
  start: EventDateTime;
  end: EventDateTime;
  // Google Calendar fixed color id ("1".."11"). Omit to leave the
  // event's color at the calendar default.
  colorId?: string;
  // Omit to leave reminders at whatever Google Calendar is currently
  // doing. Set `{useDefault: true}` to inherit the calendar's default
  // notification, or `{useDefault: false, overrides: []}` to silence
  // the event entirely.
  reminders?: EventReminders;
}

export interface OwnedEvent {
  id: string;
  sourceKey: string;
  kind: EventKind;
}

interface RawEvent {
  id: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
  summary?: string;
}

export class CalendarClient {
  private tokens: OAuthTokens;
  constructor(
    private oauth: OAuthConfig,
    tokens: OAuthTokens,
    private calendarId: string,
    private onTokenRefresh: (t: OAuthTokens) => Promise<void>,
  ) {
    this.tokens = tokens;
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() < this.tokens.expiresAt) return;
    const fresh = await refreshAccessToken(this.oauth, this.tokens.refreshToken);
    this.tokens = fresh;
    await this.onTokenRefresh(fresh);
  }

  private async apiFetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    await this.ensureFresh();
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const call = async (token: string) =>
      requestUrl({
        url: `${API_BASE}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        throw: false,
      });
    let resp = await call(this.tokens.accessToken);
    if (resp.status === 401) {
      const fresh = await refreshAccessToken(this.oauth, this.tokens.refreshToken);
      this.tokens = fresh;
      await this.onTokenRefresh(fresh);
      resp = await call(fresh.accessToken);
    }
    if (resp.status === 204) return null;
    if (resp.status >= 400) {
      throw new Error(`Calendar API ${method} ${path} failed: ${resp.status} ${resp.text}`);
    }
    return resp.json;
  }

  private encodeCalendarId(): string {
    return encodeURIComponent(this.calendarId);
  }

  async findExisting(sourceKey: string, kind: EventKind): Promise<RawEvent | null> {
    const params = new URLSearchParams({
      privateExtendedProperty: `${PROP_SOURCE}=${sourceKey}`,
      maxResults: "10",
      showDeleted: "false",
    });
    const data = (await this.apiFetch(
      `/calendars/${this.encodeCalendarId()}/events?${params}`,
    )) as { items?: RawEvent[] };
    const items = data.items ?? [];
    return (
      items.find((e) => e.extendedProperties?.private?.[PROP_KIND] === kind) ?? null
    );
  }

  async upsert(spec: CalendarEventSpec): Promise<{ id: string; created: boolean }> {
    const existing = await this.findExisting(spec.sourceKey, spec.kind);
    const body: Record<string, unknown> = {
      summary: spec.summary,
      description: spec.description,
      start: spec.start,
      end: spec.end,
      extendedProperties: {
        private: {
          [PROP_SOURCE]: spec.sourceKey,
          [PROP_KIND]: spec.kind,
          [PROP_OWNED]: "1",
        },
      },
    };
    if (spec.colorId) body.colorId = spec.colorId;
    if (spec.reminders) body.reminders = spec.reminders;
    if (existing) {
      const updated = (await this.apiFetch(
        `/calendars/${this.encodeCalendarId()}/events/${existing.id}`,
        { method: "PATCH", body },
      )) as RawEvent;
      return { id: updated.id, created: false };
    }
    const created = (await this.apiFetch(
      `/calendars/${this.encodeCalendarId()}/events`,
      { method: "POST", body },
    )) as RawEvent;
    return { id: created.id, created: true };
  }

  async deleteById(id: string): Promise<void> {
    await this.apiFetch(`/calendars/${this.encodeCalendarId()}/events/${id}`, {
      method: "DELETE",
    });
  }

  // All events on this calendar carrying the plugin's ownership tag.
  // Pages through results; skips any owned event whose kind is not in
  // KNOWN_EVENT_KINDS so an older plugin version's events are left alone.
  async listOwned(): Promise<OwnedEvent[]> {
    const out: OwnedEvent[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        privateExtendedProperty: `${PROP_OWNED}=1`,
        maxResults: "250",
        showDeleted: "false",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = (await this.apiFetch(
        `/calendars/${this.encodeCalendarId()}/events?${params}`,
      )) as { items?: RawEvent[]; nextPageToken?: string };
      const items = data.items ?? [];
      for (const e of items) {
        const priv = e.extendedProperties?.private;
        if (!priv) continue;
        const sourceKey = priv[PROP_SOURCE];
        const kind = priv[PROP_KIND] as EventKind | undefined;
        if (!sourceKey || !kind) continue;
        if (!KNOWN_EVENT_KINDS.has(kind)) continue;
        out.push({ id: e.id, sourceKey, kind });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async whoAmI(): Promise<string> {
    const data = (await this.apiFetch(`/calendars/${this.encodeCalendarId()}`)) as {
      summary?: string;
      id?: string;
    };
    return data.summary || data.id || this.calendarId;
  }

  // Scope-compatible auth probe. events.list is covered by
  // `calendar.events`, unlike GET /calendars/{id} which needs the full
  // calendar scope. Returns on success, throws on auth/scope failure.
  async probeAuth(): Promise<void> {
    await this.apiFetch(
      `/calendars/${this.encodeCalendarId()}/events?maxResults=1&showDeleted=false`,
    );
  }
}
