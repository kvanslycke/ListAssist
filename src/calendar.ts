import { requestUrl } from "obsidian";
import { OAuthConfig, OAuthTokens, refreshAccessToken } from "./oauth";

const API_BASE = "https://www.googleapis.com/calendar/v3";

export const EVENT_TAG = "[list-assistant]";
export const PROP_SOURCE = "listAssistantSource";
export const PROP_KIND = "listAssistantKind";
export const PROP_OWNED = "listAssistantOwned";

export type EventKind = "due-q1" | "due-q2-reminder" | "rapids-class";

export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarEventSpec {
  sourceKey: string;
  kind: EventKind;
  summary: string;
  description: string;
  start: EventDateTime;
  end: EventDateTime;
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
    const body = {
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

  async whoAmI(): Promise<string> {
    const data = (await this.apiFetch(`/calendars/${this.encodeCalendarId()}`)) as {
      summary?: string;
      id?: string;
    };
    return data.summary || data.id || this.calendarId;
  }
}
