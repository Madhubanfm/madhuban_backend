import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

function getIntId(value: string) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

type ReviewDetailRow = {
  approvalId: number;
  approvalStatus: string;
  submittedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  rating: number | null;
  supervisorId: number;
  dailyTaskId: number;
  taskDate: Date;
  dstStatus: string;
  startedAt: Date | null;
  completedAt: Date | null;
  beforePhotoUrl: string | null;
  afterPhotoUrl: string | null;
  staffId: number;
  staffName: string;
  staffEmail: string;
  masterTaskId: number;
  taskTitle: string;
  description: string | null;
  priority: string | null;
  startTime: string | null;
  endTime: string | null;
  zoneId: number | null;
  zoneName: string | null;
  floorNo: number | null;
  propertyName: string | null;
};

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
  if (parts.length === 1 && parts[0]!.length >= 2) return parts[0]!.slice(0, 2).toUpperCase();
  return parts[0]?.[0]?.toUpperCase() ?? "?";
}

export async function GET(req: Request, ctx: { params: Promise<{ dailyTaskId: string }> }) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.SUPERVISOR) return Response.json({ message: "Not allowed." }, { status: 403 });

  const { dailyTaskId } = await ctx.params;
  const id = getIntId(dailyTaskId);
  if (!id) return Response.json({ message: "Invalid dailyTaskId." }, { status: 400 });

  const rows = await prisma.$queryRaw<ReviewDetailRow[]>(
    Prisma.sql`
      SELECT
        ta.id AS "approvalId",
        ta."status" AS "approvalStatus",
        ta."submittedAt" AS "submittedAt",
        ta."decidedAt" AS "decidedAt",
        ta."decisionNote" AS "decisionNote",
        ta."rating" AS "rating",
        ta."supervisorId" AS "supervisorId",
        dst.id AS "dailyTaskId",
        dst."taskDate" AS "taskDate",
        dst."status" AS "dstStatus",
        dst."startedAt" AS "startedAt",
        dst."completedAt" AS "completedAt",
        dst."beforePhotoUrl" AS "beforePhotoUrl",
        dst."afterPhotoUrl" AS "afterPhotoUrl",
        staff.id AS "staffId",
        staff."name" AS "staffName",
        staff."email" AS "staffEmail",
        mt.id AS "masterTaskId",
        mt."title" AS "taskTitle",
        mt."description" AS "description",
        mt."priority" AS "priority",
        mt."startTime"::text AS "startTime",
        mt."endTime"::text AS "endTime",
        mt."zoneId" AS "zoneId",
        z."zone" AS "zoneName",
        f."floorNo" AS "floorNo",
        p."name" AS "propertyName"
      FROM "TaskApproval" ta
      INNER JOIN "DailyStaffTask" dst ON dst.id = ta."dailyStaffTaskId"
      INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
      INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
      INNER JOIN "User" staff ON staff.id = dst."staffId"
      LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
      LEFT JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
      LEFT JOIN "Property" p ON p.id = f."propertyId"
      WHERE ta."dailyStaffTaskId" = ${id}
      LIMIT 1
    `
  );

  const row = rows[0];
  if (!row) return Response.json({ message: "Review not found." }, { status: 404 });
  if (row.supervisorId !== user.userId) return Response.json({ message: "Not allowed." }, { status: 403 });

  return Response.json({
    data: {
      dailyTaskId: row.dailyTaskId,
      taskDate: row.taskDate.toISOString(),
      task: {
        id: row.masterTaskId,
        title: row.taskTitle,
        description: row.description,
        priority: row.priority,
        startTime: row.startTime,
        endTime: row.endTime
      },
      zone: {
        zoneId: row.zoneId,
        zoneName: row.zoneName,
        floorNo: row.floorNo,
        propertyName: row.propertyName
      },
      maker: {
        staffId: row.staffId,
        name: row.staffName,
        email: row.staffEmail,
        initials: initialsFromName(row.staffName)
      },
      photos: {
        beforePhotoUrl: row.beforePhotoUrl,
        afterPhotoUrl: row.afterPhotoUrl
      },
      dailyTask: {
        status: row.dstStatus,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null
      },
      approval: {
        id: row.approvalId,
        status: row.approvalStatus,
        submittedAt: row.submittedAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        rating: row.rating
      }
    }
  });
}

