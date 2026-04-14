import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";
import { parseDateParam } from "@/lib/request-date";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const filterSchema = z.enum(["all", "critical", "high", "done"]);

const querySchema = z.object({
  supervisorId: z.coerce.number().int().min(1),
  date: z.string().optional(),
  filter: filterSchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

type TaskRow = {
  dailyTaskId: number;
  status: string;
  taskDate: Date;
  approvalStatus: string | null;
  decisionNote: string | null;
  masterTaskId: number;
  title: string;
  description: string | null;
  priority: string | null;
  startTime: string | null;
  endTime: string | null;
  zoneId: number | null;
  zone: string | null;
  propertyId: number | null;
  propertyName: string | null;
  floorNo: number | null;
};

function buildWhereSql(filter: z.infer<typeof filterSchema> | undefined) {
  if (!filter || filter === "all") return Prisma.sql``;
  if (filter === "done") return Prisma.sql` AND dst."status" = 'COMPLETED' `;
  if (filter === "critical") return Prisma.sql` AND mt."priority" = 'CRITICAL' `;
  if (filter === "high") return Prisma.sql` AND mt."priority" = 'HIGH' `;
  return Prisma.sql``;
}

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.MANAGER) return Response.json({ message: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    supervisorId: url.searchParams.get("supervisorId") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
    filter: url.searchParams.get("filter") ?? undefined,
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

  const managerId = user.userId;
  const supervisorId = parsed.data.supervisorId;
  const taskDate = normalizeToDayIST(date);
  const filter = parsed.data.filter ?? "all";
  const page = parsed.data.page ?? 1;
  const limit = parsed.data.limit ?? 20;
  const offset = (page - 1) * limit;

  const supervisor = await prisma.user.findUnique({
    where: { id: supervisorId },
    select: {
      id: true,
      managerId: true,
      role: { select: { name: true } }
    }
  });
  if (!supervisor) return Response.json({ message: "Supervisor not found." }, { status: 404 });
  if (supervisor.role?.name !== ROLE_NAMES.SUPERVISOR) {
    return Response.json({ message: "Invalid supervisorId." }, { status: 400 });
  }
  if (supervisor.managerId !== managerId) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  const filterSql = buildWhereSql(filter);

  const baseFromSql = Prisma.sql`
    FROM "DailyStaffTask" dst
    JOIN "User" staff ON staff.id = dst."staffId"
    JOIN "StaffMasterTask" smt ON smt.id = dst."staffMasterTaskId"
    JOIN "MasterTask" mt ON mt.id = smt."masterTaskId"
    LEFT JOIN "TaskApproval" ta ON ta."dailyStaffTaskId" = dst.id
    LEFT JOIN "PropertyFloorZone" z ON z.id = mt."zoneId"
    LEFT JOIN "PropertyFloor" f ON f.id = z."propertyFloorId"
    LEFT JOIN "Property" p ON p.id = f."propertyId"
    WHERE staff."supervisorId" = ${supervisorId}
      AND dst."taskDate" = ${taskDate}
  `;

  const [rows, totalResult, allCountResult, criticalCountResult, highCountResult, doneCountResult] =
    await Promise.all([
      prisma.$queryRaw<TaskRow[]>`
        SELECT
          dst.id AS "dailyTaskId",
          dst."status" AS "status",
          dst."taskDate" AS "taskDate",
          ta."status" AS "approvalStatus",
          ta."decisionNote" AS "decisionNote",
          mt.id AS "masterTaskId",
          mt."title" AS "title",
          mt."description" AS "description",
          mt."priority" AS "priority",
          mt."startTime"::text AS "startTime",
          mt."endTime"::text AS "endTime",
          mt."zoneId" AS "zoneId",
          z."zone" AS "zone",
          p.id AS "propertyId",
          p."name" AS "propertyName",
          f."floorNo" AS "floorNo"
        ${baseFromSql}
        ${filterSql}
        ORDER BY mt."startTime" ASC NULLS LAST, mt.id ASC, dst.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        ${baseFromSql}
        ${filterSql}
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        ${baseFromSql}
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        ${baseFromSql}
          AND mt."priority" = 'CRITICAL'
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        ${baseFromSql}
          AND mt."priority" = 'HIGH'
      `,
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        ${baseFromSql}
          AND dst."status" = 'COMPLETED'
      `
    ]);

  const total = Number(totalResult?.[0]?.count ?? BigInt(0));
  const allCount = Number(allCountResult?.[0]?.count ?? BigInt(0));
  const criticalCount = Number(criticalCountResult?.[0]?.count ?? BigInt(0));
  const highCount = Number(highCountResult?.[0]?.count ?? BigInt(0));
  const doneCount = Number(doneCountResult?.[0]?.count ?? BigInt(0));
  const shiftProgressPercent = allCount > 0 ? Math.round((doneCount / allCount) * 100) : 0;

  return Response.json({
    data: {
      date: taskDate.toISOString(),
      supervisorId,
      filter,
      counts: {
        all: allCount,
        critical: criticalCount,
        high: highCount,
        done: doneCount
      },
      progress: {
        done: doneCount,
        total: allCount,
        percent: shiftProgressPercent
      },
      tasks: rows.map((r) => ({
        id: r.dailyTaskId,
        status: r.status,
        taskDate: r.taskDate,
        approval: r.approvalStatus
          ? {
              status: r.approvalStatus,
              decisionNote: r.decisionNote
            }
          : null,
        masterTask: {
          id: r.masterTaskId,
          title: r.title,
          description: r.description,
          priority: r.priority,
          startTime: r.startTime,
          endTime: r.endTime,
          zoneId: r.zoneId,
          zone: r.zone
        },
        location: {
          propertyId: r.propertyId,
          propertyName: r.propertyName,
          floorNo: r.floorNo
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

