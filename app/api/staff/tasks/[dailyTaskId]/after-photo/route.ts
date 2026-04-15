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
      beforePhotoUrl: string | null;
      supervisorId: number | null;
    }>
  >(
    Prisma.sql`
      SELECT dst.id, dst."staffId", dst."beforePhotoUrl", u."supervisorId"
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

  const buf = Buffer.from(await photo.arrayBuffer());
  if (buf.length === 0) {
    return Response.json({ message: "Empty file." }, { status: 400 });
  }

  const key = buildTaskPhotoKey({ dailyTaskId: id, kind: "after", ext });
  const afterPhotoUrl = await uploadBufferToS3({ key, contentType: photo.type, body: buf });

  const approvalRows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`
        UPDATE "DailyStaffTask"
        SET "afterPhotoUrl" = ${afterPhotoUrl}, "status" = 'IN_REVIEW', "updatedAt" = NOW()
        WHERE id = ${id} AND "staffId" = ${user.userId}
      `
    );

    return tx.$queryRaw<Array<{ id: number; status: string; supervisorId: number }>>(
      Prisma.sql`
        INSERT INTO "TaskApproval" ("dailyStaffTaskId", "staffId", "supervisorId", "status")
        VALUES (${id}, ${task.staffId}, ${supervisorId}, 'PENDING')
        ON CONFLICT ("dailyStaffTaskId") DO UPDATE SET
          "supervisorId" = EXCLUDED."supervisorId",
          "status" = 'PENDING',
          "decisionNote" = NULL,
          "decidedAt" = NULL
        RETURNING id, "status", "supervisorId"
      `
    );
  });

  const approval = approvalRows[0];
  if (!approval) {
    return Response.json({ message: "Failed to create approval." }, { status: 500 });
  }

  return Response.json({
    data: {
      afterPhotoUrl,
      approval: {
        id: approval.id,
        status: approval.status,
        supervisorId: approval.supervisorId
      }
    }
  });
}
