import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { getManagerDashboardData } from "@/lib/manager-dashboard";
import { prisma } from "@/lib/prisma";
import { parseDateParam } from "@/lib/request-date";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional()
});

function shiftInProgressFromAttendance(checkInAt: Date | null | undefined, checkOutAt: Date | null | undefined): boolean {
  if (!checkInAt) return false;
  if (checkOutAt) return false;
  return true;
}

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (user.role !== ROLE_NAMES.MANAGER) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined
  });
  if (!parsedQuery.success) {
    return Response.json({ message: "Invalid query params." }, { status: 400 });
  }

  let date: Date;
  try {
    date = parseDateParam(url.searchParams.get("date"));
  } catch {
    return Response.json({ message: "Invalid date. Use YYYY-MM-DD or ISO date." }, { status: 400 });
  }

  const taskDate = normalizeToDayIST(date);
  const now = new Date();
  const managerId = user.userId;

  const [data, attendance] = await Promise.all([
    getManagerDashboardData(managerId, taskDate, now),
    prisma.staffAttendance.findUnique({
      where: {
        staffId_workDate: { staffId: managerId, workDate: taskDate }
      }
    })
  ]);

  return Response.json({
    data: {
      ...data,
      date: taskDate.toISOString(),
      shiftInProgress: shiftInProgressFromAttendance(attendance?.checkInAt, attendance?.checkOutAt)
    }
  });
}

