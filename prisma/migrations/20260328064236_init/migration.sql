-- CreateTable
CREATE TABLE "Property" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyDepartment" (
    "id" SERIAL NOT NULL,
    "propertyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyFloorZone" (
    "id" SERIAL NOT NULL,
    "propertyFloorId" INTEGER NOT NULL,
    "zone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyFloorZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyFloor" (
    "id" SERIAL NOT NULL,
    "propertyId" INTEGER NOT NULL,
    "floorNo" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyFloor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Property_name_key" ON "Property"("name");

-- CreateIndex
CREATE INDEX "PropertyDepartment_propertyId_idx" ON "PropertyDepartment"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyDepartment_propertyId_name_key" ON "PropertyDepartment"("propertyId", "name");

-- CreateIndex
CREATE INDEX "PropertyFloorZone_propertyFloorId_idx" ON "PropertyFloorZone"("propertyFloorId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyFloorZone_propertyFloorId_zone_key" ON "PropertyFloorZone"("propertyFloorId", "zone");

-- CreateIndex
CREATE INDEX "PropertyFloor_propertyId_idx" ON "PropertyFloor"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyFloor_propertyId_floorNo_key" ON "PropertyFloor"("propertyId", "floorNo");

-- AddForeignKey
ALTER TABLE "PropertyDepartment" ADD CONSTRAINT "PropertyDepartment_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloorZone" ADD CONSTRAINT "PropertyFloorZone_propertyFloorId_fkey" FOREIGN KEY ("propertyFloorId") REFERENCES "PropertyFloor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFloor" ADD CONSTRAINT "PropertyFloor_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
