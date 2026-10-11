// Mocked-fetch tests for the Ollama client. Verifies health check,
// chat happy path, invalid-then-valid retry, and twice-invalid throw.

import { test } from "node:test";
import assert from "node:assert/strict";

const { healthCheck, chat, DEFAULT_CONFIG, InvalidChatJsonError } = await import(
  "../.test-build/smart/ollamaClient.js"
);

function fakeResponse(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(sequence) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    if (i >= sequence.length) throw new Error(`unexpected extra fetch call ${i}`);
    const step = sequence[i++];
    if (typeof step === "function") return step(url, init);
    return step;
  };
  return { impl, calls, cursor: () => i };
}

test("healthCheck returns models and modelPresent=true when listed", async () => {
  const { impl } = mockFetch([
    fakeResponse(200, { models: [{ name: "gemma4:e4b" }, { name: "llama3:8b" }] }),
  ]);
  const h = await healthCheck({ ...DEFAULT_CONFIG, fetchImpl: impl });
  assert.equal(h.ok, true);
  assert.deepEqual(h.models, ["gemma4:e4b", "llama3:8b"]);
  assert.equal(h.modelPresent, true);
});

test("healthCheck flags missing model", async () => {
  const { impl } = mockFetch([fakeResponse(200, { models: [{ name: "llama3:8b" }] })]);
  const h = await healthCheck({ ...DEFAULT_CONFIG, fetchImpl: impl });
  assert.equal(h.ok, true);
  assert.equal(h.modelPresent, false);
});

test("healthCheck surfaces non-200 as error", async () => {
  const { impl } = mockFetch([fakeResponse(500, "oops")]);
  const h = await healthCheck({ ...DEFAULT_CONFIG, fetchImpl: impl });
  assert.equal(h.ok, false);
  assert.match(h.error, /500/);
});

test("healthCheck surfaces network errors", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  const h = await healthCheck({ ...DEFAULT_CONFIG, fetchImpl: impl });
  assert.equal(h.ok, false);
  assert.equal(h.modelPresent, false);
  assert.match(h.error, /fetch failed/);
});

test("chat returns parsed JSON on first try", async () => {
  const { impl, calls } = mockFetch([
    fakeResponse(200, { message: { content: '{"name":"foo","value":42}' } }),
  ]);
  const r = await chat(
    { ...DEFAULT_CONFIG, fetchImpl: impl },
    { messages: [{ role: "user", content: "hi" }], format: { type: "object" } },
  );
  assert.equal(r.retried, false);
  assert.deepEqual(r.parsed, { name: "foo", value: 42 });
  // Verify request shape
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, "gemma4:e4b");
  assert.equal(body.stream, false);
  assert.equal(body.keep_alive, "15m");
  assert.equal(body.options.temperature, 0.2);
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.options.think, false);
  assert.deepEqual(body.format, { type: "object" });
});

test("chat retries once on invalid JSON and succeeds", async () => {
  const { impl, cursor } = mockFetch([
    fakeResponse(200, { message: { content: "not{json" } }),
    fakeResponse(200, { message: { content: '{"ok":true}' } }),
  ]);
  const r = await chat(
    { ...DEFAULT_CONFIG, fetchImpl: impl },
    { messages: [{ role: "user", content: "hi" }], format: { type: "object" } },
  );
  assert.equal(r.retried, true);
  assert.deepEqual(r.parsed, { ok: true });
  assert.equal(cursor(), 2);
});

test("chat throws InvalidChatJsonError when retry also fails", async () => {
  const { impl } = mockFetch([
    fakeResponse(200, { message: { content: "garbage" } }),
    fakeResponse(200, { message: { content: "still garbage" } }),
  ]);
  await assert.rejects(
    () =>
      chat(
        { ...DEFAULT_CONFIG, fetchImpl: impl },
        { messages: [{ role: "user", content: "hi" }], format: { type: "object" } },
      ),
    (e) => e instanceof InvalidChatJsonError,
  );
});

test("chat surfaces non-200 as an error", async () => {
  const { impl } = mockFetch([fakeResponse(502, "bad gateway"), fakeResponse(502, "bad gateway")]);
  await assert.rejects(
    () =>
      chat(
        { ...DEFAULT_CONFIG, fetchImpl: impl },
        { messages: [{ role: "user", content: "hi" }], format: { type: "object" } },
      ),
    /502/,
  );
});
