import { prisma } from "@/lib/prisma";
import { z } from "zod";

const createPropertySchema = z.object({
  name: z.string().min(1)
});

export async function GET() {
  const properties = await prisma.property.findMany({
    orderBy: [{ name: "asc" }],
    include: {
      departments: true,
      floors: {
        orderBy: [{ floorNo: "asc" }],
        include: {
          floorZones: {
            orderBy: [{ zone: "asc" }]
          }
        }
      }
    }
  });

  return Response.json({ data: properties });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = createPropertySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const property = await prisma.property.create({
    data: {
      name: parsed.data.name
    }
  });

  return Response.json({ message: "Property created.", data: property }, { status: 201 });
}
