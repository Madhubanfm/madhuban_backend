import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { normalizeToDayIST } from "@/lib/date";
import { getAdminDashboardData } from "@/lib/admin-dashboard";
import { parseDateParam } from "@/lib/request-date";
import { z } from "zod";

const querySchema = z.object({
  date: z.string().optional(),
  propertyId: z.coerce.number().int().positive().optional()
});

export async function GET(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (user.role !== ROLE_NAMES.ADMIN) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  const url = new URL(req.url);
  const parsedQuery = querySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined,
    propertyId: url.searchParams.get("propertyId") ?? undefined
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

  const taskDate = normalizeToDayIST(date);
  const data = await getAdminDashboardData(user.userId, taskDate, parsedQuery.data.propertyId);

  return Response.json({
    data: {
      ...data,
      date: taskDate.toISOString()
    }
  });
}

