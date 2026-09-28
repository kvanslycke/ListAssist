import { Notice, Platform, requestUrl } from "obsidian";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomToken(len = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(len)));
}

export async function beginOAuthFlow(config: OAuthConfig): Promise<OAuthTokens> {
  if (Platform.isMobile) {
    throw new Error(
      "Google Calendar connection must be initiated from a desktop device. Once connected, sync works on all devices.",
    );
  }
  const redirectUri = `http://127.0.0.1:${config.redirectPort}/callback`;
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await sha256Base64Url(verifier);

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const codePromise = waitForCode(config.redirectPort, state);
  window.open(authUrl.toString(), "_blank");
  new Notice("Complete Google Calendar authorization in the browser tab.");
  const code = await codePromise;
  return exchangeCode(config, code, verifier, redirectUri);
}

function waitForCode(port: number, expectedState: string): Promise<string> {
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (!req) throw new Error("Node HTTP module unavailable (desktop only).");
  const http = req("http") as {
    createServer: (
      handler: (req: { url?: string }, res: {
        writeHead: (code: number, headers?: Record<string, string>) => void;
        end: (body?: string) => void;
      }) => void,
    ) => {
      listen: (port: number, host: string) => void;
      close: () => void;
      on: (ev: string, cb: (e: unknown) => void) => void;
    };
  };
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      const ok = !err && !!code && state === expectedState;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family:system-ui;padding:40px"><h2>${
          ok ? "Authorization complete" : "Authorization failed"
        }</h2><p>You can close this tab and return to Obsidian.</p></body></html>`,
      );
      try {
        server.close();
      } catch {
        /* noop */
      }
      if (err) return reject(new Error(`OAuth error: ${err}`));
      if (!code) return reject(new Error("No authorization code returned."));
      if (state !== expectedState) return reject(new Error("OAuth state mismatch."));
      resolve(code);
    });
    server.on("error", (e) => reject(e));
    try {
      server.listen(port, "127.0.0.1");
    } catch (e) {
      reject(e);
      return;
    }
    setTimeout(() => {
      try {
        server.close();
      } catch {
        /* noop */
      }
      reject(new Error("OAuth timed out after 5 minutes."));
    }, 5 * 60 * 1000);
  });
}

async function exchangeCode(
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    code,
    code_verifier: verifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const resp = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: body.toString(),
    throw: false,
  });
  if (resp.status !== 200) {
    throw new Error(`Token exchange failed: ${resp.status} ${resp.text}`);
  }
  const data = resp.json as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  if (!data.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Ensure your OAuth client is Desktop type and revoke prior grants at https://myaccount.google.com/permissions before retrying.",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });
  const resp = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: body.toString(),
    throw: false,
  });
  if (resp.status !== 200) {
    throw new Error(`Token refresh failed: ${resp.status} ${resp.text}`);
  }
  const data = resp.json as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}
