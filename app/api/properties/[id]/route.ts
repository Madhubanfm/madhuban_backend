import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const propertyDetailInclude = {
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

const updatePropertySchema = z
  .object({
    name: z.string().min(1).optional()
  })
  .refine((data) => data.name !== undefined, {
    message: "Provide at least one field to update."
  });

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
  const id = parsePropertyId(idParam);
  if (id === null) {
    return Response.json({ message: "Invalid property id." }, { status: 400 });
  }

  const property = await prisma.property.findUnique({
    where: { id },
    include: propertyDetailInclude
  });

  if (!property) {
    return Response.json({ message: "Property not found." }, { status: 404 });
  }

  return Response.json({ data: property });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await context.params;
  const id = parsePropertyId(idParam);
  if (id === null) {
    return Response.json({ message: "Invalid property id." }, { status: 400 });
  }

  const body = await req.json();
  const parsed = updatePropertySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const existing = await prisma.property.findUnique({ where: { id } });
  if (!existing) {
    return Response.json({ message: "Property not found." }, { status: 404 });
  }

  try {
    const property = await prisma.property.update({
      where: { id },
      data: { name: parsed.data.name },
      include: propertyDetailInclude
    });
    return Response.json({ message: "Property updated.", data: property });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return Response.json(
        { message: "A property with this name already exists." },
        { status: 409 }
      );
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await context.params;
  const id = parsePropertyId(idParam);
  if (id === null) {
    return Response.json({ message: "Invalid property id." }, { status: 400 });
  }

  try {
    await prisma.property.delete({ where: { id } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return Response.json({ message: "Property not found." }, { status: 404 });
    }
    throw e;
  }

  return Response.json({ message: "Property deleted." });
}
