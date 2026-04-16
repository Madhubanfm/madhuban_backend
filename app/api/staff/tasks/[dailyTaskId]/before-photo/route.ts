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

  const rows = await prisma.$queryRaw<Array<{ id: number; staffId: number; status: string }>>(
    Prisma.sql`SELECT id, "staffId", "status" FROM "DailyStaffTask" WHERE id = ${id} LIMIT 1`
  );
  const task = rows[0];
  if (!task || task.staffId !== user.userId) {
    return Response.json({ message: "Task not found." }, { status: 404 });
  }

  if (task.status === "COMPLETED" || task.status === "APPROVED") {
    return Response.json({ message: "Task already completed. Reattempt is not allowed." }, { status: 409 });
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

  const key = buildTaskPhotoKey({ dailyTaskId: id, kind: "before", ext });
  const beforePhotoUrl = await uploadBufferToS3({ key, contentType: photo.type, body: buf });

  const updatedCount = await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "DailyStaffTask"
      SET "beforePhotoUrl" = ${beforePhotoUrl}, "updatedAt" = NOW()
      WHERE id = ${id}
        AND "staffId" = ${user.userId}
        AND "status" NOT IN ('COMPLETED', 'APPROVED')
    `
  );

  if (updatedCount === 0) {
    return Response.json({ message: "Task already completed. Reattempt is not allowed." }, { status: 409 });
  }

  return Response.json({ data: { beforePhotoUrl } });
}
