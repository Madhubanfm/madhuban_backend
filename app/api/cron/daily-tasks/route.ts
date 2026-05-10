import { generateDailyTasksForDate } from "@/lib/cron";

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return Response.json({ message: "Unauthorized." }, { status: 401 });
    }
  }

  const triggeredAt = new Date();
  const result = await generateDailyTasksForDate(triggeredAt);

  return Response.json({
    message: "Daily task generation completed.",
    triggeredAt: triggeredAt.toISOString(),
    taskDate: triggeredAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }),
    ...result
  });
}
