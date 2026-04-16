import { prisma } from "@/lib/prisma";

function getRequestOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (proto && host) {
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}

export async function GET(req: Request) {
  const rows = await prisma.property.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      imageUrl: true,
      createdAt: true,
      updatedAt: true,
      departments: { select: { id: true } },
      floors: {
        orderBy: { floorNo: "asc" },
        select: {
          id: true,
          floorNo: true,
          _count: { select: { floorZones: true } }
        }
      }
    }
  });

  const origin = getRequestOrigin(req);
  const data = rows.map((p) => ({
    id: p.id,
    name: p.name,
    imageUrl: p.imageUrl ? new URL(p.imageUrl, origin).toString() : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    departmentCount: p.departments.length,
    floorCount: p.floors.length,
    zoneCount: p.floors.reduce((sum, f) => sum + f._count.floorZones, 0)
  }));

  return Response.json({ data });
}
