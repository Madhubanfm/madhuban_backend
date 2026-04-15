import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const DEFAULT_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization";

function isCredentialsAllowed() {
  return (process.env.CORS_ALLOW_CREDENTIALS ?? "").toLowerCase() === "true";
}

function getAllowedOrigin(req: NextRequest): string {
  const requestOrigin = req.headers.get("origin");
  if (!requestOrigin) return "*";

  const allowList = (process.env.CORS_ORIGIN_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // When credentials are enabled, browsers reject `Access-Control-Allow-Origin: *`.
  // In that case, echo the request origin (or an allowlisted origin).
  if (allowList.length === 0) {
    return isCredentialsAllowed() ? requestOrigin : "*";
  }
  return allowList.includes(requestOrigin) ? requestOrigin : allowList[0]!;
}

function withCorsHeaders(res: NextResponse, origin: string, req?: NextRequest) {
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set(
    "Access-Control-Allow-Methods",
    req?.headers.get("access-control-request-method") ?? DEFAULT_ALLOWED_METHODS
  );
  // Mirror requested headers when present to avoid preflight failures caused by
  // additional headers from the browser/framework (e.g. x-requested-with).
  res.headers.set(
    "Access-Control-Allow-Headers",
    req?.headers.get("access-control-request-headers") ?? DEFAULT_ALLOWED_HEADERS
  );
  if (isCredentialsAllowed() && origin !== "*") {
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  // Avoid caching a response that varies by Origin
  res.headers.append("Vary", "Origin");
  return res;
}

export function middleware(req: NextRequest) {
  const origin = getAllowedOrigin(req);

  if (req.method === "OPTIONS") {
    // CORS preflight
    return withCorsHeaders(new NextResponse(null, { status: 204 }), origin, req);
  }

  return withCorsHeaders(NextResponse.next(), origin, req);
}

export const config = {
  matcher: ["/api/:path*"]
};

