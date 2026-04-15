import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const schema = z.object({
  staffId: z.number().int().positive(),
  masterTaskId: z.number().int().positive(),
  startDate: z.string().min(1),
  endDate: z.string().min(1)
});

export async function GET() {
  const assignments = await prisma.staffMasterTask.findMany({
    orderBy: { id: "desc" },
    include: {
      staff: {
        select: {
          id: true,
          name: true,
          email: true,
          supervisor: { select: { id: true, name: true, email: true } }
        }
      },
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

  if (startDate > endDate) {
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

  const assignment = await prisma.staffMasterTask.create({
    data: {
      staffId: parsed.data.staffId,
      masterTaskId: parsed.data.masterTaskId,
      startDate,
      endDate
    }
  });

  return Response.json({ message: "Task assigned to staff.", data: assignment }, { status: 201 });
}
