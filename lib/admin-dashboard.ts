import { prisma } from "@/lib/prisma";
import { ROLE_NAMES } from "@/lib/constants";
import { Prisma } from "@prisma/client";

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

function percent(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((n / d) * 100)));
}

async function getUsersByRoleCounts() {
  const rows = await prisma.$queryRaw<Array<{ roleName: string; count: bigint }>>(
    Prisma.sql`
      SELECT r."name" AS "roleName", COUNT(u.id)::bigint AS "count"
      FROM "User" u
      INNER JOIN "Role" r ON r.id = u."roleId"
      GROUP BY r."name"
    `
  );

  const byRole = {
    admin: 0,
    manager: 0,
    supervisor: 0,
    staff: 0
  };

  for (const r of rows) {
    const k = String(r.roleName).trim().toLowerCase();
    const c = Number(r.count ?? 0);
    if (k === ROLE_NAMES.ADMIN) byRole.admin = c;
    if (k === ROLE_NAMES.MANAGER) byRole.manager = c;
    if (k === ROLE_NAMES.SUPERVISOR) byRole.supervisor = c;
    if (k === ROLE_NAMES.STAFF) byRole.staff = c;
  }

  const usersTotal = Object.values(byRole).reduce((s, v) => s + v, 0);
  return { usersTotal, usersByRole: byRole };
}

async function getDailyTaskCounts(taskDate: Date, propertyId?: number) {
  if (!propertyId) {
    const [assigned, completed] = await Promise.all([
      prisma.dailyStaffTask.count({ where: { taskDate } }),
      prisma.dailyStaffTask.count({ where: { taskDate, status: "COMPLETED" } })
    ]);
    const pending = Math.max(assigned - completed, 0);
    return { assigned, completed, pending, open: pending };
  }

  const rows = await prisma.$queryRaw<Array<{ assigned: bigint; completed: bigint }>>(
    Prisma.sql`
      SELECT
        COUNT(dst.id)::bigint AS assigned,
        COUNT(dst.id) FILTER (WHERE dst."status" = 'COMPLETED')::bigint AS completed
      FROM "DailyStaffTask" dst
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      INNER JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      INNER JOIN "Property" p ON p.id = f."propertyId"
      WHERE dst."taskDate" = ${taskDate}
        AND p.id = ${propertyId}
    `
  );

  const r = rows[0];
  const assigned = Number(r?.assigned ?? 0);
  const completed = Number(r?.completed ?? 0);
  const pending = Math.max(assigned - completed, 0);
  return { assigned, completed, pending, open: pending };
}

async function getPropertyScopedEligibleStaffIds(taskDate: Date, propertyId: number): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ staffId: number }>>(
    Prisma.sql`
      SELECT DISTINCT dst."staffId" AS "staffId"
      FROM "DailyStaffTask" dst
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      INNER JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      WHERE dst."taskDate" = ${taskDate}
        AND f."propertyId" = ${propertyId}
    `
  );

  return rows.map((r) => r.staffId).filter((id) => Number.isFinite(id));
}

async function getAttendanceSummary(taskDate: Date, propertyId?: number) {
  if (!propertyId) {
    const [staffTotal, present] = await Promise.all([
      prisma.user.count({
        where: { role: { name: ROLE_NAMES.STAFF } }
      }),
      prisma.staffAttendance.count({
        where: {
          workDate: taskDate,
          checkInAt: { not: null },
          staff: { role: { name: ROLE_NAMES.STAFF } }
        }
      })
    ]);

    const absent = Math.max(staffTotal - present, 0);
    return { present, absent, percent: percent(present, staffTotal) };
  }

  const eligibleStaffIds = await getPropertyScopedEligibleStaffIds(taskDate, propertyId);
  const staffTotal = eligibleStaffIds.length;

  if (staffTotal === 0) {
    return { present: 0, absent: 0, percent: 0 };
  }

  const present = await prisma.staffAttendance.count({
    where: {
      workDate: taskDate,
      checkInAt: { not: null },
      staffId: { in: eligibleStaffIds }
    }
  });

  const absent = Math.max(staffTotal - present, 0);
  return { present, absent, percent: percent(present, staffTotal) };
}

export async function getAdminDashboardData(adminId: number, taskDate: Date, propertyId?: number) {
  const [admin, propertiesTotal, masterTasksTotal, usersCounts, dailyTasks, attendanceToday] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: adminId },
        select: { name: true, email: true }
      }),
      prisma.property.count(),
      prisma.masterTask.count(),
      getUsersByRoleCounts(),
      getDailyTaskCounts(taskDate, propertyId),
      getAttendanceSummary(taskDate, propertyId)
    ]);

  return {
    profile: {
      name: admin?.name ?? "",
      initials: admin?.name ? initialsFromName(admin.name) : "?",
      role: "ADMIN"
    },
    filters: {
      date: taskDate.toISOString(),
      propertyId: propertyId ?? null
    },
    kpis: {
      propertiesTotal,
      usersTotal: usersCounts.usersTotal,
      usersByRole: usersCounts.usersByRole,
      masterTasksTotal,
      dailyTasks
    },
    attendanceToday
  };
}

