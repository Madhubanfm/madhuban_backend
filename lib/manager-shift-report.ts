import { normalizeToDayIST } from "@/lib/date";
import { FunctionGroup, functionGroupForZoneName } from "@/lib/function-zone-map";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
  if (parts.length === 1 && parts[0]!.length >= 2) return parts[0]!.slice(0, 2).toUpperCase();
  return parts[0]?.[0]?.toUpperCase() ?? "?";
}

function deadlineIsoFromTimePortion(taskDate: Date, timePortionText: string | null): string | null {
  if (!timePortionText) return null;
  const t = timePortionText.trim();
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const hh = m[1]!;
  const mm = m[2]!;
  const ss = m[3] ?? "00";
  const y = taskDate.getUTCFullYear();
  const mo = String(taskDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(taskDate.getUTCDate()).padStart(2, "0");
  return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}+05:30`).toISOString();
}

function isDone(dstStatus: string, approvalStatus: string | null) {
  if (dstStatus === "COMPLETED") return true;
  if (approvalStatus === "APPROVED") return true;
  return false;
}

export type ShiftReportOverview = {
  completion: { percent: number; done: number; pending: number; total: number };
  approvals: { approved: number; pending: number; rejected: number };
};

export async function getShiftOverviewForManager(managerId: number, taskDate: Date): Promise<ShiftReportOverview> {
  const [completionRow, approvalsRow] = await Promise.all([
    prisma.$queryRaw<Array<{ total: bigint; done: bigint }>>(
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
        INNER JOIN "User" sup ON sup.id = staff."supervisorId"
        WHERE sup."managerId" = ${managerId}
          AND dst."taskDate" = ${taskDate}
      `
    ),
    prisma.$queryRaw<Array<{ approved: bigint; pending: bigint; rejected: bigint }>>(
      Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE ta."status" = 'APPROVED')::bigint AS approved,
          COUNT(*) FILTER (WHERE ta."status" = 'PENDING')::bigint AS pending,
          COUNT(*) FILTER (WHERE ta."status" = 'REJECTED')::bigint AS rejected
        FROM "TaskApproval" ta
        INNER JOIN "DailyStaffTask" dst ON dst.id = ta."dailyStaffTaskId"
        INNER JOIN "User" staff ON staff.id = dst."staffId"
        INNER JOIN "User" sup ON sup.id = staff."supervisorId"
        WHERE sup."managerId" = ${managerId}
          AND dst."taskDate" = ${taskDate}
      `
    )
  ]);

  const c = completionRow?.[0];
  const total = Number(c?.total ?? BigInt(0));
  const done = Number(c?.done ?? BigInt(0));
  const pending = Math.max(total - done, 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const a = approvalsRow?.[0];
  return {
    completion: { percent, done, pending, total },
    approvals: {
      approved: Number(a?.approved ?? BigInt(0)),
      pending: Number(a?.pending ?? BigInt(0)),
      rejected: Number(a?.rejected ?? BigInt(0))
    }
  };
}

export type ZoneReportRow = {
  zoneId: number;
  zoneName: string;
  propertyName: string | null;
  floorNo: number | null;
  assigned: number;
  done: number;
  percent: number;
};

export async function getZoneCompletionForManager(managerId: number, taskDate: Date): Promise<ZoneReportRow[]> {
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
      INNER JOIN "User" sup ON sup.id = staff."supervisorId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      INNER JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      INNER JOIN "Property" p ON p.id = f."propertyId"
      WHERE sup."managerId" = ${managerId}
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
      percent
    };
  });
}

export type FunctionHealthRow = {
  functionKey: string;
  functionLabel: string;
  assigned: number;
  approved: number;
  percent: number;
};

export async function getFunctionHealthForManager(
  managerId: number,
  taskDate: Date,
  groups: FunctionGroup[]
): Promise<FunctionHealthRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      zoneName: string | null;
      assigned: bigint;
      approved: bigint;
    }>
  >(
    Prisma.sql`
      SELECT
        z."zone" AS "zoneName",
        COUNT(dst.id)::bigint AS assigned,
        COUNT(dst.id) FILTER (WHERE ta."status" = 'APPROVED')::bigint AS approved
      FROM "DailyStaffTask" dst
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      INNER JOIN "User" sup ON sup.id = staff."supervisorId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      LEFT JOIN "TaskApproval" ta ON ta."dailyStaffTaskId" = dst.id
      WHERE sup."managerId" = ${managerId}
        AND dst."taskDate" = ${taskDate}
      GROUP BY z."zone"
    `
  );

  const agg = new Map<string, { label: string; assigned: number; approved: number }>();
  for (const r of rows) {
    const g = functionGroupForZoneName(r.zoneName, groups);
    const cur = agg.get(g.key) ?? { label: g.label, assigned: 0, approved: 0 };
    cur.assigned += Number(r.assigned);
    cur.approved += Number(r.approved);
    agg.set(g.key, cur);
  }

  const out: FunctionHealthRow[] = [];
  for (const g of groups) {
    const cur = agg.get(g.key);
    if (!cur) continue;
    const percent = cur.assigned > 0 ? Math.round((cur.approved / cur.assigned) * 100) : 0;
    out.push({
      functionKey: g.key,
      functionLabel: cur.label,
      assigned: cur.assigned,
      approved: cur.approved,
      percent
    });
  }
  for (const [k, cur] of agg.entries()) {
    if (groups.some((g) => g.key === k)) continue;
    const percent = cur.assigned > 0 ? Math.round((cur.approved / cur.assigned) * 100) : 0;
    out.push({ functionKey: k, functionLabel: cur.label, assigned: cur.assigned, approved: cur.approved, percent });
  }

  return out;
}

export type EmployeePerformanceRow = {
  staffId: number;
  name: string;
  initials: string;
  scorePercent: number;
  tasks: number;
  onTimePercent: number;
};

type EmployeePerfRaw = {
  staffId: number;
  staffName: string;
  tasks: bigint;
  approved: bigint;
  rejected: bigint;
  onTimeDone: bigint;
  done: bigint;
};

export async function getEmployeePerformanceForManager(managerId: number, taskDate: Date): Promise<EmployeePerformanceRow[]> {
  const rows = await prisma.$queryRaw<EmployeePerfRaw[]>(
    Prisma.sql`
      SELECT
        staff.id AS "staffId",
        staff."name" AS "staffName",
        COUNT(dst.id)::bigint AS tasks,
        COUNT(dst.id) FILTER (WHERE ta."status" = 'APPROVED')::bigint AS approved,
        COUNT(dst.id) FILTER (WHERE ta."status" = 'REJECTED')::bigint AS rejected,
        COUNT(dst.id) FILTER (
          WHERE (
            dst."status" = 'COMPLETED'
            OR ta."status" = 'APPROVED'
          )
        )::bigint AS done,
        COUNT(dst.id) FILTER (
          WHERE (
            (dst."status" = 'COMPLETED' OR ta."status" = 'APPROVED')
            AND (
              CASE
                WHEN dst."completedAt" IS NOT NULL THEN dst."completedAt"
                ELSE ta."decidedAt"
              END
            ) IS NOT NULL
            AND (
              CASE
                WHEN dst."completedAt" IS NOT NULL THEN dst."completedAt"
                ELSE ta."decidedAt"
              END
            ) <= (
              (dst."taskDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata'
              + (mt."endTime")::time
            ) AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC'
          )
        )::bigint AS "onTimeDone"
      FROM "DailyStaffTask" dst
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      INNER JOIN "User" sup ON sup.id = staff."supervisorId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      LEFT JOIN "TaskApproval" ta ON ta."dailyStaffTaskId" = dst.id
      WHERE sup."managerId" = ${managerId}
        AND dst."taskDate" = ${taskDate}
      GROUP BY staff.id, staff."name"
      ORDER BY staff."name" ASC
    `
  );

  return rows.map((r) => {
    const tasks = Number(r.tasks);
    const approved = Number(r.approved);
    const rejected = Number(r.rejected);
    const decided = approved + rejected;
    const scorePercent = decided > 0 ? Math.round((approved / decided) * 100) : 0;

    const done = Number(r.done);
    const onTimeDone = Number(r.onTimeDone);
    const onTimePercent = done > 0 ? Math.round((onTimeDone / done) * 100) : 0;

    return {
      staffId: r.staffId,
      name: r.staffName,
      initials: initialsFromName(r.staffName),
      scorePercent,
      tasks,
      onTimePercent
    };
  });
}

export type EmployeeShiftLogRow = {
  dailyTaskId: number;
  title: string;
  zoneName: string | null;
  propertyName: string | null;
  floorNo: number | null;
  status: "DONE" | "IN_PROG";
  time: string | null;
  rating: number | null;
};

export async function getManagerEmployeeShiftLogs(
  managerId: number,
  staffId: number,
  taskDate: Date
): Promise<{ staffId: number; staffName: string; staffInitials: string; summary: EmployeePerformanceRow | null; logs: EmployeeShiftLogRow[] }> {
  const staff = await prisma.user.findFirst({
    where: { id: staffId, supervisor: { managerId } },
    select: { id: true, name: true }
  });
  if (!staff) {
    return { staffId, staffName: "", staffInitials: "?", summary: null, logs: [] };
  }

  const [summaryAll, rows] = await Promise.all([
    getEmployeePerformanceForManager(managerId, taskDate),
    prisma.$queryRaw<
      Array<{
        dailyTaskId: number;
        taskTitle: string;
        zoneName: string | null;
        propertyName: string | null;
        floorNo: number | null;
        dstStatus: string;
        approvalStatus: string | null;
        decidedAt: Date | null;
        completedAt: Date | null;
        rating: number | null;
      }>
    >(
      Prisma.sql`
        SELECT
          dst.id AS "dailyTaskId",
          mt."title" AS "taskTitle",
          z."zone" AS "zoneName",
          p."name" AS "propertyName",
          f."floorNo" AS "floorNo",
          dst."status" AS "dstStatus",
          ta."status" AS "approvalStatus",
          ta."decidedAt" AS "decidedAt",
          dst."completedAt" AS "completedAt",
          ta."rating" AS "rating"
        FROM "DailyStaffTask" dst
        INNER JOIN "User" staff ON staff.id = dst."staffId"
        INNER JOIN "User" sup ON sup.id = staff."supervisorId"
        INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
        INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
        LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
        LEFT JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
        LEFT JOIN "Property" p ON p.id = f."propertyId"
        LEFT JOIN "TaskApproval" ta ON ta."dailyStaffTaskId" = dst.id
        WHERE sup."managerId" = ${managerId}
          AND dst."staffId" = ${staffId}
          AND dst."taskDate" = ${taskDate}
        ORDER BY mt."endTime" ASC NULLS LAST, dst.id ASC
      `
    )
  ]);

  const summary = summaryAll.find((s) => s.staffId === staffId) ?? null;

  const logs: EmployeeShiftLogRow[] = rows.map((r) => {
    const done = isDone(r.dstStatus, r.approvalStatus);
    const time = (r.completedAt ?? r.decidedAt)?.toISOString() ?? null;
    return {
      dailyTaskId: r.dailyTaskId,
      title: r.taskTitle,
      zoneName: r.zoneName,
      propertyName: r.propertyName,
      floorNo: r.floorNo,
      status: done ? "DONE" : "IN_PROG",
      time,
      rating: r.rating
    };
  });

  return {
    staffId: staff.id,
    staffName: staff.name,
    staffInitials: initialsFromName(staff.name),
    summary,
    logs
  };
}

export type EscalationRow =
  | {
      kind: "NO_SHOW";
      staffId: number;
      staffName: string;
      label: string;
      time: string | null;
    }
  | {
      kind: "OVERDUE_TASK";
      dailyTaskId: number;
      staffId: number;
      staffName: string;
      title: string;
      zoneName: string | null;
      label: string;
      deadlineAt: string | null;
    };

export async function getEscalationsForManager(managerId: number, taskDate: Date, now: Date): Promise<EscalationRow[]> {
  const taskDateNorm = normalizeToDayIST(taskDate);
  const [attendanceRows, taskRows] = await Promise.all([
    prisma.$queryRaw<Array<{ staffId: number; staffName: string; status: string | null }>>(
      Prisma.sql`
        SELECT
          u.id AS "staffId",
          u."name" AS "staffName",
          sa."status" AS "status"
        FROM "User" u
        INNER JOIN "User" sup ON sup.id = u."supervisorId"
        LEFT JOIN "StaffAttendance" sa
          ON sa."staffId" = u.id AND sa."workDate" = ${taskDateNorm}
        WHERE sup."managerId" = ${managerId}
        ORDER BY u."name" ASC
      `
    ),
    prisma.$queryRaw<
      Array<{
        dailyTaskId: number;
        staffId: number;
        staffName: string;
        taskTitle: string;
        zoneName: string | null;
        dstStatus: string;
        approvalStatus: string | null;
        endTime: string | null;
      }>
    >(
      Prisma.sql`
        SELECT
          dst.id AS "dailyTaskId",
          staff.id AS "staffId",
          staff."name" AS "staffName",
          mt."title" AS "taskTitle",
          z."zone" AS "zoneName",
          dst."status" AS "dstStatus",
          ta."status" AS "approvalStatus",
          mt."endTime"::text AS "endTime"
        FROM "DailyStaffTask" dst
        INNER JOIN "User" staff ON staff.id = dst."staffId"
        INNER JOIN "User" sup ON sup.id = staff."supervisorId"
        INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
        INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
        LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
        LEFT JOIN "TaskApproval" ta ON ta."dailyStaffTaskId" = dst.id
        WHERE sup."managerId" = ${managerId}
          AND dst."taskDate" = ${taskDateNorm}
      `
    )
  ]);

  const escalations: EscalationRow[] = [];

  for (const a of attendanceRows) {
    const s = (a.status ?? "").toUpperCase();
    if (s === "ABSENT" || s === "") {
      escalations.push({
        kind: "NO_SHOW",
        staffId: a.staffId,
        staffName: a.staffName,
        label: "No Show",
        time: null
      });
    }
  }

  for (const t of taskRows) {
    if (isDone(t.dstStatus, t.approvalStatus)) continue;
    const deadlineAt = deadlineIsoFromTimePortion(taskDateNorm, t.endTime);
    if (!deadlineAt) continue;
    const deadline = new Date(deadlineAt);
    const diffMin = (deadline.getTime() - now.getTime()) / 60000;
    if (diffMin < 0) {
      const overdueMin = Math.max(1, Math.min(Math.ceil(-diffMin), 999));
      escalations.push({
        kind: "OVERDUE_TASK",
        dailyTaskId: t.dailyTaskId,
        staffId: t.staffId,
        staffName: t.staffName,
        title: t.taskTitle,
        zoneName: t.zoneName,
        label: `${overdueMin}m overdue`,
        deadlineAt
      });
    }
  }

  return escalations;
}

export async function getManagerShiftReport(managerId: number, taskDate: Date, now: Date, groups: FunctionGroup[]) {
  const d = normalizeToDayIST(taskDate);
  const [overview, zones, functions, employees, escalations] = await Promise.all([
    getShiftOverviewForManager(managerId, d),
    getZoneCompletionForManager(managerId, d),
    getFunctionHealthForManager(managerId, d, groups),
    getEmployeePerformanceForManager(managerId, d),
    getEscalationsForManager(managerId, d, now)
  ]);

  return {
    date: d.toISOString(),
    overview,
    zones,
    functions,
    employees,
    escalations
  };
}

