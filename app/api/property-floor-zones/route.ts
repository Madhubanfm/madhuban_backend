import { prisma } from "@/lib/prisma";
import { z } from "zod";

const createFloorZoneSchema = z.object({
  propertyFloorId: z.number().int().positive(),
  zone: z.string().min(1)
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const propertyFloorIdRaw = url.searchParams.get("propertyFloorId");
  const where: { propertyFloorId?: number } = {};

  if (propertyFloorIdRaw) {
    const propertyFloorId = Number(propertyFloorIdRaw);
    if (Number.isNaN(propertyFloorId)) {
      return Response.json({ message: "Invalid propertyFloorId." }, { status: 400 });
    }
    where.propertyFloorId = propertyFloorId;
  }

  const zones = await prisma.propertyFloorZone.findMany({
    where,
    orderBy: [{ propertyFloorId: "asc" }, { zone: "asc" }],
    include: {
      propertyFloor: {
        select: {
          id: true,
          floorNo: true,
          property: {
            select: { id: true, name: true }
          }
        }
      }
    }
  });

  return Response.json({ data: zones });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = createFloorZoneSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const propertyFloor = await prisma.propertyFloor.findUnique({
    where: { id: parsed.data.propertyFloorId }
  });

  if (!propertyFloor) {
    return Response.json({ message: "Property floor not found." }, { status: 404 });
  }

  const zone = await prisma.propertyFloorZone.create({
    data: {
      propertyFloorId: parsed.data.propertyFloorId,
      zone: parsed.data.zone
    }
  });

  return Response.json({ message: "Property floor zone created.", data: zone }, { status: 201 });
}
