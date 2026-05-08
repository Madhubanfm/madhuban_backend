import { PrismaClient } from "@prisma/client";

// Neon database client
const neonPrisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://neondb_owner:npg_rtJmMA0cx8Gl@ep-lingering-shadow-a1eyp6il-pooler.ap-southeast-1.aws.neon.tech/msdhuban_28mar?sslmode=require&channel_binding=require",
    },
  },
});

// RDS database client (uses DATABASE_URL from .env)
const rdsPrisma = new PrismaClient();

async function syncTable(
  tableName: string,
  neonData: any[],
  callback: (item: any) => Promise<void>
) {
  console.log(`\n📋 Syncing ${tableName}... (${neonData.length} records)`);
  let syncedCount = 0;
  for (let i = 0; i < neonData.length; i++) {
    try {
      await callback(neonData[i]);
      syncedCount++;
      if ((i + 1) % 50 === 0) {
        console.log(`  ✓ ${i + 1}/${neonData.length}`);
      }
    } catch (error: any) {
      console.error(`  ⚠️  Error on record ${i + 1}:`, error.message);
    }
  }
  console.log(`✅ ${tableName} synced (${syncedCount}/${neonData.length} successful)`);
}

async function syncData() {
  try {
    console.log("🚀 Starting data sync from Neon to RDS...\n");

    // 1. Sync Roles (no dependencies)
    const roles = await neonPrisma.role.findMany();
    await syncTable("Roles", roles, async (role) => {
      await rdsPrisma.role.upsert({
        where: { id: role.id },
        update: role,
        create: role,
      });
    });

    // 2. Sync Users (depends on Roles)
    const users = await neonPrisma.user.findMany();
    await syncTable("Users", users, async (user) => {
      await rdsPrisma.user.upsert({
        where: { id: user.id },
        update: user,
        create: user,
      });
    });

    // 3. Sync Properties (no dependencies)
    const properties = await neonPrisma.property.findMany();
    await syncTable("Properties", properties, async (property) => {
      await rdsPrisma.property.upsert({
        where: { id: property.id },
        update: property,
        create: property,
      });
    });

    // 4. Sync PropertyDepartments (depends on Properties)
    const departments = await neonPrisma.propertyDepartment.findMany();
    await syncTable("PropertyDepartments", departments, async (dept) => {
      await rdsPrisma.propertyDepartment.upsert({
        where: { id: dept.id },
        update: dept,
        create: dept,
      });
    });

    // 5. Sync PropertyFloors (depends on Properties)
    const propertyFloors = await neonPrisma.propertyFloor.findMany();
    await syncTable("PropertyFloors", propertyFloors, async (floor) => {
      await rdsPrisma.propertyFloor.upsert({
        where: { id: floor.id },
        update: floor,
        create: floor,
      });
    });

    // 6. Sync PropertyFloorZones (depends on PropertyFloors)
    const zones = await neonPrisma.propertyFloorZone.findMany();
    await syncTable("PropertyFloorZones", zones, async (zone) => {
      await rdsPrisma.propertyFloorZone.upsert({
        where: { id: zone.id },
        update: zone,
        create: zone,
      });
    });

    // 7. Sync MasterTasks (depends on PropertyFloorZones and Users)
    const masterTasks = await neonPrisma.masterTask.findMany();
    await syncTable("MasterTasks", masterTasks, async (task) => {
      await rdsPrisma.masterTask.upsert({
        where: { id: task.id },
        update: task,
        create: task,
      });
    });

    // 8. Sync StaffMasterTasks (depends on MasterTasks and Users)
    const staffMasterTasks = await neonPrisma.staffMasterTask.findMany();
    await syncTable("StaffMasterTasks", staffMasterTasks, async (smt) => {
      await rdsPrisma.staffMasterTask.upsert({
        where: { id: smt.id },
        update: smt,
        create: smt,
      });
    });

    // 9. Sync DailyStaffTasks (depends on StaffMasterTasks and Users)
    const dailyTasks = await neonPrisma.dailyStaffTask.findMany();
    await syncTable("DailyStaffTasks", dailyTasks, async (task) => {
      await rdsPrisma.dailyStaffTask.upsert({
        where: { id: task.id },
        update: task,
        create: task,
      });
    });

    // 10. Sync TaskApproval (depends on DailyStaffTasks)
    const approvals = await neonPrisma.taskApproval.findMany();
    await syncTable("TaskApproval", approvals, async (approval) => {
      await rdsPrisma.taskApproval.upsert({
        where: { id: approval.id },
        update: approval,
        create: approval,
      });
    });

    // 11. Sync StaffAttendance (depends on Users)
    const attendance = await neonPrisma.staffAttendance.findMany();
    await syncTable("StaffAttendance", attendance, async (att) => {
      await rdsPrisma.staffAttendance.upsert({
        where: { id: att.id },
        update: att,
        create: att,
      });
    });

    console.log("\n✅ All data synced successfully from Neon to RDS!");
    console.log("🎉 You can now use RDS as your primary database");
  } catch (error) {
    console.error("\n❌ Sync failed:", error);
    process.exit(1);
  } finally {
    await neonPrisma.$disconnect();
    await rdsPrisma.$disconnect();
  }
}

syncData();
