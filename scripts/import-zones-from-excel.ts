import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

type CliOptions = {
  excelPath: string;
  propertyFloorIds: number[];
  sheetName?: string;
  dryRun: boolean;
};

type HeaderDetection = {
  headerRowIndex0: number;
  zoneHeader: string;
};

function normalizeZone(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value)
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s;
}

function findHeaderKey(row: Record<string, unknown>, wanted: string[]): string | null {
  const keys = Object.keys(row);
  const lowerToOriginal = new Map(keys.map((k) => [k.trim().toLowerCase(), k] as const));
  for (const w of wanted) {
    const found = lowerToOriginal.get(w.trim().toLowerCase());
    if (found) return found;
  }
  return null;
}

function normalizeHeaderCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function detectHeaderRow(rawRows: unknown[][], maxScanRows = 50): HeaderDetection | null {
  const wantedZoneHeaders = ["zones", "zone", "area", "location"];
  const scanLimit = Math.min(rawRows.length, maxScanRows);

  for (let r = 0; r < scanLimit; r++) {
    const row = rawRows[r] ?? [];
    const normalizedCells = row.map(normalizeHeaderCell).filter(Boolean);
    for (const w of wantedZoneHeaders) {
      if (normalizedCells.includes(w)) {
        // Find the original header cell text as-is (first match)
        const idx = row.findIndex((c) => normalizeHeaderCell(c) === w);
        const zoneHeader = idx >= 0 ? String(row[idx] ?? "").trim() : w;
        return { headerRowIndex0: r, zoneHeader };
      }
    }
  }

  return null;
}

function sheetToRowsUsingHeader(sheet: XLSX.WorkSheet): { rows: Record<string, unknown>[]; headerRowIndex0: number } {
  // Read as arrays first so we can find the real header row (Excel often has title rows).
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" }) as unknown[][];
  if (raw.length === 0) {
    return { rows: [], headerRowIndex0: 0 };
  }

  const detection = detectHeaderRow(raw, 80);
  if (!detection) {
    // Fallback: treat row 0 as header (original behavior)
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    return { rows, headerRowIndex0: 0 };
  }

  const headerRowIndex0 = detection.headerRowIndex0;
  // Build objects using the detected header row.
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    range: headerRowIndex0
  });
  return { rows, headerRowIndex0 };
}

function parsePositiveIntListCsv(value: string): number[] {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const nums = parts.map((p) => Number(p));
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`Invalid --propertyFloorIds value: "${value}". Expected comma-separated positive integers.`);
  }
  return Array.from(new Set(nums));
}

function parseArgs(argv: string[]): CliOptions {
  let excelArg: string | undefined;
  let propertyFloorIds: number[] | undefined;
  let sheetName: string | undefined;
  let dryRun = false;

  for (const raw of argv) {
    if (raw === "--dryRun" || raw === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (raw.startsWith("--propertyFloorIds=") || raw.startsWith("--property-floor-ids=")) {
      const v = raw.split("=", 2)[1] ?? "";
      propertyFloorIds = parsePositiveIntListCsv(v);
      continue;
    }
    if (raw.startsWith("--sheet=")) {
      const v = raw.split("=", 2)[1] ?? "";
      sheetName = v.trim() || undefined;
      continue;
    }
    if (!raw.startsWith("--") && !excelArg) {
      excelArg = raw;
      continue;
    }
  }

  const excelPathRaw = excelArg ?? "Madhuban final.xlsx";
  const excelPath = path.isAbsolute(excelPathRaw)
    ? excelPathRaw
    : path.resolve(process.cwd(), excelPathRaw);

  return {
    excelPath,
    propertyFloorIds: propertyFloorIds ?? [1, 5, 4, 3, 2],
    sheetName,
    dryRun
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const workbook = XLSX.readFile(opts.excelPath, { cellDates: true });
  const resolvedSheetName = opts.sheetName ?? workbook.SheetNames[0];
  if (!resolvedSheetName) {
    throw new Error("No sheets found in the Excel file.");
  }

  const sheet = workbook.Sheets[resolvedSheetName];
  if (!sheet) {
    throw new Error(`Sheet not found: "${resolvedSheetName}". Available: ${workbook.SheetNames.join(", ")}`);
  }
  const { rows, headerRowIndex0 } = sheetToRowsUsingHeader(sheet);
  if (rows.length === 0) {
    throw new Error("No rows found in the first sheet.");
  }

  const zoneKey =
    findHeaderKey(rows[0], ["Zones", "Zone", "ZONES", "ZONE"]) ??
    findHeaderKey(rows[0], ["Area", "AREA", "Location", "LOCATION"]);

  if (!zoneKey) {
    const sampleKeys = Object.keys(rows[0]).slice(0, 25);
    throw new Error(
      `Could not find a Zones column. Detected headerRow=${headerRowIndex0 + 1}. Headers: ${sampleKeys.join(", ")}`
    );
  }

  const uniqueZones = new Map<string, string>(); // normalized -> original (first seen)
  for (const row of rows) {
    const raw = row[zoneKey];
    const normalized = normalizeZone(raw);
    if (!normalized) continue;
    if (!uniqueZones.has(normalized.toLowerCase())) {
      uniqueZones.set(normalized.toLowerCase(), normalized);
    }
  }

  const zones = Array.from(uniqueZones.values()).sort((a, b) => a.localeCompare(b));
  if (zones.length === 0) {
    throw new Error(`No zone values found under column "${zoneKey}".`);
  }

  const prisma = new PrismaClient();
  try {
    const floors = await prisma.propertyFloor.findMany({
      where: { id: { in: opts.propertyFloorIds } },
      select: {
        id: true,
        floorNo: true,
        property: { select: { id: true, name: true } }
      }
    });

    const foundIds = new Set(floors.map((f) => f.id));
    const missing = opts.propertyFloorIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`propertyFloorId(s) not found: ${missing.join(", ")}`);
    }

    const plannedInserts = floors.map((floor) => ({
      propertyFloorId: floor.id,
      rows: zones.map((zone) => ({ propertyFloorId: floor.id, zone }))
    }));

    const insertedByFloorId: Record<number, number> = {};

    if (!opts.dryRun) {
      await prisma.$transaction(async (tx) => {
        for (const item of plannedInserts) {
          const res = await tx.propertyFloorZone.createMany({
            data: item.rows,
            skipDuplicates: true
          });
          insertedByFloorId[item.propertyFloorId] = res.count;
        }
      });
    }

    console.log(
      JSON.stringify(
        {
          excelPath: opts.excelPath,
          sheet: resolvedSheetName,
          detectedHeaderRow: headerRowIndex0 + 1,
          detectedZoneColumn: zoneKey,
          totalRows: rows.length,
          uniqueZonesInExcel: zones.length,
          targetPropertyFloorIds: opts.propertyFloorIds,
          dryRun: opts.dryRun,
          insertedByFloorId: opts.dryRun ? undefined : insertedByFloorId,
          floors: floors
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

