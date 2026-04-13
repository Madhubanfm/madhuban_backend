import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional()
});

function parseDateParam(dateParam: string | null): Date {
  if (!dateParam) {
    return new Date();
  }

  const trimmed = dateParam.trim();
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) {
    return iso;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) {
    throw new Error("invalid");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("invalid");
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function deriveShiftIST(now: Date): "MORNING" | "EVENING" | "NIGHT" {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hour12: false
  }).format(now);
  const hour = Number(hourStr);

  if (!Number.isFinite(hour)) {
    return "MORNING";
  }

  if (hour >= 5 && hour < 14) {
    return "MORNING";
  }
  if (hour >= 14 && hour < 22) {
    return "EVENING";
  }
  return "NIGHT";
}

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (user.role !== ROLE_NAMES.STAFF) {
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
  const staffId = user.userId;

  const [assigned, completed, criticalPendingResult] = await Promise.all([
    prisma.dailyStaffTask.count({
      where: { staffId, taskDate }
    }),
    prisma.dailyStaffTask.count({
      where: { staffId, taskDate, status: "COMPLETED" }
    }),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "DailyStaffTask" dst
      JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      WHERE dst."staffId" = ${staffId}
        AND dst."taskDate" = ${taskDate}
        AND dst."status" <> 'COMPLETED'
        AND mt."priority" IN ('HIGH', 'CRITICAL')
    `
  ]);

  const criticalPending = Number(criticalPendingResult?.[0]?.count ?? BigInt(0));

  return Response.json({
    data: {
      date: taskDate.toISOString(),
      shift: deriveShiftIST(new Date()),
      counts: {
        assigned,
        completed,
        remaining: Math.max(assigned - completed, 0)
      },
      actionNeeded: {
        criticalPending
      }
    }
  });
}

