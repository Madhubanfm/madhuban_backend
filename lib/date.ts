export function normalizeToDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getDatePartsInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Failed to compute date parts for timezone: ${timeZone}`);
  }

  return { year, month, day };
}

/**
 * Normalizes any input moment to the calendar day in Asia/Kolkata (IST),
 * represented as a UTC-midnight Date (for stable DB equality comparisons).
 */
export function normalizeToDayIST(date: Date): Date {
  const { year, month, day } = getDatePartsInTimeZone(date, "Asia/Kolkata");
  return new Date(Date.UTC(year, month - 1, day));
}
