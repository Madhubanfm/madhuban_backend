import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { deriveShiftIST, normalizeToDayIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";
import { buildAttendanceSelfieKey, uploadBufferToS3 } from "@/lib/s3";
import type { StaffAttendance } from "@prisma/client";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional()
});

function parseDateParam(dateParam: string | null): Date {
  if (!dateParam) {
    return new Date();
  }

  const trimmed = dateParam.trim();
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) {
    return iso;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) {
    throw new Error("invalid");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("invalid");
  }
  return new Date(Date.UTC(year, month - 1, day));
}

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
  if (user.role !== ROLE_NAMES.STAFF) return Response.json({ message: "Not allowed." }, { status: 403 });

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
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.STAFF) return Response.json({ message: "Not allowed." }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ message: "Expected multipart/form-data." }, { status: 400 });
  }

  const actionRaw = form.get("action");
  const action = typeof actionRaw === "string" ? actionRaw.trim() : "";
  if (action !== "check_in" && action !== "check_out") {
    return Response.json({ message: 'action must be "check_in" or "check_out".' }, { status: 400 });
  }

  const latParsed = parseCoordinate(form.get("latitude"), "latitude");
  const lngParsed = parseCoordinate(form.get("longitude"), "longitude");
  if (!latParsed.ok) return Response.json({ message: latParsed.message }, { status: 400 });
  if (!lngParsed.ok) return Response.json({ message: lngParsed.message }, { status: 400 });

  const coordErr = validateLatLng(latParsed.value, lngParsed.value);
  if (coordErr) return Response.json({ message: coordErr }, { status: 400 });

  const workDate = normalizeToDayIST(new Date());
  const now = new Date();

  if (action === "check_in") {
    const existing = await prisma.staffAttendance.findUnique({
      where: { staffId_workDate: { staffId: user.userId, workDate } }
    });
    if (existing?.checkInAt) {
      return Response.json({ message: "Already checked in for this day." }, { status: 409 });
    }

    const selfie = form.get("selfie");
    if (!(selfie instanceof File)) {
      return Response.json({ message: "selfie file is required for check_in." }, { status: 400 });
    }
    const ext = extFromContentType(selfie.type);
    if (!ext) {
      return Response.json({ message: "Invalid selfie type. Use image/jpeg or image/png." }, { status: 400 });
    }
    const buf = Buffer.from(await selfie.arrayBuffer());
    if (buf.length === 0) {
      return Response.json({ message: "Empty file." }, { status: 400 });
    }

    const key = buildAttendanceSelfieKey({ staffId: user.userId, workDate, ext });
    const selfieUrl = await uploadBufferToS3({ key, contentType: selfie.type, body: buf });

    const row = await prisma.staffAttendance.upsert({
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

    return Response.json({ data: attendancePayload(row, workDate) });
  }

  const existing = await prisma.staffAttendance.findUnique({
    where: { staffId_workDate: { staffId: user.userId, workDate } }
  });
  if (!existing || !existing.checkInAt) {
    return Response.json({ message: "Check in before check out." }, { status: 400 });
  }
  if (existing.checkOutAt) {
    return Response.json({ message: "Already checked out for this day." }, { status: 409 });
  }

  const row = await prisma.staffAttendance.update({
    where: { id: existing.id },
    data: {
      checkOutAt: now,
      checkOutLatitude: latParsed.value,
      checkOutLongitude: lngParsed.value
    }
  });

  return Response.json({ data: attendancePayload(row, workDate) });
}
