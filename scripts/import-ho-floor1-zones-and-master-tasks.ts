import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";
import { Prisma, PrismaClient } from "@prisma/client";

type Args = {
  excelPath: string;
  sheetName?: string;
  propertyFloorId: number;
  dryRun: boolean;
};

function normalizeCellString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s ? s : null;
}

function normalizeHeaderKey(k: string): string {
  return k
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findHeaderKey(row: Record<string, unknown>, wanted: string[]): string | null {
  const keys = Object.keys(row);
  const normToOriginal = new Map(keys.map((k) => [normalizeHeaderKey(k), k] as const));
  for (const w of wanted) {
    const found = normToOriginal.get(normalizeHeaderKey(w));
    if (found) return found;
  }
  return null;
}

function parseTaskIdFromDescription(description: string | null | undefined): string | null {
  const s = (description ?? "").trim();
  if (!s) return null;
  const m = /\btask id\s*:\s*([a-z0-9_-]+)\b/i.exec(s);
  return m?.[1]?.trim() ? m[1].trim() : null;
}

function keyForTask(zoneId: number, title: string, taskId?: string | null): string {
  const tid = (taskId ?? "").trim().toLowerCase();
  if (tid) return `${zoneId}|taskid:${tid}`;
  return `${zoneId}|title:${title.trim().toLowerCase()}`;
}

function findSheetName(workbook: XLSX.WorkBook, wanted?: string): string | null {
  if (!workbook.SheetNames.length) return null;
  if (!wanted) return workbook.SheetNames[0] ?? null;
  const normalizedWanted = wanted.trim().toLowerCase();
  const exact = workbook.SheetNames.find((n) => n === wanted);
  if (exact) return exact;
  const insensitive = workbook.SheetNames.find((n) => n.trim().toLowerCase() === normalizedWanted);
  return insensitive ?? null;
}

function detectHeaderRowIndex0(rawRows: unknown[][], requiredAny: string[][], maxScanRows = 200): number | null {
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
      ["Zone", "Zones", "Area", "Location"],
      ["Title", "Task name", "Task Name", "Task", "TaskName"],
      ["Maker start", "Maker Start", "Start time", "Start Time"],
      ["Maker deadline", "Maker Deadline", "End time", "End Time", "Deadline"]
    ],
    250
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

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", range: headerRowIndex0 });
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
  if (s.trim().toLowerCase() === "na") return null;

  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = m[3] ? Number(m[3]) : 0;
    if (hh <= 23 && mm <= 59 && ss <= 59) return timeOfDayFromParts(hh, mm, ss, 0);
    return null;
  }

  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) {
    return timeOfDayFromParts(iso.getUTCHours(), iso.getUTCMinutes(), iso.getUTCSeconds(), iso.getUTCMilliseconds());
  }

  return null;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const excelArg = rest.find((a) => !a.startsWith("--")) ?? "ho.xlsx";
  const sheetFromFlag = rest.find((a) => a.startsWith("--sheet="))?.slice("--sheet=".length);
  const floorFromFlag = rest.find((a) => a.startsWith("--propertyFloorId="))?.slice("--propertyFloorId=".length);
  const dryRun = rest.some((a) => a === "--dryRun" || a === "--dry-run");

  const propertyFloorId = floorFromFlag ? Number(floorFromFlag) : 1;
  if (!Number.isInteger(propertyFloorId) || propertyFloorId <= 0) {
    throw new Error(`Invalid --propertyFloorId value: "${floorFromFlag}". Expected a positive integer.`);
  }

  const sheetName = sheetFromFlag ? sheetFromFlag.trim() : undefined;
  const excelPath = path.isAbsolute(excelArg) ? excelArg : path.resolve(process.cwd(), excelArg);
  return { excelPath, sheetName, propertyFloorId, dryRun };
}

async function main() {
  const { excelPath, sheetName: sheetNameFromArgs, propertyFloorId, dryRun } = parseArgs(process.argv);
  const sheetName = sheetNameFromArgs ?? (process.env.SHEET_NAME ? process.env.SHEET_NAME.trim() : undefined);

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

  const taskIdKey = findHeaderKey(rows[0], ["Task ID", "TaskId", "Task Id", "ID"]);
  const zoneKey = findHeaderKey(rows[0], ["Zone", "Zones", "Area", "Location"]);
  const titleKey = findHeaderKey(rows[0], ["Title", "Task name", "Task Name", "Task", "TaskName"]);
  const priorityKey = findHeaderKey(rows[0], ["Priority"]);
  const makerStartKey = findHeaderKey(rows[0], ["Maker start", "Maker Start", "Start time", "Start Time"]);
  const makerDeadlineKey = findHeaderKey(rows[0], ["Maker deadline", "Maker Deadline", "End time", "End Time", "Deadline"]);

  const missing: string[] = [];
  if (!zoneKey) missing.push("Zone");
  if (!titleKey) missing.push("Title/Task name");
  if (!makerStartKey) missing.push("Maker start");
  if (!makerDeadlineKey) missing.push("Maker deadline");
  if (missing.length > 0) {
    const sampleKeys = Object.keys(rows[0]).slice(0, 40);
    throw new Error(`Missing required columns: ${missing.join(", ")}. Detected headers: ${sampleKeys.join(", ")}`);
  }

  const zoneKeyReq = zoneKey!;
  const titleKeyReq = titleKey!;
  const makerStartKeyReq = makerStartKey!;
  const makerDeadlineKeyReq = makerDeadlineKey!;

  const uniqueZonesLowerToOriginal = new Map<string, string>();
  for (const row of rows) {
    const z = normalizeCellString(row[zoneKeyReq]);
    if (!z) continue;
    const zl = z.toLowerCase();
    if (!uniqueZonesLowerToOriginal.has(zl)) uniqueZonesLowerToOriginal.set(zl, z);
  }

  const zoneNames = Array.from(uniqueZonesLowerToOriginal.values()).sort((a, b) => a.localeCompare(b));
  if (zoneNames.length === 0) throw new Error(`No zone values found under column "${zoneKeyReq}".`);

  const prisma = new PrismaClient();
  try {
    const admin = await prisma.user.findFirst({
      where: { role: { name: "admin" } },
      select: { id: true, email: true }
    });
    if (!admin) throw new Error(`Could not find an admin user (role.name = "admin").`);

    if (!dryRun) {
      await prisma.propertyFloorZone.createMany({
        data: zoneNames.map((zone) => ({ propertyFloorId, zone })),
        skipDuplicates: true
      });
    }

    const zones = await prisma.propertyFloorZone.findMany({
      where: { propertyFloorId },
      select: { id: true, zone: true }
    });
    const zoneIdByNameLower = new Map(zones.map((z) => [z.zone.trim().toLowerCase(), z.id] as const));

    const existingTasks = await prisma.masterTask.findMany({
      where: { zoneId: { in: zones.map((z) => z.id) } },
      select: { zoneId: true, title: true, description: true }
    });
    const existingKey = new Set(
      existingTasks
        .filter((t) => t.zoneId != null)
        .map((t) => keyForTask(t.zoneId!, t.title, parseTaskIdFromDescription(t.description)))
    );

    const seenInExcel = new Set<string>();
    const toInsert: Prisma.MasterTaskCreateManyInput[] = [];

    let skippedMissingFields = 0;
    let skippedUnknownZone = 0;
    let skippedDuplicate = 0;

    const unknownZonesSample = new Set<string>();

    for (const row of rows) {
      const taskId = taskIdKey ? normalizeCellString(row[taskIdKey]) : null;
      const zoneName = normalizeCellString(row[zoneKeyReq]);
      const title = normalizeCellString(row[titleKeyReq]);
      const startTime = parseTimeOfDay(row[makerStartKeyReq]);
      const endTime = parseTimeOfDay(row[makerDeadlineKeyReq]);

      if (!zoneName || !title) {
        skippedMissingFields++;
        continue;
      }

      const zoneId = zoneIdByNameLower.get(zoneName.trim().toLowerCase());
      if (!zoneId) {
        skippedUnknownZone++;
        if (unknownZonesSample.size < 25) unknownZonesSample.add(zoneName);
        continue;
      }

      const key = keyForTask(zoneId, title, taskId);
      if (existingKey.has(key) || seenInExcel.has(key)) {
        skippedDuplicate++;
        continue;
      }
      seenInExcel.add(key);
      existingKey.add(key);

      const priority = priorityKey ? normalizeCellString(row[priorityKey]) : null;
      const description = taskId ? `Task ID: ${taskId}` : null;

      toInsert.push({
        title: title.trim(),
        description,
        zoneId,
        priority: priority ?? null,
        startTime: startTime ?? null,
        endTime: endTime ?? null,
        createdByAdminId: admin.id,
        materials: Prisma.DbNull
      });
    }

    const res =
      toInsert.length && !dryRun
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
          propertyFloorId,
          dryRun,
          detectedColumns: {
            taskId: taskIdKey,
            zone: zoneKey,
            title: titleKey,
            priority: priorityKey,
            makerStart: makerStartKey,
            makerDeadline: makerDeadlineKey
          },
          uniqueZonesInExcel: zoneNames.length,
          zonesInDbForFloor: zones.length,
          masterTasksPlanned: toInsert.length,
          insertedMasterTasks: dryRun ? 0 : res.count,
          skipped: {
            missingFields: skippedMissingFields,
            unknownZoneAfterInsertLookup: skippedUnknownZone,
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

