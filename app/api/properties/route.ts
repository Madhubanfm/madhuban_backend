import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"]
]);

const zoneInputSchema = z.object({
  name: z.string().min(1)
});

const floorInputSchema = z.object({
  floorNumber: z.number().int(),
  zones: z.array(zoneInputSchema).default([])
});

const createPropertySchema = z
  .object({
    propertyName: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    floors: z.array(floorInputSchema).optional()
  })
  .refine((data) => Boolean(data.propertyName?.trim() || data.name?.trim()), {
    message: "Provide propertyName or name."
  });

const propertyListInclude = {
  departments: true,
  floors: {
    orderBy: [{ floorNo: "asc" as const }],
    include: {
      floorZones: {
        orderBy: [{ zone: "asc" as const }]
      }
    }
  }
} satisfies Prisma.PropertyInclude;

type FloorsInput = z.infer<typeof floorInputSchema>[];

function validateFloorsInput(floorsInput: FloorsInput): Response | null {
  const floorNumbers = floorsInput.map((f) => f.floorNumber);
  if (new Set(floorNumbers).size !== floorNumbers.length) {
    return Response.json(
      { message: "Duplicate floorNumber in the same request." },
      { status: 400 }
    );
  }

  for (const floor of floorsInput) {
    const zoneNames = floor.zones.map((z) => z.name);
    if (new Set(zoneNames).size !== zoneNames.length) {
      return Response.json(
        { message: "Duplicate zone name on the same floor." },
        { status: 400 }
      );
    }
  }

  return null;
}

async function savePropertyImage(
  file: File
): Promise<{ imageUrl: string; absolutePath: string } | { message: string; status: number }> {
  if (file.size > MAX_IMAGE_BYTES) {
    return { message: "Image too large (max 5MB).", status: 400 };
  }

  const ext = ALLOWED_IMAGE_TYPES.get(file.type);
  if (!ext) {
    return {
      message: "Invalid image type. Allowed: jpeg, png, gif, webp.",
      status: 400
    };
  }

  const dir = path.join(process.cwd(), "public", "uploads", "properties");
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}${ext}`;
  const absolutePath = path.join(dir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(absolutePath, buffer);
  const imageUrl = `/uploads/properties/${filename}`;
  return { imageUrl, absolutePath };
}

async function createPropertyWithFloors(
  displayName: string,
  floorsInput: FloorsInput,
  imageUrl: string | null
) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.property.create({
      data: {
        name: displayName,
        ...(imageUrl != null ? { imageUrl } : {})
      }
    });

    for (const floor of floorsInput) {
      const propertyFloor = await tx.propertyFloor.create({
        data: {
          propertyId: created.id,
          floorNo: floor.floorNumber
        }
      });
      for (const zone of floor.zones) {
        await tx.propertyFloorZone.create({
          data: {
            propertyFloorId: propertyFloor.id,
            zone: zone.name
          }
        });
      }
    }

    return tx.property.findUniqueOrThrow({
      where: { id: created.id },
      include: propertyListInclude
    });
  });
}

export async function GET() {
  const properties = await prisma.property.findMany({
    orderBy: [{ name: "asc" }],
    include: propertyListInclude
  });

  return Response.json({ data: properties });
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  let displayName: string;
  let floorsInput: FloorsInput;
  let imageFile: File | null = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const propertyNameRaw = formData.get("propertyName");
    const nameRaw = formData.get("name");
    const fromPropertyName =
      typeof propertyNameRaw === "string" && propertyNameRaw.trim() ? propertyNameRaw.trim() : "";
    const fromName = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : "";
    displayName = fromPropertyName || fromName;
    if (!displayName) {
      return Response.json({ message: "Provide propertyName or name." }, { status: 400 });
    }

    const floorsRaw = formData.get("floors");
    let floorsJson: unknown = [];
    if (floorsRaw != null && String(floorsRaw).trim() !== "") {
      try {
        floorsJson = JSON.parse(String(floorsRaw));
      } catch {
        return Response.json(
          { message: "Invalid floors JSON. Expected a JSON array." },
          { status: 400 }
        );
      }
    }

    const floorsParse = z.array(floorInputSchema).safeParse(floorsJson);
    if (!floorsParse.success) {
      return Response.json({ message: "Invalid floors structure." }, { status: 400 });
    }

    floorsInput = floorsParse.data;

    const img = formData.get("image");
    if (img instanceof File && img.size > 0) {
      imageFile = img;
    }
  } else {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ message: "Invalid JSON body." }, { status: 400 });
    }

    const parsed = createPropertySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ message: "Invalid payload." }, { status: 400 });
    }

    displayName = (parsed.data.propertyName ?? parsed.data.name)!.trim();
    floorsInput = parsed.data.floors ?? [];
  }

  const floorsError = validateFloorsInput(floorsInput);
  if (floorsError) {
    return floorsError;
  }

  let savedImage: { imageUrl: string; absolutePath: string } | null = null;
  if (imageFile) {
    const saved = await savePropertyImage(imageFile);
    if ("imageUrl" in saved) {
      savedImage = saved;
    } else {
      return Response.json({ message: saved.message }, { status: saved.status });
    }
  }

  try {
    const property = await createPropertyWithFloors(
      displayName,
      floorsInput,
      savedImage?.imageUrl ?? null
    );
    return Response.json({ message: "Property created.", data: property }, { status: 201 });
  } catch (e) {
    if (savedImage) {
      await unlink(savedImage.absolutePath).catch(() => {});
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return Response.json(
        {
          message:
            "Conflict: property name, floor number, or zone name already exists for this hierarchy."
        },
        { status: 409 }
      );
    }
    throw e;
  }
}
