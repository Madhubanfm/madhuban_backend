import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";

function parseTimeInput(value: string): Date {
  const trimmed = value.trim();
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) {
    return new Date(
      Date.UTC(
        1970,
        0,
        1,
        iso.getUTCHours(),
        iso.getUTCMinutes(),
        iso.getUTCSeconds(),
        iso.getUTCMilliseconds()
      )
    );
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!m) {
    throw new Error("invalid");
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  if (h > 23 || min > 59 || sec > 59) {
    throw new Error("invalid");
  }
  return new Date(Date.UTC(1970, 0, 1, h, min, sec, 0));
}

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  zoneId: z.union([z.number().int().positive(), z.null()]).optional(),
  priority: z.union([z.string().min(1).max(64), z.null()]).optional(),
  startTime: z.union([z.string().min(1), z.null()]).optional(),
  endTime: z.union([z.string().min(1), z.null()]).optional(),
  materials: z.union([z.array(z.string()), z.null()]).optional()
});

export async function GET() {
  const tasks = await prisma.masterTask.findMany({
    orderBy: { id: "desc" },
    include: {
      createdByAdmin: {
        select: { id: true, name: true, email: true }
      },
      zone: {
        select: { id: true, zone: true, propertyFloorId: true }
      }
    }
  });

  return Response.json({
    data: tasks
  });
}

export async function POST(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }

  if (user.role !== ROLE_NAMES.ADMIN) {
    return Response.json({ message: "Only admin can create master tasks." }, { status: 403 });
  }

  const body = await req.json();
  const parsed = createTaskSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  let startTime: Date | null | undefined;
  let endTime: Date | null | undefined;
  try {
    if (parsed.data.startTime === null) {
      startTime = null;
    } else if (parsed.data.startTime !== undefined) {
      startTime = parseTimeInput(parsed.data.startTime);
    }
    if (parsed.data.endTime === null) {
      endTime = null;
    } else if (parsed.data.endTime !== undefined) {
      endTime = parseTimeInput(parsed.data.endTime);
    }
  } catch {
    return Response.json(
      { message: "Invalid startTime or endTime. Use ISO datetime or HH:mm." },
      { status: 400 }
    );
  }

  if (parsed.data.zoneId != null) {
    const zone = await prisma.propertyFloorZone.findUnique({
      where: { id: parsed.data.zoneId }
    });
    if (!zone) {
      return Response.json({ message: "Zone not found." }, { status: 400 });
    }
  }

  const d = parsed.data;
  const task = await prisma.masterTask.create({
    data: {
      title: d.title,
      description: d.description,
      createdByAdminId: user.userId,
      ...(d.zoneId !== undefined ? { zoneId: d.zoneId } : {}),
      ...(d.priority !== undefined ? { priority: d.priority } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      ...(d.materials !== undefined
        ? {
            materials: d.materials === null ? Prisma.DbNull : d.materials
          }
        : {})
    },
    include: {
      zone: {
        select: { id: true, zone: true, propertyFloorId: true }
      }
    }
  });

  return Response.json({ message: "Master task created.", data: task }, { status: 201 });
}
