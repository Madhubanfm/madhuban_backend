import { prisma } from "@/lib/prisma";
import { z } from "zod";

const createDepartmentSchema = z.object({
  propertyId: z.number().int().positive(),
  name: z.string().min(1)
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const propertyId = url.searchParams.get("propertyId");
  const parsedPropertyId = propertyId ? Number(propertyId) : null;

  if (propertyId && Number.isNaN(parsedPropertyId)) {
    return Response.json({ message: "Invalid propertyId." }, { status: 400 });
  }

  const where = parsedPropertyId ? { propertyId: parsedPropertyId } : {};
  const departments = await prisma.propertyDepartment.findMany({
    where,
    orderBy: { id: "asc" },
    include: {
      property: {
        select: { id: true, name: true }
      }
    }
  });

  return Response.json({ data: departments });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = createDepartmentSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const property = await prisma.property.findUnique({
    where: { id: parsed.data.propertyId }
  });

  if (!property) {
    return Response.json({ message: "Property not found." }, { status: 404 });
  }

  const department = await prisma.propertyDepartment.create({
    data: {
      propertyId: parsed.data.propertyId,
      name: parsed.data.name.toLowerCase()
    }
  });

  return Response.json({ message: "Property department created.", data: department }, { status: 201 });
}
