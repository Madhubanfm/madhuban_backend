import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { buildTaskPhotoKey, uploadBufferToS3 } from "@/lib/s3";

function getIntId(value: string) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function extFromContentType(contentType: string): "jpg" | "png" | null {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  return null;
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

  const form = await req.formData();
  const photo = form.get("photo");
  if (!(photo instanceof File)) {
    return Response.json({ message: "photo file is required." }, { status: 400 });
  }

  const ext = extFromContentType(photo.type);
  if (!ext) {
    return Response.json({ message: "Invalid photo type. Use image/jpeg or image/png." }, { status: 400 });
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(await photo.arrayBuffer());
  } catch {
    return Response.json({ message: "Invalid photo file." }, { status: 400 });
  }
  if (buf.length === 0) {
    return Response.json({ message: "Empty file." }, { status: 400 });
  }

  const key = buildTaskPhotoKey({ dailyTaskId: id, kind: "after", ext });
  let afterPhotoUrl: string;
  try {
    afterPhotoUrl = await uploadBufferToS3({ key, contentType: photo.type, body: buf });
  } catch {
    return Response.json({ message: "Failed to upload photo." }, { status: 502 });
  }

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
