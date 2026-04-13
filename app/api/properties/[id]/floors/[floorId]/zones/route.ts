import { prisma } from "@/lib/prisma";

function parsePositiveInt(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return null;
  }
  return n;
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string; floorId: string }> }
) {
  const { id: propertyIdParam, floorId: floorIdParam } = await context.params;
  const propertyId = parsePositiveInt(propertyIdParam);
  const floorId = parsePositiveInt(floorIdParam);
  if (propertyId === null || floorId === null) {
    return Response.json({ message: "Invalid property or floor id." }, { status: 400 });
  }

  const floor = await prisma.propertyFloor.findFirst({
    where: { id: floorId, propertyId }
  });
  if (!floor) {
    return Response.json({ message: "Floor not found for this property." }, { status: 404 });
  }

  const zones = await prisma.propertyFloorZone.findMany({
    where: { propertyFloorId: floorId },
    orderBy: { zone: "asc" },
    select: {
      id: true,
      propertyFloorId: true,
      zone: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return Response.json({ data: zones });
}
