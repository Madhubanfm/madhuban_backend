import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { buildTaskPhotoKey, buildPublicUrl, getPresignedPutUrl } from "@/lib/s3";

function getIntId(value: string) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function extFromContentType(ct: string): "jpg" | "png" | null {
  if (ct === "image/png") return "png";
  if (ct === "image/jpeg") return "jpg";
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
    return Response.json({ message: "Task already completed." }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ message: "Expected JSON body." }, { status: 400 });
  }

  const contentType = typeof body.contentType === "string" ? body.contentType : null;
  const ext = contentType ? extFromContentType(contentType) : null;
  if (!ext || !contentType) {
    return Response.json({ message: "contentType must be image/jpeg or image/png." }, { status: 400 });
  }

  const key = buildTaskPhotoKey({ dailyTaskId: id, kind: "before", ext });

  let uploadUrl: string;
  try {
    uploadUrl = await getPresignedPutUrl({ key, contentType });
  } catch {
    return Response.json({ message: "Failed to generate upload URL." }, { status: 500 });
  }

  return Response.json({ data: { uploadUrl, key, publicUrl: buildPublicUrl(key) } });
}
