import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");

  const date = dateParam ? new Date(dateParam) : new Date();
  const taskDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

  const tasks = await prisma.dailyStaffTask.findMany({
    where: {
      taskDate
    },
    orderBy: { id: "desc" },
    include: {
      staff: {
        select: {
          id: true,
          name: true,
          email: true,
          supervisor: { select: { id: true, name: true, email: true } }
        }
      },
      staffMasterTask: {
        include: {
          masterTask: true
        }
      }
    }
  });

  return Response.json({ data: tasks });
}
