import { prisma } from "@/lib/prisma";
import { z } from "zod";

const createPropertyFloorSchema = z.object({
  propertyId: z.number().int().positive(),
  floorNo: z.number().int()
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const propertyIdRaw = url.searchParams.get("propertyId");

  const where: { propertyId?: number } = {};
  if (propertyIdRaw) {
    const propertyId = Number(propertyIdRaw);
    if (Number.isNaN(propertyId)) {
      return Response.json({ message: "Invalid propertyId." }, { status: 400 });
    }
    where.propertyId = propertyId;
  }

  const floors = await prisma.propertyFloor.findMany({
    where,
    orderBy: [{ propertyId: "asc" }, { floorNo: "asc" }],
    include: {
      property: { select: { id: true, name: true } },
      floorZones: { orderBy: { zone: "asc" } }
    }
  });

  return Response.json({ data: floors });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = createPropertyFloorSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const property = await prisma.property.findUnique({
    where: { id: parsed.data.propertyId }
  });
  if (!property) {
    return Response.json({ message: "Property not found." }, { status: 404 });
  }

  const floor = await prisma.propertyFloor.create({
    data: {
      propertyId: parsed.data.propertyId,
      floorNo: parsed.data.floorNo
    }
  });

  return Response.json({ message: "Property floor created.", data: floor }, { status: 201 });
}
