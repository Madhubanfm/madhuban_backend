-- CreateTable
CREATE TABLE "TaskApproval" (
    "id" SERIAL NOT NULL,
    "dailyStaffTaskId" INTEGER NOT NULL,
    "staffId" INTEGER NOT NULL,
    "supervisorId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "TaskApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskApproval_dailyStaffTaskId_key" ON "TaskApproval"("dailyStaffTaskId");

-- CreateIndex
CREATE INDEX "TaskApproval_supervisorId_idx" ON "TaskApproval"("supervisorId");

-- CreateIndex
CREATE INDEX "TaskApproval_status_idx" ON "TaskApproval"("status");

-- AddForeignKey
ALTER TABLE "TaskApproval" ADD CONSTRAINT "TaskApproval_dailyStaffTaskId_fkey" FOREIGN KEY ("dailyStaffTaskId") REFERENCES "DailyStaffTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
