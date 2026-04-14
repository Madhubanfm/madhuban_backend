import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { parseDateParam } from "@/lib/request-date";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const statusSchema = z.enum(["needs_review", "sent_back", "approved", "all"]);
const prioritySchema = z.enum(["CRITICAL", "HIGH"]);

const querySchema = z.object({
  date: z.string().optional(),
  status: statusSchema.optional(),
  q: z.string().optional(),
  priority: prioritySchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

type ReviewRow = {
  approvalId: number;
  approvalStatus: string;
  submittedAt: Date;
  dailyTaskId: number;
  beforePhotoUrl: string | null;
  afterPhotoUrl: string | null;
  staffId: number;
  staffName: string;
  taskTitle: string;
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

function statusWhereSql(status: z.infer<typeof statusSchema> | undefined) {
  if (!status || status === "all") return Prisma.sql``;
  if (status === "needs_review") return Prisma.sql` AND ta."status" = 'PENDING' `;
  if (status === "sent_back") return Prisma.sql` AND ta."status" = 'REJECTED' `;
  if (status === "approved") return Prisma.sql` AND ta."status" = 'APPROVED' `;
  return Prisma.sql``;
}

function priorityWhereSql(priority: z.infer<typeof prioritySchema> | undefined) {
  if (!priority) return Prisma.sql``;
  return Prisma.sql` AND mt."priority" = ${priority} `;
}

function searchWhereSql(q: string | undefined) {
  const trimmed = q?.trim();
  if (!trimmed) return Prisma.sql``;
  const like = `%${trimmed}%`;
  return Prisma.sql`
    AND (
      mt."title" ILIKE ${like}
      OR COALESCE(z."zone", '') ILIKE ${like}
      OR staff."name" ILIKE ${like}
    )
  `;
}

function deadlineIsoFromTimePortion(taskDate: Date, timePortionText: string | null): string | null {
  if (!timePortionText) return null;
  // timePortionText example: "08:30:00" (from ::text)
  const t = timePortionText.trim();
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const hh = m[1]!;
  const mm = m[2]!;
  const ss = m[3] ?? "00";
  const y = taskDate.getUTCFullYear();
  const mo = String(taskDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(taskDate.getUTCDate()).padStart(2, "0");
  return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}+05:30`).toISOString();
}

function overdueLabel(taskDate: Date, endTimeText: string | null, now: Date): string | null {
  const deadlineIso = deadlineIsoFromTimePortion(taskDate, endTimeText);
  if (!deadlineIso) return null;
  const deadline = new Date(deadlineIso);
  const diffMin = (deadline.getTime() - now.getTime()) / 60000;
  if (diffMin < 0) {
    const overdueMin = Math.max(1, Math.min(Math.ceil(-diffMin), 999));
    return `${overdueMin}m overdue`;
  }
  return null;
}

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.SUPERVISOR) return Response.json({ message: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    priority: url.searchParams.get("priority") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined
  });
  if (!parsed.success) {
    return Response.json({ message: "Invalid query params." }, { status: 400 });
  }

  let date: Date;
  try {
    date = parseDateParam(url.searchParams.get("date"));
  } catch {
    return Response.json({ message: "Invalid date. Use YYYY-MM-DD or ISO date." }, { status: 400 });
  }

  const supervisorId = user.userId;
  const taskDate = normalizeToDayIST(date);
  const status = parsed.data.status ?? "needs_review";
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 20;
  const offset = (page - 1) * limit;

  const baseFromSql = Prisma.sql`
    FROM "TaskApproval" ta
    INNER JOIN "DailyStaffTask" dst ON dst.id = ta."dailyStaffTaskId"
    INNER JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
    INNER JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
    INNER JOIN "User" staff ON staff.id = dst."staffId"
    LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
    LEFT JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
    LEFT JOIN "Property" p ON p.id = f."propertyId"
    WHERE ta."supervisorId" = ${supervisorId}
      AND dst."taskDate" = ${taskDate}
  `;

  const filtersSql = Prisma.sql`
    ${statusWhereSql(status)}
    ${priorityWhereSql(parsed.data.priority)}
    ${searchWhereSql(parsed.data.q)}
  `;

  const [rows, totalResult, countsResult] = await Promise.all([
    prisma.$queryRaw<ReviewRow[]>`
      SELECT
        ta.id AS "approvalId",
        ta."status" AS "approvalStatus",
        ta."submittedAt" AS "submittedAt",
        dst.id AS "dailyTaskId",
        dst."beforePhotoUrl" AS "beforePhotoUrl",
        dst."afterPhotoUrl" AS "afterPhotoUrl",
        staff.id AS "staffId",
        staff."name" AS "staffName",
        mt."title" AS "taskTitle",
        mt."priority" AS "priority",
        mt."startTime"::text AS "startTime",
        mt."endTime"::text AS "endTime",
        mt."zoneId" AS "zoneId",
        z."zone" AS "zoneName",
        f."floorNo" AS "floorNo",
        p."name" AS "propertyName"
      ${baseFromSql}
      ${filtersSql}
      ORDER BY ta."submittedAt" DESC, ta.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      ${baseFromSql}
      ${filtersSql}
    `,
    prisma.$queryRaw<Array<{ needsReview: bigint; sentBack: bigint; approved: bigint }>>`
      SELECT
        COUNT(*) FILTER (WHERE ta."status" = 'PENDING')::bigint AS "needsReview",
        COUNT(*) FILTER (WHERE ta."status" = 'REJECTED')::bigint AS "sentBack",
        COUNT(*) FILTER (WHERE ta."status" = 'APPROVED')::bigint AS "approved"
      ${baseFromSql}
    `
  ]);

  const total = Number(totalResult?.[0]?.count ?? BigInt(0));
  const countsRow = countsResult?.[0];
  const counts = {
    needsReview: Number(countsRow?.needsReview ?? BigInt(0)),
    sentBack: Number(countsRow?.sentBack ?? BigInt(0)),
    approved: Number(countsRow?.approved ?? BigInt(0))
  };

  const now = new Date();

  return Response.json({
    data: {
      date: taskDate.toISOString(),
      status,
      counts,
      items: rows.map((r) => ({
        approvalId: r.approvalId,
        dailyTaskId: r.dailyTaskId,
        approvalStatus: r.approvalStatus,
        submittedAt: r.submittedAt.toISOString(),
        overdueLabel: overdueLabel(taskDate, r.endTime, now),
        task: {
          title: r.taskTitle,
          priority: r.priority,
          startTime: r.startTime,
          endTime: r.endTime
        },
        maker: {
          staffId: r.staffId,
          name: r.staffName,
          initials: initialsFromName(r.staffName)
        },
        zone: {
          zoneId: r.zoneId,
          zoneName: r.zoneName,
          floorNo: r.floorNo,
          propertyName: r.propertyName
        },
        photos: {
          beforePhotoUrl: r.beforePhotoUrl,
          afterPhotoUrl: r.afterPhotoUrl
        }
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    }
  });
}

