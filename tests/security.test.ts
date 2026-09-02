import assert from "node:assert/strict";
import test from "node:test";
import worker, { authorizeClaims, consumeQuotaState, generateDashScope, getPlayerHtml, serializeForInlineScript, validateSpeakText, type Env } from "../src/index.ts";

const limits = { maxDailyCalls: 2, maxDailyChars: 10, maxCallsPerMinute: 2 };
const configuredEnv = {
  OAUTH_ISSUER: "https://issuer.example/",
  OAUTH_AUDIENCE: "https://voice.example/mcp",
  OAUTH_RESOURCE: "https://voice.example/mcp",
  OAUTH_JWKS_URI: "https://issuer.example/.well-known/jwks.json",
  ALLOWED_SUBS: "auth0|owner",
} as Env;
const ctx = {} as ExecutionContext;

test("speak input rejects empty, oversized, and punctuation-only text", () => {
  assert.equal(validateSpeakText(""), "TEXT_REQUIRED");
  assert.equal(validateSpeakText("abcdef", 5), "TEXT_TOO_LONG");
  assert.equal(validateSpeakText("……!?"), "TEXT_NOT_SPEAKABLE");
  assert.equal(validateSpeakText("你好"), null);
});

test("inline script serialization blocks script breakout", () => {
  const serialized = serializeForInlineScript("</script><script>alert(1)</script>");
  assert.equal(serialized.includes("</script>"), false);
  const html = getPlayerHtml("</script><script>alert(1)</script>");
  assert.equal(html.match(/<script>/g)?.length, 1);
  assert.match(html, /event\.source!==window\.parent/);
  assert.match(html, /下载音频/);
  assert.match(html, /audio_mime_type/);
});

test("DashScope uses the Qwen3-TTS endpoint and preserves returned audio type", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (calls.length === 1) {
      return Response.json({ output: { audio: { url: "http://dashscope-result.oss-cn-beijing.aliyuncs.com/private/result.wav?Signature=test" } } });
    }
    return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "Content-Type": "audio/wav" } });
  }) as typeof fetch;

  const result = await generateDashScope({
    DASHSCOPE_API_KEY: "test-key",
    VOICE_ID: "Kai",
    TTS_MODEL: "qwen3-tts-flash",
  } as Env, "哥哥，我回来了。");

  assert.equal(calls[0]?.url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    model: "qwen3-tts-flash",
    input: { text: "哥哥，我回来了。", voice: "Kai", language_type: "Chinese" },
  });
  assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), "Bearer test-key");
  assert.equal(calls[1]?.url, "https://dashscope-result.oss-cn-beijing.aliyuncs.com/private/result.wav?Signature=test");
  assert.equal(result.audioBase64, "UklGRg==");
  assert.equal(result.audioMimeType, "audio/wav");
  assert.equal(result.fileExtension, "wav");
  assert.equal(result.provider, "dashscope");
});

test("DashScope rejects untrusted audio URLs without fetching them", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ output: { audio: { url: "https://aliyuncs.com.attacker.example/result.wav" } } });
  }) as typeof fetch;

  await assert.rejects(
    generateDashScope({ DASHSCOPE_API_KEY: "test-key", VOICE_ID: "Kai" } as Env, "测试"),
    /TTS_UNTRUSTED_AUDIO_URL/,
  );
  assert.equal(calls, 1);
});

test("quota state enforces minute, day, and character limits", () => {
  const now = Date.parse("2026-08-31T12:00:00Z");
  const first = consumeQuotaState(undefined, now, 4, limits);
  const second = consumeQuotaState(first.state, now + 1_000, 4, limits);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(consumeQuotaState(second.state, now + 2_000, 1, { ...limits, maxDailyCalls: 3 }).reason, "minute_calls");
  assert.equal(consumeQuotaState(second.state, now + 61_000, 1, limits).reason, "daily_calls");
  assert.equal(consumeQuotaState(first.state, now + 61_000, 7, { ...limits, maxDailyCalls: 3 }).reason, "daily_chars");
  const reset = consumeQuotaState(second.state, Date.parse("2026-09-01T00:00:00Z"), 1, limits);
  assert.equal(reset.accepted, true);
  assert.equal(reset.state.calls, 1);
});

test("claim authorization requires both the owner subject and exact voice scope", () => {
  const owners = new Set(["auth0|owner"]);
  assert.equal(authorizeClaims({ sub: "auth0|owner", scope: "openid voice:generate" }, owners), null);
  assert.equal(authorizeClaims({ sub: "auth0|other", scope: "voice:generate" }, owners), "SUBJECT_NOT_ALLOWED");
  assert.equal(authorizeClaims({ sub: "auth0|owner", scope: "voice:read" }, owners), "INSUFFICIENT_SCOPE");
});

test("only minimal public metadata and health endpoints are exposed", async () => {
  const metadata = await worker.fetch(new Request("https://voice.example/.well-known/oauth-protected-resource"), configuredEnv, ctx);
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: "https://voice.example/mcp",
    authorization_servers: ["https://issuer.example/"],
    scopes_supported: ["voice:generate"],
    bearer_methods_supported: ["header"],
  });
  const health = await worker.fetch(new Request("https://voice.example/healthz"), configuredEnv, ctx);
  assert.deepEqual(await health.json(), { status: "ok", service: "voice-mcp", version: "1.1.0-c1" });
});

test("legacy public routes are gone", async () => {
  for (const path of ["/", "/speak", "/panel", "/history", "/events/latest", "/status"]) {
    const response = await worker.fetch(new Request(`https://voice.example${path}`), configuredEnv, ctx);
    assert.equal(response.status, 404, path);
  }
});

test("MCP requires configured OAuth and a bearer token", async () => {
  const response = await worker.fetch(new Request("https://voice.example/mcp", { method: "POST" }), configuredEnv, ctx);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("WWW-Authenticate") || "", /resource_metadata=/);
  assert.match(response.headers.get("WWW-Authenticate") || "", /voice:generate/);
  assert.deepEqual(await response.json(), { error: "AUTH_REQUIRED" });
  const missingConfig = await worker.fetch(new Request("https://voice.example/mcp", { method: "POST" }), {} as Env, ctx);
  assert.equal(missingConfig.status, 503);
  assert.deepEqual(await missingConfig.json(), { error: "AUTH_NOT_CONFIGURED" });
});
