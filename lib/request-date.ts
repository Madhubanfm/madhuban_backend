/** Parses `date` query value: default today, ISO string, or YYYY-MM-DD. Throws if invalid. */
export function parseDateParam(dateParam: string | null): Date {
  if (!dateParam) {
    return new Date();
  }

  const trimmed = dateParam.trim();
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.getTime())) {
    return iso;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) {
    throw new Error("invalid");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("invalid");
  }
  return new Date(Date.UTC(year, month - 1, day));
}
