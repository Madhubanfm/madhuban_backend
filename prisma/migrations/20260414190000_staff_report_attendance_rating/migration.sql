-- AlterTable
ALTER TABLE "TaskApproval" ADD COLUMN "rating" INTEGER;

-- CreateTable
CREATE TABLE "StaffAttendance" (
    "id" SERIAL NOT NULL,
    "staffId" INTEGER NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffAttendance_staffId_workDate_key" ON "StaffAttendance"("staffId", "workDate");

-- CreateIndex
CREATE INDEX "StaffAttendance_staffId_workDate_idx" ON "StaffAttendance"("staffId", "workDate");

-- AddForeignKey
ALTER TABLE "StaffAttendance" ADD CONSTRAINT "StaffAttendance_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
