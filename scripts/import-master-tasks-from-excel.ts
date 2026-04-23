import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";
import { Prisma, PrismaClient } from "@prisma/client";

type Args = {
  excelPath: string;
  sheetName?: string;
  propertyFloorIds?: number[];
};

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

function findSheetName(workbook: XLSX.WorkBook, wanted?: string): string | null {
  if (!workbook.SheetNames.length) return null;
  if (!wanted) return workbook.SheetNames[0] ?? null;
  const normalizedWanted = wanted.trim().toLowerCase();
  const exact = workbook.SheetNames.find((n) => n === wanted);
  if (exact) return exact;
  const insensitive = workbook.SheetNames.find((n) => n.trim().toLowerCase() === normalizedWanted);
  if (insensitive) return insensitive;
  return null;
}

function detectHeaderRowIndex0(rawRows: unknown[][], requiredAny: string[][], maxScanRows = 120): number | null {
  const scan = Math.min(rawRows.length, maxScanRows);
  const wanted = requiredAny.map((alts) => alts.map((x) => normalizeHeaderKey(x)));

  for (let i = 0; i < scan; i++) {
    const row = rawRows[i] ?? [];
    const normalizedCells = new Set(
      row
        .map((c) => normalizeHeaderKey(String(c ?? "")))
        .filter(Boolean)
    );

    const ok = wanted.every((altGroup) => altGroup.some((alt) => normalizedCells.has(alt)));
    if (ok) return i;
  }
  return null;
}

function sheetToRowsUsingDetectedHeader(sheet: XLSX.WorkSheet): { rows: Record<string, unknown>[]; headerRowIndex0: number } {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" }) as unknown[][];

  const headerRowIndex0 = detectHeaderRowIndex0(
    raw,
    [
      ["Zone id", "Zone ID", "ZoneId", "Zone"],
      ["Title", "Task name", "Task Name", "Task", "TaskName"],
      ["Maker start", "Maker Start", "Start time", "Start Time"],
      ["Maker deadline", "Maker Deadline", "End time", "End Time", "Deadline"]
    ],
    200
  );

  if (headerRowIndex0 === null) {
    const firstRow = raw[0] ?? [];
    const preview = firstRow
      .slice(0, 40)
      .map((c) => String(c ?? ""))
      .join(", ");
    throw new Error(
      `Could not detect header row (looking for zone/title/maker start/maker deadline). First row cells: ${preview}`
    );
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    range: headerRowIndex0
  });
  return { rows, headerRowIndex0 };
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

function parsePositiveInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n >= 1 ? n : null;
  }
  const s = normalizeCellString(value);
  if (!s) return null;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseCommaSeparatedPositiveInts(value: string | undefined): number[] | null {
  if (!value) return null;
  const parts = value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = parsePositiveInt(p);
    if (!n) return null;
    out.push(n);
  }
  return out;
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

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const excelArg = rest.find((a) => !a.startsWith("--")) ?? "Madhuban final.xlsx";
  const sheetFromFlag = rest.find((a) => a.startsWith("--sheet="))?.slice("--sheet=".length);
  const propertyFloorIdsFromFlag = rest
    .find((a) => a.startsWith("--propertyFloorIds="))
    ?.slice("--propertyFloorIds=".length);
  const sheetName = sheetFromFlag ? sheetFromFlag.trim() : undefined;
  const propertyFloorIds = parseCommaSeparatedPositiveInts(propertyFloorIdsFromFlag) ?? undefined;

  const excelPath = path.isAbsolute(excelArg) ? excelArg : path.resolve(process.cwd(), excelArg);
  return { excelPath, sheetName, propertyFloorIds };
}

async function main() {
  const { excelPath, sheetName: sheetNameFromArgs, propertyFloorIds } = parseArgs(process.argv);
  const sheetName = sheetNameFromArgs ?? (process.env.SHEET_NAME ? process.env.SHEET_NAME.trim() : undefined);
  const strictZones = (process.env.STRICT_ZONES ?? "false").toLowerCase() === "true";

  const workbook = XLSX.readFile(excelPath, { cellDates: true });
  const chosenSheetName = findSheetName(workbook, sheetName);
  if (!chosenSheetName) throw new Error("No sheets found in the Excel file.");
  const sheet = workbook.Sheets[chosenSheetName];
  if (!sheet) {
    throw new Error(
      `Sheet not found: "${chosenSheetName}". Available: ${workbook.SheetNames.map((n) => `"${n}"`).join(", ")}`
    );
  }
  const { rows, headerRowIndex0 } = sheetToRowsUsingDetectedHeader(sheet);
  if (rows.length === 0) throw new Error(`No rows found in sheet "${chosenSheetName}".`);

  const zoneKey =
    findHeaderKey(rows[0], ["Zone id", "Zone ID", "ZoneId", "Zone", "Zones", "Area", "Location"]) ??
    findHeaderKey(rows[0], ["ZONE ID", "ZONEID", "ZONE", "ZONES", "AREA", "LOCATION"]);
  const taskNameKey = findHeaderKey(rows[0], ["Title", "Task name", "Task Name", "Task", "TaskName"]);
  const priorityKey = findHeaderKey(rows[0], ["Priority", "PRIORITY"]);
  const makerStartKey = findHeaderKey(rows[0], ["Maker start", "Maker Start", "Start time", "Start Time"]);
  const makerDeadlineKey = findHeaderKey(rows[0], [
    "Maker deadline",
    "Maker Deadline",
    "End time",
    "End Time",
    "Maker end",
    "Maker End",
    "Deadline",
    "DEADLINE"
  ]);
  const materialsKey = findHeaderKey(rows[0], ["Materials", "Material", "MATERIALS", "MATERIAL"]);

  const missing: string[] = [];
  if (!zoneKey) missing.push("Zone id/Zone");
  if (!taskNameKey) missing.push("Title/Task name");
  if (!makerStartKey) missing.push("Maker start");
  if (!makerDeadlineKey) missing.push("Maker deadline");
  if (missing.length > 0) {
    const sampleKeys = Object.keys(rows[0]).slice(0, 40);
    throw new Error(
      `Missing required columns: ${missing.join(", ")}. Detected headers: ${sampleKeys.join(", ")}`
    );
  }
  const zoneKeyReq = zoneKey!;
  const taskNameKeyReq = taskNameKey!;
  const makerStartKeyReq = makerStartKey!;
  const makerDeadlineKeyReq = makerDeadlineKey!;

  const prisma = new PrismaClient();
  try {
    const admin = await prisma.user.findFirst({
      where: { role: { name: "admin" } },
      select: { id: true, email: true }
    });
    if (!admin) throw new Error(`Could not find an admin user (role.name = "admin").`);

    const seenInExcel = new Set<string>();
    const toInsert: Prisma.MasterTaskCreateManyInput[] = [];

    let skippedMissingFields = 0;
    let skippedUnknownZones = 0;
    let skippedDuplicate = 0;

    const unknownZoneValuesSample = new Set<string>();
    const ambiguousZoneValuesSample = new Set<string>();

    const zoneIdsInExcel = new Set<number>();
    const zoneNamesInExcelLower = new Set<string>();
    for (const row of rows) {
      const rawZone = row[zoneKeyReq];
      const zoneId = parsePositiveInt(rawZone);
      if (zoneId) {
        zoneIdsInExcel.add(zoneId);
      } else {
        const zoneName = normalizeCellString(rawZone);
        if (zoneName) zoneNamesInExcelLower.add(zoneName.toLowerCase());
      }
    }

    const zoneIdsToLookup = Array.from(zoneIdsInExcel);

    const zonesById = zoneIdsToLookup.length
      ? await prisma.propertyFloorZone.findMany({
          where: { id: { in: zoneIdsToLookup } },
          select: { id: true, zone: true, propertyFloorId: true }
        })
      : [];
    const zoneById = new Map(zonesById.map((z) => [z.id, z] as const));

    // For zone-name lookups:
    // - If propertyFloorIds is provided, we resolve zone name within those floors (and can replicate tasks across floors).
    // - Otherwise, we attempt a global lookup; if name matches multiple zones across floors, treat as ambiguous.
    const zonesForNameLookup = zoneNamesInExcelLower.size
      ? await prisma.propertyFloorZone.findMany({
          where: propertyFloorIds?.length
            ? { propertyFloorId: { in: propertyFloorIds } }
            : { zone: { in: Array.from(zoneNamesInExcelLower) } },
          select: { id: true, zone: true, propertyFloorId: true }
        })
      : [];

    const zonesByNameLower = new Map<string, { id: number; zone: string; propertyFloorId: number }[]>();
    for (const z of zonesForNameLookup) {
      const k = z.zone.trim().toLowerCase();
      const arr = zonesByNameLower.get(k) ?? [];
      arr.push(z);
      zonesByNameLower.set(k, arr);
    }

    const zonesByFloorIdThenNameLower = new Map<number, Map<string, { id: number; zone: string; propertyFloorId: number }>>();
    if (propertyFloorIds?.length) {
      for (const z of zonesForNameLookup) {
        const byName = zonesByFloorIdThenNameLower.get(z.propertyFloorId) ?? new Map();
        byName.set(z.zone.trim().toLowerCase(), z);
        zonesByFloorIdThenNameLower.set(z.propertyFloorId, byName);
      }
    }

    const existing = zoneIdsToLookup.length
      ? await prisma.masterTask.findMany({
          where: { zoneId: { in: zoneIdsToLookup } },
          select: { zoneId: true, title: true }
        })
      : [];
    const existingKey = new Set(
      existing
        .filter((t) => t.zoneId != null)
        .map((t) => `${t.zoneId}|${t.title.trim().toLowerCase()}`)
    );

    for (const row of rows) {
      const title = normalizeCellString(row[taskNameKeyReq]);
      const rawZone = row[zoneKeyReq];
      const zoneIdFromExcel = parsePositiveInt(rawZone);
      const zoneNameFromExcel = zoneIdFromExcel ? null : normalizeCellString(rawZone);

      if ((!zoneIdFromExcel && !zoneNameFromExcel) || !title) {
        skippedMissingFields++;
        continue;
      }

      const candidateZoneIds: number[] = [];
      if (zoneIdFromExcel) {
        const zoneRow = zoneById.get(zoneIdFromExcel);
        if (!zoneRow) {
          skippedUnknownZones++;
          if (unknownZoneValuesSample.size < 25) unknownZoneValuesSample.add(String(zoneIdFromExcel));
          if (strictZones) continue;
          continue;
        }
        candidateZoneIds.push(zoneRow.id);
      } else if (zoneNameFromExcel) {
        const zoneLower = zoneNameFromExcel.toLowerCase();
        if (propertyFloorIds?.length) {
          for (const floorId of propertyFloorIds) {
            const byName = zonesByFloorIdThenNameLower.get(floorId);
            const z = byName?.get(zoneLower);
            if (z) candidateZoneIds.push(z.id);
          }
          if (!candidateZoneIds.length) {
            skippedUnknownZones++;
            if (unknownZoneValuesSample.size < 25) unknownZoneValuesSample.add(zoneNameFromExcel);
            if (strictZones) continue;
            continue;
          }
        } else {
          const matches = zonesByNameLower.get(zoneLower) ?? [];
          if (!matches.length) {
            skippedUnknownZones++;
            if (unknownZoneValuesSample.size < 25) unknownZoneValuesSample.add(zoneNameFromExcel);
            if (strictZones) continue;
            continue;
          }
          if (matches.length > 1) {
            skippedUnknownZones++;
            if (ambiguousZoneValuesSample.size < 25) ambiguousZoneValuesSample.add(zoneNameFromExcel);
            if (strictZones) continue;
            continue;
          }
          candidateZoneIds.push(matches[0]!.id);
        }
      }

      const startTime = parseTimeOfDay(row[makerStartKeyReq]);
      const endTime = parseTimeOfDay(row[makerDeadlineKeyReq]);
      if (!startTime || !endTime) {
        skippedMissingFields++;
        continue;
      }

      const priority = priorityKey ? normalizeCellString(row[priorityKey]) : null;
      const materials = materialsKey ? parseMaterials(row[materialsKey]) : null;

      for (const zoneId of candidateZoneIds) {
        const key = `${zoneId}|${title.trim().toLowerCase()}`;
        if (existingKey.has(key) || seenInExcel.has(key)) {
          skippedDuplicate++;
          continue;
        }
        seenInExcel.add(key);

        // If we are inserting tasks for multiple floors (replication), ensure we also consider them for DB-duplicate checks
        existingKey.add(key);

        toInsert.push({
          title: title.trim(),
          priority: priority ?? null,
          startTime,
          endTime,
          zoneId,
          createdByAdminId: admin.id,
          ...(materials ? { materials } : { materials: Prisma.DbNull })
        });
      }
    }

    if (strictZones && (unknownZoneValuesSample.size > 0 || ambiguousZoneValuesSample.size > 0)) {
      throw new Error(
        `Unknown/ambiguous zones found (STRICT_ZONES=true). Unknown examples: ${Array.from(unknownZoneValuesSample).join(
          ", "
        )}. Ambiguous examples: ${Array.from(ambiguousZoneValuesSample).join(", ")}`
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
          sheet: chosenSheetName,
          detectedHeaderRow: headerRowIndex0 + 1,
          propertyFloorIds: propertyFloorIds ?? null,
          detectedColumns: {
            zone: zoneKey,
            taskName: taskNameKey,
            priority: priorityKey,
            makerStart: makerStartKey,
            makerDeadline: makerDeadlineKey,
            materials: materialsKey
          },
          totalRows: rows.length,
          zoneIdsInExcel: zoneIdsToLookup.length,
          zonesFoundInDb: zonesById.length,
          inserted: result.count,
          skipped: {
            missingFieldsOrUnparseableTime: skippedMissingFields,
            unknownZones: skippedUnknownZones,
            duplicateByZoneAndTitle: skippedDuplicate
          },
          unknownZonesSample: Array.from(unknownZoneValuesSample),
          ambiguousZonesSample: Array.from(ambiguousZoneValuesSample)
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

