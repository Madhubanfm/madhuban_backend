import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const users = await prisma.user.findMany({
    where: { role: { name: ROLE_NAMES.STAFF } },
    orderBy: { id: "asc" },
    include: {
      supervisor: { select: { id: true, name: true, email: true } }
    }
  });

  return Response.json({
    data: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      supervisor: u.supervisor
    }))
  });
}
