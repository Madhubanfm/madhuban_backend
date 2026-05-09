import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { buildAttendanceSelfieKey, buildPublicUrl, getPresignedPutUrl } from "@/lib/s3";

function extFromContentType(ct: string): "jpg" | "png" | null {
  if (ct === "image/png") return "png";
  if (ct === "image/jpeg") return "jpg";
  return null;
}

export async function POST(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.SUPERVISOR) return Response.json({ message: "Not allowed." }, { status: 403 });

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

  const workDate = normalizeToDayIST(new Date());
  const key = buildAttendanceSelfieKey({ staffId: user.userId, workDate, ext });

  let uploadUrl: string;
  try {
    uploadUrl = await getPresignedPutUrl({ key, contentType });
  } catch {
    return Response.json({ message: "Failed to generate upload URL." }, { status: 500 });
  }

  return Response.json({ data: { uploadUrl, key, publicUrl: buildPublicUrl(key) } });
}
