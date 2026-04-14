import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { parseDateParam } from "@/lib/request-date";
import { getEmployeeShiftLogs } from "@/lib/supervisor-shift-report";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional()
});

const paramsSchema = z.object({
  staffId: z.coerce.number().int().positive()
});

export async function GET(req: Request, ctx: { params: Promise<{ staffId: string }> }) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.SUPERVISOR) return Response.json({ message: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined
  });
  if (!parsedQuery.success) {
    return Response.json({ message: "Invalid query params." }, { status: 400 });
  }

  const rawParams = await ctx.params;
  const parsedParams = paramsSchema.safeParse({ staffId: rawParams.staffId });
  if (!parsedParams.success) {
    return Response.json({ message: "Invalid staffId." }, { status: 400 });
  }

  let date: Date;
  try {
    date = parseDateParam(url.searchParams.get("date"));
  } catch {
    return Response.json({ message: "Invalid date. Use YYYY-MM-DD or ISO date." }, { status: 400 });
  }

  const taskDate = normalizeToDayIST(date);
  const data = await getEmployeeShiftLogs(user.userId, parsedParams.data.staffId, taskDate);
  return Response.json({ data });
}

