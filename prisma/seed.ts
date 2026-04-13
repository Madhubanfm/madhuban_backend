import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/auth";
import { ALL_ROLES, ROLE_NAMES } from "../lib/constants";
import { normalizeToDayIST } from "../lib/date";

const prisma = new PrismaClient();

async function main() {
  for (const roleName of ALL_ROLES) {
    await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName }
    });
  }

  const roles = await prisma.role.findMany();
  const roleMap = new Map(roles.map((role) => [role.name, role.id]));

  const adminPassword = await hashPassword("Admin@123");
  const managerPassword = await hashPassword("Manager@123");
  const supervisorPassword = await hashPassword("Supervisor@123");
  const staffPassword = await hashPassword("Staff@123");

  const admin = await prisma.user.upsert({
    where: { email: "admin@madhuban360.com" },
    update: {
      name: "Default Admin",
      passwordHash: adminPassword,
      roleId: roleMap.get(ROLE_NAMES.ADMIN)!
    },
    create: {
      name: "Default Admin",
      email: "admin@madhuban360.com",
      passwordHash: adminPassword,
      roleId: roleMap.get(ROLE_NAMES.ADMIN)!
    }
  });

  const manager = await prisma.user.upsert({
    where: { email: "manager@madhuban360.com" },
    update: {
      name: "Default Manager",
      passwordHash: managerPassword,
      roleId: roleMap.get(ROLE_NAMES.MANAGER)!
    },
    create: {
      name: "Default Manager",
      email: "manager@madhuban360.com",
      passwordHash: managerPassword,
      roleId: roleMap.get(ROLE_NAMES.MANAGER)!
    }
  });

  const supervisor = await prisma.user.upsert({
    where: { email: "supervisor@madhuban360.com" },
    update: {
      name: "Default Supervisor",
      passwordHash: supervisorPassword,
      roleId: roleMap.get(ROLE_NAMES.SUPERVISOR)!,
      managerId: manager.id
    },
    create: {
      name: "Default Supervisor",
      email: "supervisor@madhuban360.com",
      passwordHash: supervisorPassword,
      roleId: roleMap.get(ROLE_NAMES.SUPERVISOR)!,
      managerId: manager.id
    }
  });

  await prisma.user.upsert({
    where: { email: "staff@madhuban360.com" },
    update: {
      name: "Default Staff",
      passwordHash: staffPassword,
      roleId: roleMap.get(ROLE_NAMES.STAFF)!,
      supervisorId: supervisor.id
    },
    create: {
      name: "Default Staff",
      email: "staff@madhuban360.com",
      passwordHash: staffPassword,
      roleId: roleMap.get(ROLE_NAMES.STAFF)!,
      supervisorId: supervisor.id
    }
  });

  await prisma.masterTask.upsert({
    where: { id: 1 },
    update: {
      title: "Daily Attendance Check",
      description: "Verify and submit daily attendance."
    },
    create: {
      id: 1,
      title: "Daily Attendance Check",
      description: "Verify and submit daily attendance.",
      createdByAdminId: admin.id
    }
  });

  // Explicit `id` in create does not advance PostgreSQL's sequence; fix so new rows get unique ids.
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('"MasterTask"', 'id')::regclass,
      (SELECT COALESCE(MAX(id), 1) FROM "MasterTask")
    )
  `);

  const hoProperty = await prisma.property.upsert({
    where: {
      name: "HO"
    },
    update: {
      name: "HO"
    },
    create: {
      name: "HO"
    }
  });

  const hoFloor = await prisma.propertyFloor.upsert({
    where: {
      propertyId_floorNo: {
        propertyId: hoProperty.id,
        floorNo: 1
      }
    },
    update: {},
    create: {
      propertyId: hoProperty.id,
      floorNo: 1
    }
  });

  await prisma.propertyDepartment.upsert({
    where: {
      propertyId_name: {
        propertyId: hoProperty.id,
        name: "housekeeping"
      }
    },
    update: {},
    create: {
      propertyId: hoProperty.id,
      name: "housekeeping"
    }
  });

  const housekeepingZones = [
    "WASHROOMS Male / Female",
    "DIRECTOR CABINS AD",
    "EMPLOYEE DESKS",
    "HR Desk",
    "Reception Area",
    "DIRECTOR CABINS PB",
    "COMMON AREA",
    "CEO CABIN",
    "Ajnkya Sir Cabin",
    "CONFERENCE ROOM",
    "PANTRY",
    "VIP ROOM",
    "DIRECTOR CABINS PD",
    "Outside Main Door",
    "Common Task",
    "Common Task 10 to 5",
    "Deep Clean"
  ];

  await prisma.propertyFloorZone.deleteMany({
    where: {
      propertyFloorId: hoFloor.id,
      zone: {
        notIn: housekeepingZones
      }
    }
  });

  for (const zone of housekeepingZones) {
    await prisma.propertyFloorZone.upsert({
      where: {
        propertyFloorId_zone: {
          propertyFloorId: hoFloor.id,
          zone
        }
      },
      update: {},
      create: {
        propertyFloorId: hoFloor.id,
        zone
      }
    });
  }

  const staffUser = await prisma.user.findUnique({
    where: { email: "staff@madhuban360.com" }
  });
  if (staffUser) {
    for (let d = 1; d <= 20; d++) {
      const workDate = normalizeToDayIST(
        new Date(`2026-04-${String(d).padStart(2, "0")}T12:00:00+05:30`)
      );
      const absent = d % 8 === 0;
      await prisma.staffAttendance.upsert({
        where: {
          staffId_workDate: { staffId: staffUser.id, workDate }
        },
        update: { status: absent ? "ABSENT" : "PRESENT" },
        create: {
          staffId: staffUser.id,
          workDate,
          status: absent ? "ABSENT" : "PRESENT"
        }
      });
    }

    const sampleTask = await prisma.dailyStaffTask.findFirst({
      where: { staffId: staffUser.id },
      orderBy: { id: "asc" }
    });
    if (sampleTask) {
      await prisma.taskApproval.upsert({
        where: { dailyStaffTaskId: sampleTask.id },
        update: {
          status: "APPROVED",
          decidedAt: new Date(),
          decisionNote: "Well done, all areas clean",
          rating: 5
        },
        create: {
          dailyStaffTaskId: sampleTask.id,
          staffId: staffUser.id,
          supervisorId: supervisor.id,
          status: "APPROVED",
          decidedAt: new Date(),
          decisionNote: "Well done, all areas clean",
          rating: 5
        }
      });
    }
  }

  console.log("Seed completed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
