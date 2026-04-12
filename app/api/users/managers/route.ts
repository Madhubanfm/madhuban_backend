import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const users = await prisma.user.findMany({
    where: { role: { name: ROLE_NAMES.MANAGER } },
    orderBy: { id: "asc" },
    include: {
      _count: { select: { managedSupervisors: true } }
    }
  });

  return Response.json({
    data: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      supervisorCount: u._count.managedSupervisors
    }))
  });
}
