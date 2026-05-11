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

  if (allowList.length === 0) {
    return isCredentialsAllowed() ? requestOrigin : "*";
  }
  return allowList.includes(requestOrigin) ? requestOrigin : allowList[0]!;
}

export function middleware(req: NextRequest) {
  if (req.method !== "OPTIONS") {
    // Static CORS headers for non-preflight requests are handled by next.config.ts.
    // Avoid modifying NextResponse.next() headers here — injecting response headers
    // through middleware can cause ERR_HTTP_HEADERS_SENT on large uploads.
    return NextResponse.next();
  }

  // CORS preflight: respond immediately with a fresh response (no injection needed).
  const origin = getAllowedOrigin(req);
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set(
    "Access-Control-Allow-Methods",
    req.headers.get("access-control-request-method") ?? DEFAULT_ALLOWED_METHODS
  );
  res.headers.set(
    "Access-Control-Allow-Headers",
    req.headers.get("access-control-request-headers") ?? DEFAULT_ALLOWED_HEADERS
  );
  if (isCredentialsAllowed() && origin !== "*") {
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  res.headers.append("Vary", "Origin");
  return res;
}

export const config = {
  matcher: ["/api/:path*"]
};

