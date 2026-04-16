import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const schema = z.object({
  staffId: z.number().int().positive(),
  masterTaskId: z.number().int().positive(),
  startDate: z.string().min(1),
  endDate: z.string().min(1)
});

const getQuerySchema = z.object({
  staffId: z.coerce.number().int().positive().optional(),
  staff: z.coerce.number().int().positive().optional(),
  startDate: z.string().min(1).optional()
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsedQuery = getQuerySchema.safeParse({
    staffId: url.searchParams.get("staffId") ?? undefined,
    staff: url.searchParams.get("staff") ?? undefined,
    startDate: url.searchParams.get("startDate") ?? undefined
  });

  if (!parsedQuery.success) {
    return Response.json({ message: "Invalid query params." }, { status: 400 });
  }

  const staffId = parsedQuery.data.staffId ?? parsedQuery.data.staff;

  let day: Date | undefined;
  if (parsedQuery.data.startDate) {
    const d = new Date(parsedQuery.data.startDate);
    if (Number.isNaN(d.getTime())) {
      return Response.json({ message: "Invalid startDate." }, { status: 400 });
    }
    day = normalizeToDayIST(d);
  }

  const assignments = await prisma.staffMasterTask.findMany({
    orderBy: { id: "desc" },
    where: {
      ...(staffId ? { staffId } : {}),
      ...(day
        ? {
            startDate: { lte: day },
            endDate: { gte: day }
          }
        : {})
    },
    select: {
      id: true,
      staffId: true,
      masterTaskId: true,
      startDate: true,
      endDate: true,
      masterTask: true
    }
  });

  return Response.json({ data: assignments });
}

export async function POST(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }

  const allowedRoles: string[] = [ROLE_NAMES.ADMIN, ROLE_NAMES.MANAGER, ROLE_NAMES.SUPERVISOR];
  if (!allowedRoles.includes(user.role)) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  const body = await req.json();
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const startDate = new Date(parsed.data.startDate);
  const endDate = new Date(parsed.data.endDate);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return Response.json({ message: "Invalid startDate or endDate." }, { status: 400 });
  }

  const startDay = normalizeToDayIST(startDate);
  const endDay = normalizeToDayIST(endDate);

  if (startDay > endDay) {
    return Response.json({ message: "startDate must be before or equal to endDate." }, { status: 400 });
  }

  const staff = await prisma.user.findUnique({
    where: { id: parsed.data.staffId },
    include: { role: true, supervisor: true }
  });

  if (!staff || staff.role.name !== ROLE_NAMES.STAFF) {
    return Response.json({ message: "Invalid staff user." }, { status: 400 });
  }

  if (user.role === ROLE_NAMES.SUPERVISOR && staff.supervisorId !== user.userId) {
    return Response.json({ message: "Supervisor can only assign own staff." }, { status: 403 });
  }

  if (
    user.role === ROLE_NAMES.MANAGER &&
    (!staff.supervisor || staff.supervisor.managerId !== user.userId)
  ) {
    return Response.json({ message: "Manager can only assign staff under own supervisors." }, { status: 403 });
  }

  const task = await prisma.masterTask.findUnique({ where: { id: parsed.data.masterTaskId } });
  if (!task) {
    return Response.json({ message: "Master task not found." }, { status: 404 });
  }

  const assignment = await prisma.$transaction(async (tx) => {
    const created = await tx.staffMasterTask.create({
      data: {
        staffId: parsed.data.staffId,
        masterTaskId: parsed.data.masterTaskId,
        startDate: startDay,
        endDate: endDay
      }
    });

    // Ensure the task is available immediately for the provided startDate.
    await tx.dailyStaffTask.upsert({
      where: {
        staffMasterTaskId_taskDate: {
          staffMasterTaskId: created.id,
          taskDate: startDay
        }
      },
      update: {},
      create: {
        staffMasterTaskId: created.id,
        staffId: parsed.data.staffId,
        taskDate: startDay,
        status: "PENDING"
      }
    });

    return created;
  });

  return Response.json({ message: "Task assigned to staff.", data: assignment }, { status: 201 });
}
