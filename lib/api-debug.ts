type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

function truthyEnv(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function nowIso() {
  return new Date().toISOString();
}

export function createRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function shouldDebug(routeKey: string) {
  if (!truthyEnv("DEBUG_API")) return false;
  const filter = (process.env.DEBUG_API_ROUTES ?? "").trim().toLowerCase();
  if (!filter) return true;
  const parts = filter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.includes(routeKey.toLowerCase());
}

function redactHeaderValue(key: string, value: string) {
  const k = key.toLowerCase();
  if (k === "authorization") return "Bearer [REDACTED]";
  if (k === "cookie") return "[REDACTED]";
  if (k === "x-api-key") return "[REDACTED]";
  return value;
}

export function debugApi(routeKey: string, requestId: string, message: string, data?: Record<string, unknown>) {
  if (!shouldDebug(routeKey)) return;
  const payload = data ? safeJson(data) : undefined;
  // eslint-disable-next-line no-console
  console.log(`[${nowIso()}] [api:${routeKey}] [${requestId}] ${message}`, payload ?? "");
}

export function debugRequest(routeKey: string, requestId: string, req: Request, user?: { userId?: unknown; role?: unknown; email?: unknown } | null) {
  if (!shouldDebug(routeKey)) return;

  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) {
    headers[k] = redactHeaderValue(k, v);
  }

  debugApi(routeKey, requestId, "request", {
    method: req.method,
    url: req.url,
    headers,
    user: user ? { userId: user.userId, role: user.role, email: user.email } : null
  });
}

export async function debugFormData(routeKey: string, requestId: string, form: FormData) {
  if (!shouldDebug(routeKey)) return;

  const entries: Record<string, Json> = {};
  for (const [k, v] of form.entries()) {
    if (v instanceof File) {
      entries[k] = { file: { name: v.name, size: v.size, type: v.type } };
    } else {
      const s = String(v);
      entries[k] = s.length > 500 ? `${s.slice(0, 500)}…` : s;
    }
  }
  debugApi(routeKey, requestId, "formData", entries);
}

export function debugError(routeKey: string, requestId: string, err: unknown, message = "error") {
  if (!shouldDebug(routeKey)) return;
  const e = err as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; meta?: unknown; cause?: unknown };
  debugApi(routeKey, requestId, message, {
    name: e?.name,
    message: e?.message,
    code: e?.code,
    meta: e?.meta,
    cause: e?.cause,
    stack: typeof e?.stack === "string" ? e.stack : undefined
  });
}

function safeJson(input: unknown): Json {
  try {
    return JSON.parse(
      JSON.stringify(input, (_k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
        return v;
      })
    ) as Json;
  } catch {
    return String(input);
  }
}
