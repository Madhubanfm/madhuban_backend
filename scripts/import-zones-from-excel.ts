import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

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

async function main() {
  const excelArg = process.argv[2] ?? "FM HO (1).xlsx";
  const excelPath = path.isAbsolute(excelArg) ? excelArg : path.resolve(process.cwd(), excelArg);

  const workbook = XLSX.readFile(excelPath, { cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("No sheets found in the Excel file.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (rows.length === 0) {
    throw new Error("No rows found in the first sheet.");
  }

  const zoneKey =
    findHeaderKey(rows[0], ["Zones", "Zone", "ZONES", "ZONE"]) ??
    findHeaderKey(rows[0], ["Area", "AREA", "Location", "LOCATION"]);

  if (!zoneKey) {
    const sampleKeys = Object.keys(rows[0]).slice(0, 25);
    throw new Error(
      `Could not find a Zones column. First row headers: ${sampleKeys.join(", ")}`
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
    const property = await prisma.property.upsert({
      where: { name: "HO" },
      update: {},
      create: { name: "HO" }
    });

    const floor = await prisma.propertyFloor.upsert({
      where: {
        propertyId_floorNo: {
          propertyId: property.id,
          floorNo: 1
        }
      },
      update: {},
      create: {
        propertyId: property.id,
        floorNo: 1
      }
    });

    const result = await prisma.propertyFloorZone.createMany({
      data: zones.map((zone) => ({ propertyFloorId: floor.id, zone })),
      skipDuplicates: true
    });

    console.log(
      JSON.stringify(
        {
          excelPath,
          sheet: firstSheetName,
          detectedZoneColumn: zoneKey,
          totalRows: rows.length,
          uniqueZonesInExcel: zones.length,
          inserted: result.count,
          property: { id: property.id, name: property.name },
          floor: { id: floor.id, floorNo: floor.floorNo }
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

