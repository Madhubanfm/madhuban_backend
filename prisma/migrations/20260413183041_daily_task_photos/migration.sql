-- AlterTable
ALTER TABLE "DailyStaffTask" ADD COLUMN     "afterPhotoUrl" TEXT,
ADD COLUMN     "beforePhotoUrl" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);
