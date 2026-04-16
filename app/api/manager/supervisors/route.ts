import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.MANAGER) return Response.json({ message: "Not allowed." }, { status: 403 });

  const managerId = user.userId;

  const supervisors = await prisma.user.findMany({
    where: { managerId, role: { name: ROLE_NAMES.SUPERVISOR } },
    orderBy: { id: "asc" },
    include: {
      _count: { select: { supervisedStaff: true } }
    }
  });

  return Response.json({
    data: supervisors.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      staffCount: s._count.supervisedStaff
    }))
  });
}

