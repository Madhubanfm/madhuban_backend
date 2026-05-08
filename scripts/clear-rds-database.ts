import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function clearDatabase() {
  try {
    console.log("🗑️  Starting to clear all data from RDS database...\n");

    // Delete in reverse order of foreign key dependencies
    console.log("⏳ Deleting TaskApproval...");
    await prisma.taskApproval.deleteMany({});
    console.log("✅ TaskApproval cleared");

    console.log("⏳ Deleting DailyStaffTask...");
    await prisma.dailyStaffTask.deleteMany({});
    console.log("✅ DailyStaffTask cleared");

    console.log("⏳ Deleting StaffMasterTask...");
    await prisma.staffMasterTask.deleteMany({});
    console.log("✅ StaffMasterTask cleared");

    console.log("⏳ Deleting MasterTask...");
    await prisma.masterTask.deleteMany({});
    console.log("✅ MasterTask cleared");

    console.log("⏳ Deleting StaffAttendance...");
    await prisma.staffAttendance.deleteMany({});
    console.log("✅ StaffAttendance cleared");

    console.log("⏳ Deleting PropertyFloorZone...");
    await prisma.propertyFloorZone.deleteMany({});
    console.log("✅ PropertyFloorZone cleared");

    console.log("⏳ Deleting PropertyFloor...");
    await prisma.propertyFloor.deleteMany({});
    console.log("✅ PropertyFloor cleared");

    console.log("⏳ Deleting PropertyDepartment...");
    await prisma.propertyDepartment.deleteMany({});
    console.log("✅ PropertyDepartment cleared");

    console.log("⏳ Deleting Property...");
    await prisma.property.deleteMany({});
    console.log("✅ Property cleared");

    console.log("⏳ Deleting User...");
    await prisma.user.deleteMany({});
    console.log("✅ User cleared");

    console.log("⏳ Deleting Role...");
    await prisma.role.deleteMany({});
    console.log("✅ Role cleared");

    console.log("\n✅ All data deleted successfully!");
    console.log("📋 You can now run: npm run prisma:seed");
  } catch (error) {
    console.error("\n❌ Error clearing database:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

clearDatabase();
