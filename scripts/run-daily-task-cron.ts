import cron from "node-cron";
import { generateDailyTasksForDate } from "../lib/cron";

async function runNow() {
  const result = await generateDailyTasksForDate(new Date());
  console.log(`[cron] Generated daily tasks. Created: ${result.created}, Skipped: ${result.skipped}`);
}

cron.schedule("0 0 * * *", async () => {
  try {
    await runNow();
  } catch (error) {
    console.error("[cron] Failed to generate daily tasks", error);
  }
});

runNow().catch((error) => {
  console.error(error);
  process.exit(1);
});
