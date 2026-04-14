export type FunctionGroup = {
  key: string;
  label: string;
  /**
   * Zone name matchers (case-insensitive). The first matching group wins.
   * Use strings for "contains" matching, or RegExp for advanced matching.
   */
  matchers: Array<string | RegExp>;
};

export const DEFAULT_FUNCTION_GROUPS: FunctionGroup[] = [
  {
    key: "cleaning",
    label: "Cleaning",
    matchers: [
      "washroom",
      "cabin",
      "desk",
      "reception",
      "common",
      "conference",
      "outside",
      "deep clean",
      "vip"
    ]
  },
  {
    key: "pantry",
    label: "Pantry",
    matchers: ["pantry"]
  },
  {
    key: "security_assist",
    label: "Security Assist",
    matchers: ["security"]
  },
  {
    key: "maintenance",
    label: "Maintenance",
    matchers: ["maintenance"]
  },
  {
    key: "other",
    label: "Other",
    matchers: []
  }
];

export function functionGroupForZoneName(zoneName: string | null | undefined, groups: FunctionGroup[] = DEFAULT_FUNCTION_GROUPS) {
  const z = (zoneName ?? "").trim().toLowerCase();
  for (const g of groups) {
    for (const m of g.matchers) {
      if (typeof m === "string") {
        if (z.includes(m.toLowerCase())) return g;
      } else if (m instanceof RegExp) {
        if (m.test(z)) return g;
      }
    }
  }
  return groups.find((g) => g.key === "other") ?? { key: "other", label: "Other", matchers: [] };
}

