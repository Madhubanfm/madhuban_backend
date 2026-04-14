import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { DEFAULT_FUNCTION_GROUPS } from "@/lib/function-zone-map";
import { getManagerShiftReport } from "@/lib/manager-shift-report";
import { parseDateParam } from "@/lib/request-date";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional()
});

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.MANAGER) return Response.json({ message: "Not allowed." }, { status: 403 });

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined
  });
  if (!parsedQuery.success) {
    return Response.json({ message: "Invalid query params." }, { status: 400 });
  }

  let date: Date;
  try {
    date = parseDateParam(url.searchParams.get("date"));
  } catch {
    return Response.json({ message: "Invalid date. Use YYYY-MM-DD or ISO date." }, { status: 400 });
  }

  const data = await getManagerShiftReport(user.userId, date, new Date(), DEFAULT_FUNCTION_GROUPS);
  return Response.json({ data });
}

