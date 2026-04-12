import { prisma } from "@/lib/prisma";

export async function GET() {
  const roles = await prisma.role.findMany({ orderBy: { id: "asc" } });
  return Response.json({ data: roles });
}
