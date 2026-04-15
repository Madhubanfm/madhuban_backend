import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const property = await prisma.property.findUnique({ where: { name: "HO" } });
  if (!property) {
    console.log({ message: "Property HO not found." });
    return;
  }

  const floor = await prisma.propertyFloor.findUnique({
    where: { propertyId_floorNo: { propertyId: property.id, floorNo: 1 } }
  });
  if (!floor) {
    console.log({ message: "HO floorNo=1 not found." });
    return;
  }

  const zones = await prisma.propertyFloorZone.findMany({
    where: { propertyFloorId: floor.id },
    orderBy: { zone: "asc" },
    select: { zone: true }
  });

  console.log({
    property: { id: property.id, name: property.name },
    floor: { id: floor.id, floorNo: floor.floorNo },
    count: zones.length,
    zones: zones.map((z) => z.zone)
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

