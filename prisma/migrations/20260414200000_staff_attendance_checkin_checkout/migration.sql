-- AlterTable
ALTER TABLE "StaffAttendance" ADD COLUMN     "checkInAt" TIMESTAMP(3),
ADD COLUMN     "checkOutAt" TIMESTAMP(3),
ADD COLUMN     "selfieUrl" TEXT,
ADD COLUMN     "checkInLatitude" DOUBLE PRECISION,
ADD COLUMN     "checkInLongitude" DOUBLE PRECISION,
ADD COLUMN     "checkOutLatitude" DOUBLE PRECISION,
ADD COLUMN     "checkOutLongitude" DOUBLE PRECISION;
