import { normalizeToDayIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/** Month 1–12. Start/end are UTC-midnight dates matching `taskDate` / IST calendar days. */
export function istMonthRange(year: number, month: number): { start: Date; end: Date } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const start = normalizeToDayIST(new Date(`${year}-${pad(month)}-01T12:00:00+05:30`));
  const lastDay = new Date(year, month, 0).getDate();
  const end = normalizeToDayIST(new Date(`${year}-${pad(month)}-${pad(lastDay)}T12:00:00+05:30`));
  return { start, end };
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, 1))
  );
}

/** Done = task completed or supervisor approved (see product note in route). */
export async function getByPriorityCounts(staffId: number, start: Date, end: Date) {
  const rows = await prisma.$queryRaw<Array<{ priority: string | null; count: bigint }>>(
    Prisma.sql`
      SELECT COALESCE(mt."priority", 'UNKNOWN') AS priority, COUNT(*)::bigint AS count
      FROM "DailyStaffTask" dst
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      WHERE dst."staffId" = ${staffId}
        AND dst."taskDate" >= ${start}
        AND dst."taskDate" <= ${end}
      GROUP BY mt."priority"
      ORDER BY priority ASC
    `
  );
  return rows.map((r) => ({
    priority: r.priority ?? "UNKNOWN",
    count: Number(r.count)
  }));
}

export type ZonePerformanceRow = {
  zoneId: number;
  zoneName: string;
  propertyName: string | null;
  floorNo: number | null;
  assigned: number;
  done: number;
  percent: number;
};

export async function getByZonePerformance(staffId: number, start: Date, end: Date): Promise<ZonePerformanceRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      zoneId: number;
      zoneName: string;
      propertyName: string | null;
      floorNo: number | null;
      assigned: bigint;
      done: bigint;
    }>
  >(
    Prisma.sql`
      SELECT
        z.id AS "zoneId",
        z."zone" AS "zoneName",
        p."name" AS "propertyName",
        f."floorNo" AS "floorNo",
        COUNT(dst.id)::bigint AS assigned,
        COUNT(dst.id) FILTER (
          WHERE dst."status" = 'COMPLETED'
            OR EXISTS (
              SELECT 1 FROM "TaskApproval" ta
              WHERE ta."dailyStaffTaskId" = dst.id AND ta."status" = 'APPROVED'
            )
        )::bigint AS done
      FROM "DailyStaffTask" dst
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      INNER JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      INNER JOIN "Property" p ON p.id = f."propertyId"
      WHERE dst."staffId" = ${staffId}
        AND dst."taskDate" >= ${start}
        AND dst."taskDate" <= ${end}
        AND mt."zoneId" IS NOT NULL
      GROUP BY z.id, z."zone", p."name", f."floorNo"
      ORDER BY z."zone" ASC
    `
  );

  return rows.map((r) => {
    const assigned = Number(r.assigned);
    const done = Number(r.done);
    const percent = assigned > 0 ? Math.round((done / assigned) * 100) : 0;
    return {
      zoneId: r.zoneId,
      zoneName: r.zoneName,
      propertyName: r.propertyName,
      floorNo: r.floorNo,
      assigned,
      done,
      percent
    };
  });
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (parts.length === 1 && parts[0].length >= 2) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return parts[0]?.[0]?.toUpperCase() ?? "?";
}

function relativeLabelIst(decidedAt: Date): string {
  const decidedDay = normalizeToDayIST(decidedAt);
  const today = normalizeToDayIST(new Date());
  const yest = new Date(today);
  yest.setUTCDate(yest.getUTCDate() - 1);
  const yesterday = normalizeToDayIST(yest);
  if (decidedDay.getTime() === today.getTime()) return "Today";
  if (decidedDay.getTime() === yesterday.getTime()) return "Yesterday";
  return decidedDay.toISOString().slice(0, 10);
}

export async function getLastFeedback(staffId: number, limit: number) {
  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      taskTitle: string;
      decisionNote: string | null;
      rating: number | null;
      decidedAt: Date | null;
      supervisorName: string;
    }>
  >(
    Prisma.sql`
      SELECT
        ta.id,
        mt."title" AS "taskTitle",
        ta."decisionNote",
        ta."rating",
        ta."decidedAt",
        u."name" AS "supervisorName"
      FROM "TaskApproval" ta
      INNER JOIN "DailyStaffTask" dst ON dst.id = ta."dailyStaffTaskId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "User" u ON u.id = ta."supervisorId"
      WHERE ta."staffId" = ${staffId}
        AND ta."decidedAt" IS NOT NULL
      ORDER BY ta."decidedAt" DESC
      LIMIT ${limit}
    `
  );

  return rows.map((r) => ({
    id: r.id,
    taskTitle: r.taskTitle,
    comment: r.decisionNote,
    rating: r.rating,
    checkerInitials: initialsFromName(r.supervisorName),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    relativeLabel: r.decidedAt ? relativeLabelIst(r.decidedAt) : ""
  }));
}

function datesEqualUtc(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

function addUtcDays(d: Date, delta: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + delta);
  return x;
}

/** Max consecutive PRESENT days in sorted ascending unique dates. */
export function maxPresentStreak(sortedPresentDays: Date[]): number {
  if (sortedPresentDays.length === 0) return 0;
  let best = 1;
  let cur = 1;
  for (let i = 1; i < sortedPresentDays.length; i++) {
    const prev = sortedPresentDays[i - 1]!;
    const curr = sortedPresentDays[i]!;
    const expectedNext = addUtcDays(prev, 1);
    if (datesEqualUtc(expectedNext, curr)) {
      cur += 1;
      best = Math.max(best, cur);
    } else {
      cur = 1;
    }
  }
  return best;
}

/** Streak ending at the latest present day (global, not month-scoped). */
export function currentPresentStreakFromLatest(sortedPresentDaysDesc: Date[]): number {
  if (sortedPresentDaysDesc.length === 0) return 0;
  let streak = 1;
  for (let i = 1; i < sortedPresentDaysDesc.length; i++) {
    const newer = sortedPresentDaysDesc[i - 1]!;
    const older = sortedPresentDaysDesc[i]!;
    const expectedOlder = addUtcDays(newer, -1);
    if (datesEqualUtc(expectedOlder, older)) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

export async function getAttendanceReport(
  staffId: number,
  year: number,
  month: number,
  monthStart: Date,
  monthEnd: Date
) {
  const allRows = await prisma.staffAttendance.findMany({
    where: { staffId, status: "PRESENT" },
    select: { workDate: true },
    orderBy: { workDate: "asc" }
  });

  const presentDaysAll = [...new Map(allRows.map((r) => [r.workDate.getTime(), r.workDate])).values()].sort(
    (a, b) => a.getTime() - b.getTime()
  );

  const bestStreakDays = maxPresentStreak(presentDaysAll);

  const presentDesc = [...presentDaysAll].sort((a, b) => b.getTime() - a.getTime());
  const currentStreakDays = currentPresentStreakFromLatest(presentDesc);

  const monthRows = await prisma.staffAttendance.findMany({
    where: {
      staffId,
      workDate: { gte: monthStart, lte: monthEnd }
    },
    select: { workDate: true, status: true }
  });
  const byDay = new Map<number, string>();
  for (const r of monthRows) {
    byDay.set(r.workDate.getTime(), r.status);
  }

  const dim = new Date(year, month, 0).getDate();
  const days: Array<{ date: string; status: string }> = [];
  for (let d = 1; d <= dim; d++) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const dayDate = normalizeToDayIST(new Date(`${year}-${pad(month)}-${pad(d)}T12:00:00+05:30`));
    const status = byDay.get(dayDate.getTime()) ?? "UNKNOWN";
    days.push({ date: dayDate.toISOString().slice(0, 10), status });
  }

  return {
    currentStreakDays,
    bestStreakDays,
    days
  };
}

export function buildReportPeriod(year: number, month: number) {
  return {
    year,
    month,
    label: monthLabel(year, month)
  };
}
