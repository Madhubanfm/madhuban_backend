import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import {
  buildReportPeriod,
  getAttendanceReport,
  getByPriorityCounts,
  getByZonePerformance,
  getLastFeedback,
  istMonthRange
} from "@/lib/staff-report";
import { z } from "zod";

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12)
});

/**
 * Task "done" for zone % = COMPLETED or TaskApproval APPROVED (see getByZonePerformance in lib/staff-report).
 */
export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (user.role !== ROLE_NAMES.STAFF) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    year: url.searchParams.get("year"),
    month: url.searchParams.get("month")
  });

  if (!parsed.success) {
    return Response.json({ message: "Invalid query. Use year and month (1–12)." }, { status: 400 });
  }

  const { year, month } = parsed.data;
  const { start, end } = istMonthRange(year, month);
  const staffId = user.userId;

  const [byPriority, byZone, attendance, feedback] = await Promise.all([
    getByPriorityCounts(staffId, start, end),
    getByZonePerformance(staffId, start, end),
    getAttendanceReport(staffId, year, month, start, end),
    getLastFeedback(staffId, 5)
  ]);

  const byPriorityMap: Record<string, number> = {};
  for (const row of byPriority) {
    byPriorityMap[row.priority] = row.count;
  }

  return Response.json({
    data: {
      period: buildReportPeriod(year, month),
      byPriority: byPriority,
      byPriorityCounts: byPriorityMap,
      byZone,
      attendance,
      feedback
    }
  });
}
