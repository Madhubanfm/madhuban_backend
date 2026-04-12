import { getAuthUserFromRequest } from "@/lib/auth";
import { generateDailyTasksForDate } from "@/lib/cron";
import { ROLE_NAMES } from "@/lib/constants";

export async function POST(req: Request) {
  const user = await getAuthUserFromRequest(req);
  if (!user) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }

  if (user.role !== ROLE_NAMES.ADMIN) {
    return Response.json({ message: "Only admin can run cron manually." }, { status: 403 });
  }

  const result = await generateDailyTasksForDate(new Date());
  return Response.json({
    message: "Daily task generation completed.",
    ...result
  });
}
