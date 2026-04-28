import { getAuthUserFromRequest } from "@/lib/auth";
import { createRequestId, debugApi, debugError, debugFormData, debugRequest } from "@/lib/api-debug";
import { ROLE_NAMES } from "@/lib/constants";
import { deriveShiftIST, normalizeToDayIST } from "@/lib/date";
import { parseDateParam } from "@/lib/request-date";
import { prisma } from "@/lib/prisma";
import { buildAttendanceSelfieKey, uploadBufferToS3 } from "@/lib/s3";
import type { StaffAttendance } from "@prisma/client";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional()
});

function extFromContentType(contentType: string): "jpg" | "png" | null {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  return null;
}

function parseCoordinate(raw: FormDataEntryValue | null, label: string): { ok: true; value: number } | { ok: false; message: string } {
  if (raw == null || raw === "") {
    return { ok: false, message: `${label} is required.` };
  }
  const s = typeof raw === "string" ? raw : String(raw);
  const n = Number(s);
  if (!Number.isFinite(n)) {
    return { ok: false, message: `Invalid ${label}.` };
  }
  return { ok: true, value: n };
}

function validateLatLng(lat: number, lng: number): string | null {
  if (lat < -90 || lat > 90) return "latitude must be between -90 and 90.";
  if (lng < -180 || lng > 180) return "longitude must be between -180 and 180.";
  return null;
}

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

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    debugApi(routeKey, requestId, "formData:parse_failed");
    return Response.json({ message: "Expected multipart/form-data." }, { status: 400 });
  }

  await debugFormData(routeKey, requestId, form);

  const actionRaw = form.get("action");
  const action = typeof actionRaw === "string" ? actionRaw.trim() : "";
  if (action !== "check_in" && action !== "check_out") {
    debugApi(routeKey, requestId, "validation:bad_action", { action });
    return Response.json({ message: 'action must be "check_in" or "check_out".' }, { status: 400 });
  }

  const latParsed = parseCoordinate(form.get("latitude"), "latitude");
  const lngParsed = parseCoordinate(form.get("longitude"), "longitude");
  if (!latParsed.ok) {
    debugApi(routeKey, requestId, "validation:bad_latitude", { message: latParsed.message });
    return Response.json({ message: latParsed.message }, { status: 400 });
  }
  if (!lngParsed.ok) {
    debugApi(routeKey, requestId, "validation:bad_longitude", { message: lngParsed.message });
    return Response.json({ message: lngParsed.message }, { status: 400 });
  }

  const coordErr = validateLatLng(latParsed.value, lngParsed.value);
  if (coordErr) {
    debugApi(routeKey, requestId, "validation:bad_latlng", { message: coordErr });
    return Response.json({ message: coordErr }, { status: 400 });
  }

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

    const selfie = form.get("selfie");
    if (!(selfie instanceof File)) {
      debugApi(routeKey, requestId, "validation:selfie_missing_or_not_file", { gotType: typeof selfie });
      return Response.json({ message: "selfie file is required for check_in." }, { status: 400 });
    }
    const ext = extFromContentType(selfie.type);
    if (!ext) {
      debugApi(routeKey, requestId, "validation:selfie_bad_type", { type: selfie.type });
      return Response.json({ message: "Invalid selfie type. Use image/jpeg or image/png." }, { status: 400 });
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(await selfie.arrayBuffer());
    } catch (e) {
      debugError(routeKey, requestId, e, "selfie:read_failed");
      return Response.json({ message: "Invalid selfie file." }, { status: 400 });
    }
    if (buf.length === 0) {
      debugApi(routeKey, requestId, "validation:selfie_empty");
      return Response.json({ message: "Empty file." }, { status: 400 });
    }

    const key = buildAttendanceSelfieKey({ staffId: user.userId, workDate, ext });
    debugApi(routeKey, requestId, "s3:upload_start", { key, contentType: selfie.type, size: buf.length });

    let selfieUrl: string;
    try {
      selfieUrl = await uploadBufferToS3({ key, contentType: selfie.type, body: buf });
    } catch (e) {
      debugError(routeKey, requestId, e, "s3:upload_failed");
      return Response.json({ message: "Failed to upload selfie." }, { status: 502 });
    }
    debugApi(routeKey, requestId, "s3:upload_ok", { selfieUrl });

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
          checkInLatitude: latParsed.value,
          checkInLongitude: lngParsed.value
        },
        update: {
          status: "PRESENT",
          checkInAt: now,
          selfieUrl,
          checkInLatitude: latParsed.value,
          checkInLongitude: lngParsed.value
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
      data: {
        checkOutAt: now,
        checkOutLatitude: latParsed.value,
        checkOutLongitude: lngParsed.value
      }
    });
  } catch (e) {
    debugError(routeKey, requestId, e, "prisma:update_failed");
    return Response.json({ message: "Internal error." }, { status: 500 });
  }

  debugApi(routeKey, requestId, "ok:check_out", { attendanceId: row.id });
  return Response.json({ data: attendancePayload(row, workDate) });
}
