import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { buildPublicUrl } from "@/lib/s3";

function getIntId(value: string) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function POST(req: Request, ctx: { params: Promise<{ dailyTaskId: string }> }) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.STAFF) return Response.json({ message: "Not allowed." }, { status: 403 });

  const { dailyTaskId } = await ctx.params;
  const id = getIntId(dailyTaskId);
  if (!id) return Response.json({ message: "Invalid dailyTaskId." }, { status: 400 });

  const rows = await prisma.$queryRaw<
    Array<{
      id: number;
      staffId: number;
      status: string;
      beforePhotoUrl: string | null;
      supervisorId: number | null;
    }>
  >(
    Prisma.sql`
      SELECT dst.id, dst."staffId", dst."status", dst."beforePhotoUrl", u."supervisorId"
      FROM "DailyStaffTask" dst
      INNER JOIN "User" u ON u.id = dst."staffId"
      WHERE dst.id = ${id}
      LIMIT 1
    `
  );
  const task = rows[0];
  if (!task || task.staffId !== user.userId) {
    return Response.json({ message: "Task not found." }, { status: 404 });
  }

  if (task.status === "COMPLETED" || task.status === "APPROVED") {
    return Response.json({ message: "Task already completed. Reattempt is not allowed." }, { status: 409 });
  }

  if (!task.beforePhotoUrl) {
    return Response.json({ message: "Before photo is required first." }, { status: 400 });
  }

  const supervisorId = task.supervisorId;
  if (!supervisorId) {
    return Response.json({ message: "Supervisor not assigned for this staff." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ message: "Expected JSON body." }, { status: 400 });
  }

  const photoKey = typeof body.photoKey === "string" ? body.photoKey.trim() : "";
  if (!photoKey) {
    return Response.json({ message: "photoKey is required." }, { status: 400 });
  }
  if (!photoKey.startsWith(`tasks/${id}/after/`)) {
    return Response.json({ message: "Invalid photoKey." }, { status: 400 });
  }

  const afterPhotoUrl = buildPublicUrl(photoKey);

  let result: { updatedTask: { id: number; status: string; afterPhotoUrl: string | null }; approval: { id: number; status: string; supervisorId: number } };
  try {
    result = await prisma.$transaction(async (tx) => {
      const updatedTask = await tx.dailyStaffTask.update({
        where: { id },
        data: { afterPhotoUrl, status: "IN_REVIEW" },
        select: { id: true, status: true, afterPhotoUrl: true }
      });

      const approval = await tx.taskApproval.upsert({
        where: { dailyStaffTaskId: id },
        update: { supervisorId, status: "PENDING", decisionNote: null, decidedAt: null },
        create: { dailyStaffTaskId: id, staffId: task.staffId, supervisorId, status: "PENDING" },
        select: { id: true, status: true, supervisorId: true }
      });

      return { updatedTask, approval };
    });
  } catch {
    return Response.json({ message: "Internal error." }, { status: 500 });
  }

  return Response.json({
    data: {
      afterPhotoUrl: result.updatedTask.afterPhotoUrl,
      task: { id: result.updatedTask.id, status: result.updatedTask.status },
      approval: { id: result.approval.id, status: result.approval.status, supervisorId: result.approval.supervisorId }
    }
  });
}
