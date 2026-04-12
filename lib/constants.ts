export const ROLE_NAMES = {
  ADMIN: "admin",
  MANAGER: "manager",
  SUPERVISOR: "supervisor",
  STAFF: "staff"
} as const;

export const ALL_ROLES = Object.values(ROLE_NAMES);
