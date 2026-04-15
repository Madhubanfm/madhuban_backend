import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

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
  const lowerToOriginal = new Map(keys.map((k) => [normalizeHeaderKey(k), k] as const));
  for (const w of wanted) {
    const found = lowerToOriginal.get(normalizeHeaderKey(w));
    if (found) return found;
  }
  return null;
}

function makerNameToStaffId(makerName: string): number | null {
  const m = makerName.trim().toLowerCase();
  if (!m) return null;
  if (m.includes("pawan")) return 31;
  if (m.includes("rahul")) return 32;
  return null;
}

function keyFor(zone: string, taskName: string): string {
  return `${zone.trim().toLowerCase()}|${taskName.trim().toLowerCase()}`;
}

function firstMatchMasterTaskId(
  masterTaskIdByKey: Map<string, number>,
  candidates: Array<{ zone: string; taskName: string; strategy: string }>
): { masterTaskId: number; strategy: string } | null {
  for (const c of candidates) {
    const id = masterTaskIdByKey.get(keyFor(c.zone, c.taskName));
    if (id) return { masterTaskId: id, strategy: c.strategy };
  }
  return null;
}

async function main() {
  const excelArg = process.argv[2] ?? "FM HO (1).xlsx";
  const excelPath = path.isAbsolute(excelArg) ? excelArg : path.resolve(process.cwd(), excelArg);

  const workbook = XLSX.readFile(excelPath, { cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("No sheets found in the Excel file.");

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length === 0) throw new Error("No rows found in the first sheet.");

  const taskNameKey = findHeaderKey(rows[0], ["Task Name", "Task name", "Task", "TaskName"]);
  const zoneKey = findHeaderKey(rows[0], ["Zone", "Zones", "ZONES", "ZONE", "Area", "Location"]);
  const subZoneKey = findHeaderKey(rows[0], ["Sub-Zone", "Sub Zone", "Subzone", "Sub Zone Name", "Sub-Zone Name"]);
  const functionKey = findHeaderKey(rows[0], ["Function", "Task Type", "Category"]);
  const makerKey = findHeaderKey(rows[0], ["Maker name", "Maker Name", "Maker", "Owner", "Assigned To"]);

  const missing: string[] = [];
  if (!taskNameKey) missing.push("Task Name");
  if (!zoneKey) missing.push("Zone");
  if (!makerKey) missing.push("Maker name");
  if (missing.length > 0) {
    const sampleKeys = Object.keys(rows[0]).slice(0, 60);
    throw new Error(
      `Missing required columns: ${missing.join(", ")}. Detected headers: ${sampleKeys.join(", ")}`
    );
  }

  const startDate = new Date("2026-04-15T00:00:00.000Z");
  const endDate = new Date("2030-04-15T00:00:00.000Z");

  const prisma = new PrismaClient();
  try {
    const masterTasks = await prisma.masterTask.findMany({
      where: { zoneId: { not: null } },
      select: {
        id: true,
        title: true,
        zone: { select: { zone: true } }
      }
    });

    const masterTaskIdByKey = new Map<string, number>();
    let masterTasksWithMissingZone = 0;
    for (const t of masterTasks) {
      if (!t.zone?.zone) {
        masterTasksWithMissingZone++;
        continue;
      }
      const k = keyFor(t.zone.zone, t.title);
      if (!masterTaskIdByKey.has(k)) masterTaskIdByKey.set(k, t.id);
    }

    const seenRows = new Set<string>();

    let totalRows = rows.length;
    let assignedCreated = 0;
    let assignedUpdated = 0;
    let skippedMissingFields = 0;
    let skippedUnknownMaker = 0;
    let skippedTaskNotFound = 0;
    let skippedDuplicateInExcel = 0;
    let updatedMultipleExisting = 0;

    const matchStrategyCounts: Record<string, number> = {};

    const unknownMakerSample = new Set<string>();
    const taskNotFoundSample = new Set<string>();

    for (const row of rows) {
      const taskName = normalizeCellString(row[taskNameKey!]);
      const zone = normalizeCellString(row[zoneKey!]);
      const subZone = subZoneKey ? normalizeCellString(row[subZoneKey]) : null;
      const fn = functionKey ? normalizeCellString(row[functionKey]) : null;
      const maker = normalizeCellString(row[makerKey!]);

      if (!taskName || !zone || !maker) {
        skippedMissingFields++;
        continue;
      }

      const staffId = makerNameToStaffId(maker);
      if (!staffId) {
        skippedUnknownMaker++;
        if (unknownMakerSample.size < 25) unknownMakerSample.add(maker);
        continue;
      }

      const k = keyFor(zone, taskName);
      const rowUniqKey = `${staffId}|${k}`;
      if (seenRows.has(rowUniqKey)) {
        skippedDuplicateInExcel++;
        continue;
      }
      seenRows.add(rowUniqKey);

      const match = firstMatchMasterTaskId(masterTaskIdByKey, [
        { zone, taskName, strategy: "taskName+zone" },
        { zone: taskName, taskName: zone, strategy: "zone+taskName_swapped" },
        ...(subZone ? [{ zone: subZone, taskName, strategy: "taskName+subZone" }] : []),
        ...(subZone ? [{ zone: taskName, taskName: subZone, strategy: "subZone+taskName_swapped" }] : []),
        ...(fn ? [{ zone, taskName: fn, strategy: "function+zone" }] : []),
        ...(fn ? [{ zone: fn, taskName: zone, strategy: "zone+function_swapped" }] : []),
        ...(fn && subZone ? [{ zone: subZone, taskName: fn, strategy: "function+subZone" }] : [])
        ,
        ...(fn && subZone ? [{ zone: fn, taskName: subZone, strategy: "subZone+function_swapped" }] : [])
      ]);

      if (!match) {
        skippedTaskNotFound++;
        if (taskNotFoundSample.size < 25) taskNotFoundSample.add(`${zone} :: ${taskName}`);
        continue;
      }

      matchStrategyCounts[match.strategy] = (matchStrategyCounts[match.strategy] ?? 0) + 1;
      const masterTaskId = match.masterTaskId;

      const existing = await prisma.staffMasterTask.findMany({
        where: { staffId, masterTaskId },
        select: { id: true }
      });

      if (existing.length === 0) {
        await prisma.staffMasterTask.create({
          data: { staffId, masterTaskId, startDate, endDate }
        });
        assignedCreated++;
        continue;
      }

      const updateRes = await prisma.staffMasterTask.updateMany({
        where: { staffId, masterTaskId },
        data: { startDate, endDate }
      });

      assignedUpdated++;
      if (updateRes.count > 1) updatedMultipleExisting++;
    }

    console.log(
      JSON.stringify(
        {
          excelPath,
          sheet: firstSheetName,
          detectedColumns: {
            taskName: taskNameKey,
            zone: zoneKey,
            subZone: subZoneKey,
            function: functionKey,
            makerName: makerKey
          },
          fixedDates: {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
          },
          masterTasksLoaded: masterTasks.length,
          masterTasksWithMissingZone,
          totalRows,
          results: {
            created: assignedCreated,
            updated: assignedUpdated,
            updatedMultipleExisting
          },
          matchStrategies: matchStrategyCounts,
          skipped: {
            missingFields: skippedMissingFields,
            unknownMaker: skippedUnknownMaker,
            taskNotFoundByZoneAndTitle: skippedTaskNotFound,
            duplicateInExcel: skippedDuplicateInExcel
          },
          samples: {
            unknownMaker: Array.from(unknownMakerSample),
            taskNotFoundByZoneAndTitle: Array.from(taskNotFoundSample)
          }
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

