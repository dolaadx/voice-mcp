import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

const VOICE_RESOURCE_URI = "ui://voice-mcp/player.html";
const VOICE_SCOPE = "voice:generate";
const STYLE_VALUES = ["soft", "teasing", "excited", "tired", "laughing", "curious"] as const;
const DEFAULT_LIMITS = {
  maxVisibleChars: 500,
  maxAudioBytes: 4 * 1024 * 1024,
  maxDailyCalls: 30,
  maxDailyChars: 10_000,
  maxCallsPerMinute: 3,
  ttsTimeoutMs: 20_000,
};

export interface Env {
  VOICE_QUOTA: DurableObjectNamespace;
  OAUTH_ISSUER?: string;
  OAUTH_AUDIENCE?: string;
  OAUTH_RESOURCE?: string;
  OAUTH_JWKS_URI?: string;
  ALLOWED_SUBS?: string;
  TTS_PROVIDER?: "dashscope" | "elevenlabs";
  DASHSCOPE_API_KEY?: string;
  VOICE_ID?: string;
  TTS_MODEL?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_MODEL_ID?: string;
  ELEVENLABS_OUTPUT_FORMAT?: string;
  BOT_NAME?: string;
  MAX_VISIBLE_CHARS?: string;
  MAX_AUDIO_BYTES?: string;
  MAX_DAILY_CALLS?: string;
  MAX_DAILY_CHARS?: string;
  MAX_CALLS_PER_MINUTE?: string;
  TTS_TIMEOUT_MS?: string;
}

export interface QuotaState {
  day: string;
  calls: number;
  chars: number;
  recentStarts: number[];
}

export interface QuotaDecision {
  accepted: boolean;
  state: QuotaState;
  reason?: "daily_calls" | "daily_chars" | "minute_calls";
  retryAfterSeconds?: number;
}

interface Limits {
  maxVisibleChars: number;
  maxAudioBytes: number;
  maxDailyCalls: number;
  maxDailyChars: number;
  maxCallsPerMinute: number;
  ttsTimeoutMs: number;
}

interface AuthContext {
  subject: string;
  claims: JWTPayload;
}

interface AudioResult {
  audioBase64: string;
  provider: "dashscope" | "elevenlabs";
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getLimits(env: Partial<Env>): Limits {
  return {
    maxVisibleChars: positiveInt(env.MAX_VISIBLE_CHARS, DEFAULT_LIMITS.maxVisibleChars),
    maxAudioBytes: positiveInt(env.MAX_AUDIO_BYTES, DEFAULT_LIMITS.maxAudioBytes),
    maxDailyCalls: positiveInt(env.MAX_DAILY_CALLS, DEFAULT_LIMITS.maxDailyCalls),
    maxDailyChars: positiveInt(env.MAX_DAILY_CHARS, DEFAULT_LIMITS.maxDailyChars),
    maxCallsPerMinute: positiveInt(env.MAX_CALLS_PER_MINUTE, DEFAULT_LIMITS.maxCallsPerMinute),
    ttsTimeoutMs: positiveInt(env.TTS_TIMEOUT_MS, DEFAULT_LIMITS.ttsTimeoutMs),
  };
}

export function validateSpeakText(text: string, maxChars = DEFAULT_LIMITS.maxVisibleChars): string | null {
  const normalized = text.trim();
  if (!normalized) return "TEXT_REQUIRED";
  if ([...normalized].length > maxChars) return "TEXT_TOO_LONG";
  if (!/[\p{L}\p{N}]/u.test(normalized)) return "TEXT_NOT_SPEAKABLE";
  return null;
}

export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function consumeQuotaState(
  previous: QuotaState | undefined,
  nowMs: number,
  charCount: number,
  limits: Pick<Limits, "maxDailyCalls" | "maxDailyChars" | "maxCallsPerMinute">,
): QuotaDecision {
  const day = utcDay(nowMs);
  const base = previous?.day === day
    ? previous
    : { day, calls: 0, chars: 0, recentStarts: [] };
  const recentStarts = base.recentStarts.filter((start) => start > nowMs - 60_000);
  const state = { ...base, recentStarts };
  if (state.calls >= limits.maxDailyCalls) return { accepted: false, state, reason: "daily_calls" };
  if (state.chars + charCount > limits.maxDailyChars) return { accepted: false, state, reason: "daily_chars" };
  if (recentStarts.length >= limits.maxCallsPerMinute) {
    const retryAfterSeconds = Math.max(1, Math.ceil((recentStarts[0] + 60_000 - nowMs) / 1000));
    return { accepted: false, state, reason: "minute_calls", retryAfterSeconds };
  }
  return {
    accepted: true,
    state: {
      ...state,
      calls: state.calls + 1,
      chars: state.chars + charCount,
      recentStarts: [...recentStarts, nowMs],
    },
  };
}

export class VoiceQuota {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/consume") return new Response("Not Found", { status: 404 });
    let body: { chars?: unknown };
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    if (!Number.isSafeInteger(body.chars) || (body.chars as number) < 1) {
      return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const limits = getLimits(this.env);
    const decision = await this.state.storage.transaction(async (txn) => {
      const previous = await txn.get<QuotaState>("quota");
      const next = consumeQuotaState(previous, Date.now(), body.chars as number, limits);
      if (next.accepted) await txn.put("quota", next.state);
      return next;
    });
    return Response.json(decision, {
      status: decision.accepted ? 200 : 429,
      headers: decision.retryAfterSeconds ? { "Retry-After": String(decision.retryAfterSeconds) } : undefined,
    });
  }
}

function bearerChallenge(request: Request, env: Partial<Env>, error?: string): Headers {
  const resource = env.OAUTH_RESOURCE || `${new URL(request.url).origin}/mcp`;
  const metadata = `${new URL(resource).origin}/.well-known/oauth-protected-resource`;
  const details = error ? `, error="${error}"` : "";
  return new Headers({
    "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="${VOICE_SCOPE}"${details}`,
    "Cache-Control": "no-store",
  });
}

function authConfiguration(env: Env): { issuer: string; audience: string; resource: string; jwksUri: string; allowedSubs: Set<string> } | null {
  if (!env.OAUTH_ISSUER || !env.OAUTH_AUDIENCE || !env.OAUTH_RESOURCE || !env.OAUTH_JWKS_URI || !env.ALLOWED_SUBS) return null;
  const allowedSubs = new Set(env.ALLOWED_SUBS.split(",").map((value) => value.trim()).filter(Boolean));
  if (!allowedSubs.size) return null;
  try {
    const issuer = new URL(env.OAUTH_ISSUER);
    const resource = new URL(env.OAUTH_RESOURCE);
    const jwks = new URL(env.OAUTH_JWKS_URI);
    if (issuer.protocol !== "https:" || resource.protocol !== "https:" || jwks.protocol !== "https:") return null;
    return { issuer: env.OAUTH_ISSUER, audience: env.OAUTH_AUDIENCE, resource: env.OAUTH_RESOURCE, jwksUri: env.OAUTH_JWKS_URI, allowedSubs };
  } catch {
    return null;
  }
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function authorizeClaims(payload: JWTPayload, allowedSubs: Set<string>): "SUBJECT_NOT_ALLOWED" | "INSUFFICIENT_SCOPE" | null {
  if (!payload.sub || !allowedSubs.has(payload.sub)) return "SUBJECT_NOT_ALLOWED";
  const scopes = new Set(typeof payload.scope === "string" ? payload.scope.split(/\s+/) : []);
  return scopes.has(VOICE_SCOPE) ? null : "INSUFFICIENT_SCOPE";
}

async function authenticate(request: Request, env: Env): Promise<AuthContext | Response> {
  const config = authConfiguration(env);
  if (!config) {
    return Response.json({ error: "AUTH_NOT_CONFIGURED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return Response.json({ error: "AUTH_REQUIRED" }, { status: 401, headers: bearerChallenge(request, env) });
  try {
    let jwks = jwksCache.get(config.jwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 5_000 });
      jwksCache.set(config.jwksUri, jwks);
    }
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ["sub", "exp", "iat"],
    });
    const authorizationError = authorizeClaims(payload, config.allowedSubs);
    if (authorizationError === "SUBJECT_NOT_ALLOWED") {
      return Response.json({ error: "SUBJECT_NOT_ALLOWED" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (authorizationError === "INSUFFICIENT_SCOPE") {
      return Response.json({ error: "INSUFFICIENT_SCOPE" }, { status: 403, headers: bearerChallenge(request, env, "insufficient_scope") });
    }
    return { subject: payload.sub as string, claims: payload };
  } catch {
    return Response.json({ error: "INVALID_TOKEN" }, { status: 401, headers: bearerChallenge(request, env, "invalid_token") });
  }
}

async function subjectHash(subject: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return [...new Uint8Array(bytes)].slice(0, 8).map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function consumeQuota(env: Env, subject: string, chars: number): Promise<QuotaDecision> {
  const id = env.VOICE_QUOTA.idFromName(await subjectHash(subject));
  const response = await env.VOICE_QUOTA.get(id).fetch("https://quota.internal/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chars }),
  });
  return response.json<QuotaDecision>();
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function stylePrefix(style: typeof STYLE_VALUES[number] | undefined): string {
  if (!style) return "";
  const mapping: Record<typeof STYLE_VALUES[number], string> = {
    soft: "[softly] ", teasing: "[teasing] ", excited: "[excited] ",
    tired: "[tired] ", laughing: "[laughing] ", curious: "[curious] ",
  };
  return mapping[style];
}

async function generateDashScope(env: Env, text: string): Promise<AudioResult> {
  if (!env.DASHSCOPE_API_KEY || !env.VOICE_ID) throw new Error("TTS_NOT_CONFIGURED");
  const response = await fetch("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.TTS_MODEL || "qwen3-tts-vc-2026-01-22",
      input: { text, voice: env.VOICE_ID, format: "mp3", sample_rate: 24_000 },
    }),
    signal: AbortSignal.timeout(getLimits(env).ttsTimeoutMs),
  });
  if (!response.ok) throw new Error("TTS_PROVIDER_ERROR");
  const data = await response.json<{ output?: { audio?: { url?: string; data?: string } } }>();
  const inlineAudio = data.output?.audio?.data;
  if (inlineAudio) return { audioBase64: inlineAudio, provider: "dashscope" };
  const audioUrl = data.output?.audio?.url;
  if (!audioUrl) throw new Error("TTS_PROVIDER_ERROR");
  const parsed = new URL(audioUrl);
  if (parsed.protocol !== "https:" || !/\.(aliyuncs\.com|aliyun\.com)$/.test(`.${parsed.hostname}`)) throw new Error("TTS_UNTRUSTED_AUDIO_URL");
  const audioResponse = await fetch(parsed, { signal: AbortSignal.timeout(getLimits(env).ttsTimeoutMs) });
  if (!audioResponse.ok) throw new Error("TTS_PROVIDER_ERROR");
  const bytes = new Uint8Array(await audioResponse.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { audioBase64: btoa(binary), provider: "dashscope" };
}

async function generateElevenLabs(env: Env, text: string, style?: typeof STYLE_VALUES[number]): Promise<AudioResult> {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) throw new Error("TTS_NOT_CONFIGURED");
  const outputFormat = env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: `${stylePrefix(style)}${text}`, model_id: env.ELEVENLABS_MODEL_ID || "eleven_v3" }),
    signal: AbortSignal.timeout(getLimits(env).ttsTimeoutMs),
  });
  if (!response.ok) throw new Error("TTS_PROVIDER_ERROR");
  const data = await response.json<{ audio_base64?: string }>();
  if (!data.audio_base64) throw new Error("TTS_PROVIDER_ERROR");
  return { audioBase64: data.audio_base64, provider: "elevenlabs" };
}

async function generateAudio(env: Env, text: string, style?: typeof STYLE_VALUES[number]): Promise<AudioResult> {
  return env.TTS_PROVIDER === "elevenlabs" ? generateElevenLabs(env, text, style) : generateDashScope(env, text);
}

export function getPlayerHtml(botName: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;padding:12px;background:transparent}.card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:16px;padding:14px;background:color-mix(in srgb,Canvas 94%,transparent);box-shadow:0 8px 24px #0001}.row{display:flex;align-items:center;gap:12px}.play{width:42px;height:42px;border:0;border-radius:50%;background:#18a058;color:#fff;font-size:18px;cursor:pointer}.wave{flex:1;height:8px;border-radius:8px;background:linear-gradient(90deg,#18a058 var(--p,0%),#8884 var(--p,0%))}.time{font-variant-numeric:tabular-nums;font-size:12px;opacity:.7}.actions{display:flex;gap:8px;margin-top:12px}.actions button{border:1px solid #8885;background:transparent;border-radius:9px;padding:6px 10px;color:inherit;cursor:pointer}.transcript{display:none;margin:10px 0 0;white-space:pre-wrap;line-height:1.55}.transcript.open{display:block}.error{color:#c33}</style></head><body><section class="card"><div class="row"><button class="play" aria-label="播放">▶</button><div class="wave"></div><span class="time">0:00</span></div><div class="actions"><button class="toggle">文字</button><button class="download">下载 MP3</button></div><p class="transcript"></p><p class="error" hidden></p></section>
<script>const BOT_NAME=${serializeForInlineScript(botName)};let audio,url;const play=document.querySelector('.play'),wave=document.querySelector('.wave'),time=document.querySelector('.time'),transcript=document.querySelector('.transcript'),error=document.querySelector('.error');function fmt(s){if(!Number.isFinite(s))return '0:00';return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0')}function load(data){try{if(url)URL.revokeObjectURL(url);const raw=atob(data.audio_base64),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);url=URL.createObjectURL(new Blob([bytes],{type:'audio/mpeg'}));audio=new Audio(url);transcript.textContent=data.text||'';audio.ontimeupdate=()=>{time.textContent=fmt(audio.currentTime);wave.style.setProperty('--p',((audio.currentTime/(audio.duration||1))*100)+'%')};audio.onended=()=>play.textContent='▶';error.hidden=true}catch{error.textContent='语音卡片加载失败';error.hidden=false}}play.onclick=()=>{if(!audio)return;if(audio.paused){audio.play();play.textContent='Ⅱ'}else{audio.pause();play.textContent='▶'}};document.querySelector('.toggle').onclick=()=>transcript.classList.toggle('open');document.querySelector('.download').onclick=()=>{if(!url)return;const a=document.createElement('a');a.href=url;a.download=(BOT_NAME||'voice')+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.mp3';a.click()};window.addEventListener('message',event=>{if(event.source!==window.parent)return;const d=event.data;if(d?.type==='ui/notifications/tool-result'&&d.structuredContent?.audio_base64)load(d.structuredContent)});window.parent.postMessage({type:'ui/notifications/initialized'},'*');</script></body></html>`;
}

function createVoiceServer(env: Env, subject: string): McpServer {
  const botName = env.BOT_NAME || "AI";
  const server = new McpServer({ name: "voice-mcp", version: "1.1.0-c1" });
  server.registerResource("voice-player", VOICE_RESOURCE_URI, { mimeType: "text/html+skybridge", description: "Private inline voice player" }, async () => ({
    contents: [{ uri: VOICE_RESOURCE_URI, mimeType: "text/html+skybridge", text: getPlayerHtml(botName) }],
  }));
  server.registerTool("speak", {
    title: `${botName} 的声音`,
    description: "Generate one private voice card. Audio is returned inline and is not stored by the Worker.",
    inputSchema: z.object({ text: z.string().describe("Text to speak"), style: z.enum(STYLE_VALUES).optional().describe("Optional constrained speaking style") }),
    _meta: { ui: { resourceUri: VOICE_RESOURCE_URI }, "ui/resourceUri": VOICE_RESOURCE_URI },
  }, async ({ text, style }) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const limits = getLimits(env);
    const inputError = validateSpeakText(text, limits.maxVisibleChars);
    if (inputError) return { isError: true, content: [{ type: "text" as const, text: inputError }], structuredContent: { error: inputError } };
    const normalized = text.trim();
    const quota = await consumeQuota(env, subject, [...normalized].length);
    if (!quota.accepted) return { isError: true, content: [{ type: "text" as const, text: "VOICE_QUOTA_EXCEEDED" }], structuredContent: { error: "VOICE_QUOTA_EXCEEDED", reason: quota.reason, retry_after_seconds: quota.retryAfterSeconds } };
    try {
      const result = await generateAudio(env, normalized, style);
      if (base64ByteLength(result.audioBase64) > limits.maxAudioBytes) throw new Error("AUDIO_TOO_LARGE");
      console.log(JSON.stringify({ event: "voice_generated", request_id: requestId, subject_hash: await subjectHash(subject), provider: result.provider, chars: [...normalized].length, duration_ms: Date.now() - startedAt, status: "ok" }));
      return { content: [{ type: "text" as const, text: `已生成 ${botName} 的语音卡片。` }], structuredContent: { text: normalized, audio_base64: result.audioBase64, filename: `voice-${requestId}.mp3` } };
    } catch (cause) {
      const code = cause instanceof Error && ["TTS_NOT_CONFIGURED", "AUDIO_TOO_LARGE", "TTS_UNTRUSTED_AUDIO_URL"].includes(cause.message) ? cause.message : cause instanceof DOMException && cause.name === "TimeoutError" ? "TTS_TIMEOUT" : "TTS_PROVIDER_ERROR";
      console.error(JSON.stringify({ event: "voice_generated", request_id: requestId, subject_hash: await subjectHash(subject), chars: [...normalized].length, duration_ms: Date.now() - startedAt, status: "error", error_code: code }));
      return { isError: true, content: [{ type: "text" as const, text: code }], structuredContent: { error: code } };
    }
  });
  return server;
}

function resourceMetadata(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  return Response.json({
    resource: env.OAUTH_RESOURCE || `${origin}/mcp`,
    authorization_servers: env.OAUTH_ISSUER ? [env.OAUTH_ISSUER.replace(/\/$/, "")] : [],
    scopes_supported: [VOICE_SCOPE],
    bearer_methods_supported: ["header"],
  }, { headers: { "Cache-Control": "public, max-age=300", "Content-Type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) return resourceMetadata(request, env);
    if (request.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok", service: "voice-mcp", version: "1.1.0-c1" }, { headers: { "Cache-Control": "no-store" } });
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    const auth = await authenticate(request, env);
    if (auth instanceof Response) return auth;
    return createMcpHandler(createVoiceServer(env, auth.subject))(request, env, ctx);
  },
};
