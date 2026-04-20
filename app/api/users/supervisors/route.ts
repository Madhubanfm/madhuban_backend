import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const users = await prisma.user.findMany({
    where: { role: { name: ROLE_NAMES.SUPERVISOR } },
    orderBy: { id: "asc" },
    include: {
      manager: { select: { id: true, name: true, email: true } },
      _count: { select: { supervisedStaff: true } }
    }
  });

  return Response.json({
    data: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      mobileNumber: u.mobileNumber ?? null,
      manager: u.manager,
      staffCount: u._count.supervisedStaff
    }))
  });
}
