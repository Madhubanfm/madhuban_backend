import { deriveShiftIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/** Minutes before deadline to include as "due soon" (see urgent task labels). */
export const URGENT_DUE_SOON_MINUTES = 5;

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

function shiftLabel(shift: ReturnType<typeof deriveShiftIST>): string {
  if (shift === "MORNING") return "Morning";
  if (shift === "EVENING") return "Evening";
  return "Night";
}

/**
 * Context tag: distinct property names from today's supervised daily tasks, then shift.
 * Multiple properties joined with " · " (plan: first / join rule).
 */
export async function buildContextLabel(supervisorId: number, taskDate: Date): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>(
    Prisma.sql`
      SELECT DISTINCT p."name"
      FROM "DailyStaffTask" dst
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      LEFT JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      LEFT JOIN "Property" p ON p.id = f."propertyId"
      WHERE staff."supervisorId" = ${supervisorId}
        AND dst."taskDate" = ${taskDate}
        AND p."name" IS NOT NULL
      ORDER BY p."name" ASC
    `
  );

  const names = rows.map((r) => r.name).filter(Boolean);
  const sitePart = names.length > 0 ? names.join(" · ") : "—";
  const shift = deriveShiftIST(new Date());
  return `${sitePart} - ${shiftLabel(shift)}`;
}

export async function getApprovalKpis(supervisorId: number, taskDate: Date) {
  const rows = await prisma.$queryRaw<
    Array<{
      needsReview: bigint;
      approved: bigint;
      rejected: bigint;
    }>
  >(
    Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE ta."status" = 'PENDING')::bigint AS "needsReview",
        COUNT(*) FILTER (WHERE ta."status" = 'APPROVED')::bigint AS "approved",
        COUNT(*) FILTER (WHERE ta."status" = 'REJECTED')::bigint AS "rejected"
      FROM "TaskApproval" ta
      INNER JOIN "DailyStaffTask" dst ON dst.id = ta."dailyStaffTaskId"
      WHERE ta."supervisorId" = ${supervisorId}
        AND dst."taskDate" = ${taskDate}
    `
  );
  const r = rows[0];
  return {
    needsReview: Number(r?.needsReview ?? 0),
    approved: Number(r?.approved ?? 0),
    rejected: Number(r?.rejected ?? 0)
  };
}

export async function getShiftCompletion(supervisorId: number, taskDate: Date) {
  const rows = await prisma.$queryRaw<Array<{ total: bigint; done: bigint }>>(
    Prisma.sql`
      SELECT
        COUNT(dst.id)::bigint AS total,
        COUNT(dst.id) FILTER (
          WHERE dst."status" = 'COMPLETED'
            OR EXISTS (
              SELECT 1 FROM "TaskApproval" ta
              WHERE ta."dailyStaffTaskId" = dst.id AND ta."status" = 'APPROVED'
            )
        )::bigint AS done
      FROM "DailyStaffTask" dst
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      WHERE staff."supervisorId" = ${supervisorId}
        AND dst."taskDate" = ${taskDate}
    `
  );
  const r = rows[0];
  const total = Number(r?.total ?? 0);
  const done = Number(r?.done ?? 0);
  const pending = Math.max(total - done, 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, done, pending, percent };
}

export type ZoneHealthRow = {
  zoneId: number;
  zoneName: string;
  propertyName: string | null;
  floorNo: number | null;
  assigned: number;
  done: number;
  percent: number;
  healthBand: "HIGH" | "MEDIUM" | "LOW";
};

function bandFromPercent(percent: number): "HIGH" | "MEDIUM" | "LOW" {
  if (percent >= 90) return "HIGH";
  if (percent >= 60) return "MEDIUM";
  return "LOW";
}

export async function getZoneHealthForSupervisor(supervisorId: number, taskDate: Date): Promise<ZoneHealthRow[]> {
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
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      INNER JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      INNER JOIN "Property" p ON p.id = f."propertyId"
      WHERE staff."supervisorId" = ${supervisorId}
        AND dst."taskDate" = ${taskDate}
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
      percent,
      healthBand: bandFromPercent(percent)
    };
  });
}

function combineTaskDateWithIstTime(taskDate: Date, timePortion: Date | null): Date | null {
  if (!timePortion) return null;
  const y = taskDate.getUTCFullYear();
  const mo = taskDate.getUTCMonth() + 1;
  const d = taskDate.getUTCDate();
  const h = timePortion.getUTCHours();
  const mi = timePortion.getUTCMinutes();
  const s = timePortion.getUTCSeconds();
  const pad = (n: number) => String(n).padStart(2, "0");
  return new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}+05:30`);
}

function isTaskDone(
  status: string,
  approvalStatus: string | null
): boolean {
  if (status === "COMPLETED") return true;
  if (approvalStatus === "APPROVED") return true;
  return false;
}

export type UrgentTaskRow = {
  dailyTaskId: number;
  taskTitle: string;
  assigneeName: string;
  assigneeInitials: string;
  urgencyKind: "OVERDUE" | "DUE_SOON";
  label: string;
  deadlineAt: string | null;
};

export async function getUrgentTasks(
  supervisorId: number,
  taskDate: Date,
  now: Date,
  limit: number
): Promise<UrgentTaskRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      dailyTaskId: number;
      taskTitle: string;
      staffName: string;
      dstStatus: string;
      approvalStatus: string | null;
      endTime: Date | null;
    }>
  >(
    Prisma.sql`
      SELECT
        dst.id AS "dailyTaskId",
        mt."title" AS "taskTitle",
        staff."name" AS "staffName",
        dst."status" AS "dstStatus",
        ta."status" AS "approvalStatus",
        mt."endTime" AS "endTime"
      FROM "DailyStaffTask" dst
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      LEFT JOIN "TaskApproval" ta ON ta."dailyStaffTaskId" = dst.id
      WHERE staff."supervisorId" = ${supervisorId}
        AND dst."taskDate" = ${taskDate}
    `
  );

  const urgent: Array<UrgentTaskRow & { sortKey: number }> = [];

  for (const r of rows) {
    if (isTaskDone(r.dstStatus, r.approvalStatus)) continue;
    const deadline = combineTaskDateWithIstTime(taskDate, r.endTime);
    if (!deadline) continue;

    const diffMs = deadline.getTime() - now.getTime();
    const diffMin = diffMs / 60000;

    let urgencyKind: "OVERDUE" | "DUE_SOON" | null = null;
    let label = "";

    if (diffMin < 0) {
      urgencyKind = "OVERDUE";
      const overdueMin = Math.max(1, Math.min(Math.ceil(-diffMin), 999));
      label = `${overdueMin}M OVERDUE`;
    } else if (diffMin <= URGENT_DUE_SOON_MINUTES) {
      urgencyKind = "DUE_SOON";
      const m = Math.max(1, Math.ceil(diffMin));
      label = `DUE IN ${m}M`;
    }

    if (!urgencyKind) continue;

    urgent.push({
      dailyTaskId: r.dailyTaskId,
      taskTitle: r.taskTitle,
      assigneeName: r.staffName,
      assigneeInitials: initialsFromName(r.staffName),
      urgencyKind,
      label,
      deadlineAt: deadline.toISOString(),
      sortKey: diffMs
    });
  }

  urgent.sort((a, b) => a.sortKey - b.sortKey);

  return urgent.slice(0, limit).map(({ sortKey: _s, ...rest }) => rest);
}

export type RecentActivityRow = {
  id: number;
  action: "APPROVED" | "REJECTED";
  decidedAt: string;
  timeDisplay: string;
  taskTitle: string;
  staffName: string;
  note: string | null;
};

function formatTimeIst(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(d);
}

export async function getRecentActivity(supervisorId: number, limit: number): Promise<RecentActivityRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      status: string;
      decidedAt: Date;
      decisionNote: string | null;
      taskTitle: string;
      staffName: string;
    }>
  >(
    Prisma.sql`
      SELECT
        ta.id,
        ta."status",
        ta."decidedAt",
        ta."decisionNote",
        mt."title" AS "taskTitle",
        staff."name" AS "staffName"
      FROM "TaskApproval" ta
      INNER JOIN "DailyStaffTask" dst ON dst.id = ta."dailyStaffTaskId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      WHERE ta."supervisorId" = ${supervisorId}
        AND ta."decidedAt" IS NOT NULL
        AND ta."status" IN ('APPROVED', 'REJECTED')
      ORDER BY ta."decidedAt" DESC
      LIMIT ${limit}
    `
  );

  return rows.map((r) => {
    const decidedAt = r.decidedAt.toISOString();
    return {
      id: r.id,
      action: r.status === "REJECTED" ? "REJECTED" : "APPROVED",
      decidedAt,
      timeDisplay: formatTimeIst(decidedAt),
      taskTitle: r.taskTitle,
      staffName: r.staffName,
      note: r.decisionNote
    };
  });
}

export async function getSupervisorDashboardData(supervisorId: number, taskDate: Date, now: Date) {
  const [user, contextLabel, kpis, completion, zones, urgent, recent] = await Promise.all([
    prisma.user.findUnique({
      where: { id: supervisorId },
      select: { name: true, email: true }
    }),
    buildContextLabel(supervisorId, taskDate),
    getApprovalKpis(supervisorId, taskDate),
    getShiftCompletion(supervisorId, taskDate),
    getZoneHealthForSupervisor(supervisorId, taskDate),
    getUrgentTasks(supervisorId, taskDate, now, 20),
    getRecentActivity(supervisorId, 20)
  ]);

  const shift = deriveShiftIST(now);

  return {
    profile: {
      name: user?.name ?? "",
      initials: user?.name ? initialsFromName(user.name) : "?",
      role: "SUPERVISOR"
    },
    context: {
      label: contextLabel,
      shift,
      shiftLabel: shiftLabel(shift)
    },
    stats: {
      needsReview: kpis.needsReview,
      approved: kpis.approved,
      rejected: kpis.rejected
    },
    completion: {
      percent: completion.percent,
      done: completion.done,
      pending: completion.pending,
      total: completion.total
    },
    urgentTasks: urgent,
    zones,
    recentActivity: recent,
    badges: {
      tasksPending: kpis.needsReview,
      notificationsUnread: 0
    }
  };
}
