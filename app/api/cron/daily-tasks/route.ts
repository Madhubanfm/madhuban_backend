import { generateDailyTasksForDate } from "@/lib/cron";

export async function POST(req: Request) {
  const result = await generateDailyTasksForDate(new Date());
  return Response.json({
    message: "Daily task generation completed.",
    ...result
  });
}
