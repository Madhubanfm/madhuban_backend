import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { deriveShiftIST, normalizeToDayIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatFloorLabel(floorNo: number | null): string | null {
  if (floorNo === null) {
    return null;
  }
  if (floorNo === 0) {
    return "Ground Floor";
  }
  return `Floor ${floorNo}`;
}

function formatPriority(priority: string | null): string | null {
  if (!priority) {
    return null;
  }
  const lower = priority.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function shiftLabel(shift: ReturnType<typeof deriveShiftIST>): string {
  if (shift === "MORNING") {
    return "Morning";
  }
  if (shift === "EVENING") {
    return "Evening";
  }
  return "Night";
}

type TodayTaskRow = {
  title: string;
  description: string | null;
  zone: string | null;
  floorNo: number | null;
};

export async function GET(req: Request) {
  const auth = await getAuthUserFromRequest(req);
  if (!auth) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (auth.role !== ROLE_NAMES.STAFF) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  const staffId = auth.userId;
  const today = normalizeToDayIST(new Date());
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const [user, activeAssignments, todayTaskCount, todayTasks, todayAttendance] = await Promise.all([
    prisma.user.findUnique({
      where: { id: staffId },
      include: {
        role: { select: { name: true } },
        supervisor: { select: { id: true, name: true, email: true } }
      }
    }),
    prisma.staffMasterTask.findMany({
      where: {
        staffId,
        isActive: true,
        startDate: { lt: tomorrow },
        endDate: { gte: today }
      },
      include: {
        masterTask: {
          include: {
            zone: {
              include: {
                propertyFloor: {
                  include: { property: { select: { id: true, name: true } } }
                }
              }
            }
          }
        }
      }
    }),
    prisma.dailyStaffTask.count({
      where: { staffId, taskDate: today }
    }),
    prisma.$queryRaw<TodayTaskRow[]>`
      SELECT
        mt."title" AS "title",
        mt."description" AS "description",
        z."zone" AS "zone",
        f."floorNo" AS "floorNo"
      FROM "DailyStaffTask" dst
      JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      LEFT JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      WHERE dst."staffId" = ${staffId}
        AND dst."taskDate" = ${today}
      ORDER BY mt."startTime" ASC NULLS LAST, mt.id ASC
    `,
    prisma.staffAttendance.findUnique({
      where: {
        staffId_workDate: { staffId, workDate: today }
      }
    })
  ]);

  if (!user) {
    return Response.json({ message: "User not found." }, { status: 404 });
  }

  const masterTaskIds = new Set<number>();
  const zoneIds = new Set<number>();
  const propertyIds = new Set<number>();

  for (const a of activeAssignments) {
    masterTaskIds.add(a.masterTaskId);
    const z = a.masterTask.zone;
    if (z) {
      zoneIds.add(z.id);
      const pid = z.propertyFloor?.property?.id;
      if (pid != null) {
        propertyIds.add(pid);
      }
    }
  }

  const byFunctionTitle = new Map<
    string,
    { isActive: boolean; zones: Map<number, { name: string; floor: string | null; priority: string | null }> }
  >();

  for (const a of activeAssignments) {
    const title = a.masterTask.title;
    let bucket = byFunctionTitle.get(title);
    if (!bucket) {
      bucket = { isActive: a.isActive, zones: new Map() };
      byFunctionTitle.set(title, bucket);
    }
    bucket.isActive = bucket.isActive || a.isActive;
    const z = a.masterTask.zone;
    if (z) {
      const floorNo = z.propertyFloor?.floorNo ?? null;
      bucket.zones.set(z.id, {
        name: z.zone,
        floor: formatFloorLabel(floorNo),
        priority: formatPriority(a.masterTask.priority)
      });
    }
  }

  let assignedFunctions = Array.from(byFunctionTitle.entries()).map(([function_name, v]) => ({
    function_name,
    is_primary: false,
    status: v.isActive ? ("Active" as const) : ("Inactive" as const),
    zones: [...v.zones.values()]
  }));

  assignedFunctions.sort((a, b) => b.zones.length - a.zones.length);
  assignedFunctions = assignedFunctions.map((f, i) => ({ ...f, is_primary: i === 0 }));

  const shift = deriveShiftIST(new Date());
  let attendanceIncentive: boolean | null = null;
  if (todayAttendance) {
    attendanceIncentive = todayAttendance.status === "PRESENT";
  }

  return Response.json({
    data: {
      staff_id: user.id,
      full_name: user.name,
      email: user.email,
      initials: initialsFromName(user.name),
      role: user.role.name.toUpperCase(),
      is_active: activeAssignments.length > 0,
      status: activeAssignments.length > 0 ? "ACTIVE" : "INACTIVE",
      profile_picture_url: null as string | null,
      stats: {
        functions: masterTaskIds.size,
        zones: zoneIds.size,
        locations: propertyIds.size
      },
      assignment_details: {
        assigned_checker_id: user.supervisor?.id ?? null,
        assigned_checker_name: user.supervisor?.name ?? null,
        default_tasks_per_day: todayTaskCount,
        is_eligible_for_attendance_incentive: attendanceIncentive
      },
      assigned_functions: assignedFunctions,
      current_assignments: {
        shift: shiftLabel(shift),
        shift_code: shift,
        tasks: todayTasks.map((t) => ({
          area: t.zone,
          floor: formatFloorLabel(t.floorNo),
          description: t.description ?? t.title
        }))
      },
      skills_and_certifications: [] as string[]
    }
  });
}
