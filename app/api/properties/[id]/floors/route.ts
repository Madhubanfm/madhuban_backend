import { prisma } from "@/lib/prisma";

function parsePropertyId(idParam: string): number | null {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) {
    return null;
  }
  return id;
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await context.params;
  const propertyId = parsePropertyId(idParam);
  if (propertyId === null) {
    return Response.json({ message: "Invalid property id." }, { status: 400 });
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId }
  });
  if (!property) {
    return Response.json({ message: "Property not found." }, { status: 404 });
  }

  const floors = await prisma.propertyFloor.findMany({
    where: { propertyId },
    orderBy: { floorNo: "asc" },
    select: {
      id: true,
      propertyId: true,
      floorNo: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return Response.json({ data: floors });
}
