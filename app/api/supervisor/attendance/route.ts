import { getAuthUserFromRequest } from "@/lib/auth";
import { createRequestId, debugApi, debugError, debugRequest } from "@/lib/api-debug";
import { ROLE_NAMES } from "@/lib/constants";
import { deriveShiftIST, normalizeToDayIST } from "@/lib/date";
import { parseDateParam } from "@/lib/request-date";
import { prisma } from "@/lib/prisma";
import { buildPublicUrl } from "@/lib/s3";
import type { StaffAttendance } from "@prisma/client";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional()
});

type Phase = "NOT_CHECKED_IN" | "ACTIVE" | "COMPLETED";

function phaseFromRow(row: StaffAttendance | null): Phase {
  if (!row?.checkInAt) return "NOT_CHECKED_IN";
  if (row.checkOutAt) return "COMPLETED";
  return "ACTIVE";
}

function attendancePayload(row: StaffAttendance | null, workDate: Date) {
  const shift = deriveShiftIST(new Date());
  return {
    workDate: workDate.toISOString(),
    status: row?.status ?? null,
    phase: phaseFromRow(row),
    checkInAt: row?.checkInAt?.toISOString() ?? null,
    checkOutAt: row?.checkOutAt?.toISOString() ?? null,
    selfieUrl: row?.selfieUrl ?? null,
    checkInLatitude: row?.checkInLatitude ?? null,
    checkInLongitude: row?.checkInLongitude ?? null,
    checkOutLatitude: row?.checkOutLatitude ?? null,
    checkOutLongitude: row?.checkOutLongitude ?? null,
    shift
  };
}

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.SUPERVISOR) return Response.json({ message: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined
  });
  if (!parsedQuery.success) {
    return Response.json({ message: "Invalid query params." }, { status: 400 });
  }

  let date: Date;
  try {
    date = parseDateParam(url.searchParams.get("date"));
  } catch {
    return Response.json({ message: "Invalid date. Use YYYY-MM-DD or ISO date." }, { status: 400 });
  }

  const workDate = normalizeToDayIST(date);
  const row = await prisma.staffAttendance.findUnique({
    where: {
      staffId_workDate: { staffId: user.userId, workDate }
    }
  });

  return Response.json({ data: attendancePayload(row, workDate) });
}

export async function POST(req: Request) {
  const requestId = createRequestId();
  const routeKey = "attendance";

  let user = null as Awaited<ReturnType<typeof getAuthUserFromRequest>>;
  try {
    user = await getAuthUserFromRequest(req);
  } catch (e) {
    debugError(routeKey, requestId, e, "auth:exception");
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }

  debugRequest(routeKey, requestId, req, user);

  if (!user) {
    debugApi(routeKey, requestId, "auth:missing");
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (user.role !== ROLE_NAMES.SUPERVISOR) {
    debugApi(routeKey, requestId, "auth:forbidden", { role: user.role });
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    debugApi(routeKey, requestId, "body:parse_failed");
    return Response.json({ message: "Expected JSON body." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (action !== "check_in" && action !== "check_out") {
    debugApi(routeKey, requestId, "validation:bad_action", { action });
    return Response.json({ message: 'action must be "check_in" or "check_out".' }, { status: 400 });
  }

  const lat = typeof body.latitude === "number" ? body.latitude : Number(body.latitude);
  const lng = typeof body.longitude === "number" ? body.longitude : Number(body.longitude);
  if (!Number.isFinite(lat)) return Response.json({ message: "latitude is required." }, { status: 400 });
  if (!Number.isFinite(lng)) return Response.json({ message: "longitude is required." }, { status: 400 });
  if (lat < -90 || lat > 90) return Response.json({ message: "latitude must be between -90 and 90." }, { status: 400 });
  if (lng < -180 || lng > 180) return Response.json({ message: "longitude must be between -180 and 180." }, { status: 400 });

  const workDate = normalizeToDayIST(new Date());
  const now = new Date();
  debugApi(routeKey, requestId, "derived:dates", { workDate: workDate.toISOString(), now: now.toISOString(), action });

  if (action === "check_in") {
    let existing: StaffAttendance | null = null;
    try {
      existing = await prisma.staffAttendance.findUnique({
        where: { staffId_workDate: { staffId: user.userId, workDate } }
      });
    } catch (e) {
      debugError(routeKey, requestId, e, "prisma:findUnique_failed");
      return Response.json({ message: "Internal error." }, { status: 500 });
    }
    if (existing?.checkInAt) {
      debugApi(routeKey, requestId, "conflict:already_checked_in", { existingId: existing.id });
      return Response.json({ message: "Already checked in for this day." }, { status: 409 });
    }

    const selfieKey = typeof body.selfieKey === "string" ? body.selfieKey.trim() : "";
    if (!selfieKey) {
      debugApi(routeKey, requestId, "validation:selfieKey_missing");
      return Response.json({ message: "selfieKey is required for check_in." }, { status: 400 });
    }
    if (!selfieKey.startsWith(`attendance/${user.userId}/`)) {
      debugApi(routeKey, requestId, "validation:selfieKey_invalid");
      return Response.json({ message: "Invalid selfieKey." }, { status: 400 });
    }

    const selfieUrl = buildPublicUrl(selfieKey);
    debugApi(routeKey, requestId, "s3:presigned_key_used", { selfieKey, selfieUrl });

    let row: StaffAttendance;
    try {
      row = await prisma.staffAttendance.upsert({
        where: { staffId_workDate: { staffId: user.userId, workDate } },
        create: {
          staffId: user.userId,
          workDate,
          status: "PRESENT",
          checkInAt: now,
          selfieUrl,
          checkInLatitude: lat,
          checkInLongitude: lng
        },
        update: {
          status: "PRESENT",
          checkInAt: now,
          selfieUrl,
          checkInLatitude: lat,
          checkInLongitude: lng
        }
      });
    } catch (e) {
      debugError(routeKey, requestId, e, "prisma:upsert_failed");
      return Response.json({ message: "Internal error." }, { status: 500 });
    }

    debugApi(routeKey, requestId, "ok:check_in", { attendanceId: row.id });
    return Response.json({ data: attendancePayload(row, workDate) });
  }

  let existing: StaffAttendance | null = null;
  try {
    existing = await prisma.staffAttendance.findUnique({
      where: { staffId_workDate: { staffId: user.userId, workDate } }
    });
  } catch (e) {
    debugError(routeKey, requestId, e, "prisma:findUnique_failed");
    return Response.json({ message: "Internal error." }, { status: 500 });
  }
  if (!existing || !existing.checkInAt) {
    debugApi(routeKey, requestId, "validation:checkout_without_checkin");
    return Response.json({ message: "Check in before check out." }, { status: 400 });
  }
  if (existing.checkOutAt) {
    debugApi(routeKey, requestId, "conflict:already_checked_out", { existingId: existing.id });
    return Response.json({ message: "Already checked out for this day." }, { status: 409 });
  }

  let row: StaffAttendance;
  try {
    row = await prisma.staffAttendance.update({
      where: { id: existing.id },
      data: { checkOutAt: now, checkOutLatitude: lat, checkOutLongitude: lng }
    });
  } catch (e) {
    debugError(routeKey, requestId, e, "prisma:update_failed");
    return Response.json({ message: "Internal error." }, { status: 500 });
  }

  debugApi(routeKey, requestId, "ok:check_out", { attendanceId: row.id });
  return Response.json({ data: attendancePayload(row, workDate) });
}
