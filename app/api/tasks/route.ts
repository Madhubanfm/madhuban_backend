import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional()
});

export async function GET() {
  const tasks = await prisma.masterTask.findMany({
    orderBy: { id: "desc" },
    include: {
      createdByAdmin: {
        select: { id: true, name: true, email: true }
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

  const task = await prisma.masterTask.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      createdByAdminId: user.userId
    }
  });

  return Response.json({ message: "Master task created.", data: task }, { status: 201 });
}
