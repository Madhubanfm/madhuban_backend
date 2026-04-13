-- AlterTable
ALTER TABLE "MasterTask" ADD COLUMN     "zoneId" INTEGER,
ADD COLUMN     "priority" TEXT,
ADD COLUMN     "startTime" TIME(6),
ADD COLUMN     "endTime" TIME(6),
ADD COLUMN     "materials" JSONB;

-- CreateIndex
CREATE INDEX "MasterTask_zoneId_idx" ON "MasterTask"("zoneId");

-- AddForeignKey
ALTER TABLE "MasterTask" ADD CONSTRAINT "MasterTask_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "PropertyFloorZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
