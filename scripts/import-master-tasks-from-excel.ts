import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";
import { Prisma, PrismaClient } from "@prisma/client";

function normalizeCellString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s ? s : null;
}

function normalizeHeaderKey(k: string): string {
  // normalize for matching "Maker Duration (min)" vs "Maker duration", etc.
  return k
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeaderKey(row: Record<string, unknown>, wanted: string[]): string | null {
  const keys = Object.keys(row);
  const lowerToOriginal = new Map(keys.map((k) => [normalizeHeaderKey(k), k] as const));
  for (const w of wanted) {
    const found = lowerToOriginal.get(normalizeHeaderKey(w));
    if (found) return found;
  }
  return null;
}

function timeOfDayFromParts(h: number, m: number, s: number, ms: number): Date {
  const hh = ((h % 24) + 24) % 24;
  const mm = ((m % 60) + 60) % 60;
  const ss = ((s % 60) + 60) % 60;
  const mms = ((ms % 1000) + 1000) % 1000;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, ss, mms));
}

function parseTimeOfDay(value: unknown): Date | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return timeOfDayFromParts(value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds());
  }

  const s = normalizeCellString(value);
  if (!s) return null;

  // Excel sometimes serializes time as "HH:mm" / "HH:mm:ss" string
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = m[3] ? Number(m[3]) : 0;
    if (hh <= 23 && mm <= 59 && ss <= 59) return timeOfDayFromParts(hh, mm, ss, 0);
    return null;
  }

  // Try ISO-ish parse (e.g. "2026-04-15T10:30:00")
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) {
    return timeOfDayFromParts(iso.getUTCHours(), iso.getUTCMinutes(), iso.getUTCSeconds(), iso.getUTCMilliseconds());
  }

  return null;
}

function parseDurationToMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    // Sheet may store "Maker Duration (min)" as a number
    const minutes = Math.round(value);
    return minutes >= 0 ? minutes : null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const minutes = value.getHours() * 60 + value.getMinutes();
    return minutes >= 0 ? minutes : null;
  }

  const s = normalizeCellString(value);
  if (!s) return null;

  // numeric string minutes (e.g. "45")
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const minutes = Math.round(n);
    return minutes >= 0 ? minutes : null;
  }

  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (Number.isNaN(hh) || Number.isNaN(mm) || mm > 59 || hh < 0) return null;
  return hh * 60 + mm;
}

function addMinutesWrap24h(start: Date, minutesToAdd: number): Date {
  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  const total = (startMinutes + minutesToAdd) % (24 * 60);
  const wrapped = (total + 24 * 60) % (24 * 60);
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return timeOfDayFromParts(hh, mm, 0, 0);
}

function parseMaterials(value: unknown): string[] | null {
  const s = normalizeCellString(value);
  if (!s) return null;
  const items = s
    .split(/[,\n]/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

async function main() {
  const excelArg = process.argv[2] ?? "FM HO (1).xlsx";
  const excelPath = path.isAbsolute(excelArg) ? excelArg : path.resolve(process.cwd(), excelArg);

  const propertyName = process.env.PROPERTY_NAME ?? "HO";
  const floorNo = Number(process.env.FLOOR_NO ?? "1");
  const strictZones = (process.env.STRICT_ZONES ?? "false").toLowerCase() === "true";

  const workbook = XLSX.readFile(excelPath, { cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("No sheets found in the Excel file.");

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length === 0) throw new Error("No rows found in the first sheet.");

  const zoneKey =
    findHeaderKey(rows[0], ["Zones", "Zone", "Area", "Location"]) ?? findHeaderKey(rows[0], ["ZONES", "ZONE"]);
  const taskNameKey = findHeaderKey(rows[0], ["Task name", "Task Name", "Task", "TaskName"]);
  const priorityKey = findHeaderKey(rows[0], ["Priority", "PRIORITY"]);
  const makerStartKey = findHeaderKey(rows[0], ["Maker start", "Maker Start", "Start time", "Start Time"]);
  const makerDurationKey = findHeaderKey(rows[0], [
    "Maker duration",
    "Maker Duration",
    "Maker Duration (min)",
    "Maker duration (min)",
    "Duration",
    "Duration (min)",
    "MakerDuration"
  ]);
  const materialsKey = findHeaderKey(rows[0], ["Materials", "Material", "MATERIALS", "MATERIAL"]);

  const missing: string[] = [];
  if (!zoneKey) missing.push("Zones/Zone");
  if (!taskNameKey) missing.push("Task name");
  if (!makerStartKey) missing.push("Maker start");
  if (!makerDurationKey) missing.push("Maker duration");
  if (missing.length > 0) {
    const sampleKeys = Object.keys(rows[0]).slice(0, 40);
    throw new Error(
      `Missing required columns: ${missing.join(", ")}. Detected headers: ${sampleKeys.join(", ")}`
    );
  }
  const zoneKeyReq = zoneKey!;
  const taskNameKeyReq = taskNameKey!;
  const makerStartKeyReq = makerStartKey!;
  const makerDurationKeyReq = makerDurationKey!;

  const prisma = new PrismaClient();
  try {
    const admin = await prisma.user.findFirst({
      where: { role: { name: "admin" } },
      select: { id: true, email: true }
    });
    if (!admin) throw new Error(`Could not find an admin user (role.name = "admin").`);

    const property = await prisma.property.upsert({
      where: { name: propertyName },
      update: {},
      create: { name: propertyName }
    });

    const floor = await prisma.propertyFloor.upsert({
      where: { propertyId_floorNo: { propertyId: property.id, floorNo } },
      update: {},
      create: { propertyId: property.id, floorNo }
    });

    const zones = await prisma.propertyFloorZone.findMany({
      where: { propertyFloorId: floor.id },
      select: { id: true, zone: true }
    });
    const zoneByLower = new Map(zones.map((z) => [z.zone.trim().toLowerCase(), z] as const));

    const zoneIds = zones.map((z) => z.id);
    const existing = zoneIds.length
      ? await prisma.masterTask.findMany({
          where: { zoneId: { in: zoneIds } },
          select: { zoneId: true, title: true }
        })
      : [];
    const existingKey = new Set(
      existing
        .filter((t) => t.zoneId != null)
        .map((t) => `${t.zoneId}|${t.title.trim().toLowerCase()}`)
    );

    const seenInExcel = new Set<string>();
    const toInsert: Prisma.MasterTaskCreateManyInput[] = [];

    let skippedMissingFields = 0;
    let skippedUnknownZones = 0;
    let skippedDuplicate = 0;

    const unknownZonesSample = new Set<string>();

    for (const row of rows) {
      const zoneStr = normalizeCellString(row[zoneKeyReq]);
      const title = normalizeCellString(row[taskNameKeyReq]);
      if (!zoneStr || !title) {
        skippedMissingFields++;
        continue;
      }

      const zoneRow = zoneByLower.get(zoneStr.toLowerCase());
      if (!zoneRow) {
        skippedUnknownZones++;
        if (unknownZonesSample.size < 25) unknownZonesSample.add(zoneStr);
        if (strictZones) continue;
        continue;
      }

      const startTime = parseTimeOfDay(row[makerStartKeyReq]);
      const durationMin = parseDurationToMinutes(row[makerDurationKeyReq]);
      if (!startTime || durationMin === null) {
        skippedMissingFields++;
        continue;
      }
      const endTime = addMinutesWrap24h(startTime, durationMin);

      const key = `${zoneRow.id}|${title.trim().toLowerCase()}`;
      if (existingKey.has(key) || seenInExcel.has(key)) {
        skippedDuplicate++;
        continue;
      }
      seenInExcel.add(key);

      const priority = priorityKey ? normalizeCellString(row[priorityKey]) : null;
      const materials = materialsKey ? parseMaterials(row[materialsKey]) : null;

      toInsert.push({
        title: title.trim(),
        priority: priority ?? null,
        startTime,
        endTime,
        zoneId: zoneRow.id,
        createdByAdminId: admin.id,
        ...(materials ? { materials } : { materials: Prisma.DbNull })
      });
    }

    if (strictZones && unknownZonesSample.size > 0) {
      throw new Error(
        `Unknown zones found (STRICT_ZONES=true). Examples: ${Array.from(unknownZonesSample).join(", ")}`
      );
    }

    const result = toInsert.length
      ? await prisma.masterTask.createMany({
          data: toInsert
        })
      : { count: 0 };

    console.log(
      JSON.stringify(
        {
          excelPath,
          sheet: firstSheetName,
          property: { id: property.id, name: property.name },
          floor: { id: floor.id, floorNo: floor.floorNo },
          detectedColumns: {
            zone: zoneKey,
            taskName: taskNameKey,
            priority: priorityKey,
            makerStart: makerStartKey,
            makerDuration: makerDurationKey,
            materials: materialsKey
          },
          totalRows: rows.length,
          zonesOnFloor: zones.length,
          inserted: result.count,
          skipped: {
            missingFieldsOrUnparseableTime: skippedMissingFields,
            unknownZones: skippedUnknownZones,
            duplicateByZoneAndTitle: skippedDuplicate
          },
          unknownZonesSample: Array.from(unknownZonesSample)
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

