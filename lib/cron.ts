import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";

export async function generateDailyTasksForDate(inputDate: Date = new Date()) {
  const taskDate = normalizeToDayIST(inputDate);

  const activeStaffAssignments = await prisma.staffMasterTask.findMany({
    where: {
      isActive: true,
      startDate: { lte: taskDate },
      endDate: { gte: taskDate },
      staff: {
        role: {
          name: ROLE_NAMES.STAFF
        }
      }
    },
    include: {
      staff: true,
      masterTask: true
    }
  });

  if (activeStaffAssignments.length === 0) {
    return { created: 0, skipped: 0 };
  }

  let created = 0;
  let skipped = 0;

  for (const assignment of activeStaffAssignments) {
    const existing = await prisma.dailyStaffTask.findUnique({
      where: {
        staffMasterTaskId_taskDate: {
          staffMasterTaskId: assignment.id,
          taskDate
        }
      }
    });

    if (existing) {
      skipped += 1;
      continue;
    }

    await prisma.dailyStaffTask.create({
      data: {
        staffMasterTaskId: assignment.id,
        staffId: assignment.staffId,
        taskDate,
        status: "PENDING"
      }
    });

    created += 1;
  }

  return { created, skipped };
}
