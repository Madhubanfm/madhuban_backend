import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const DEFAULT_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization";

function getAllowedOrigin(req: NextRequest): string {
  const requestOrigin = req.headers.get("origin");
  if (!requestOrigin) return "*";

  const allowList = (process.env.CORS_ORIGIN_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowList.length === 0) return "*";
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

