import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const page = Math.max(Number(url.searchParams.get("page") ?? "1"), 1);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "10"), 1), 100);

  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { id: "asc" },
      include: {
        role: true,
        manager: { select: { id: true, name: true, email: true } },
        supervisor: { select: { id: true, name: true, email: true } }
      }
    }),
    prisma.user.count()
  ]);

  return Response.json({
    data: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role.name,
      manager: u.manager,
      supervisor: u.supervisor,
      createdAt: u.createdAt
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
}
