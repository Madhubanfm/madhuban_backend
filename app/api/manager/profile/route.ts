import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { deriveShiftIST, normalizeToDayIST } from "@/lib/date";
import { buildContextLabelForManager } from "@/lib/manager-dashboard";
import { prisma } from "@/lib/prisma";

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function isActiveFromAttendance(checkInAt: Date | null | undefined, checkOutAt: Date | null | undefined) {
  if (!checkInAt) return false;
  if (checkOutAt) return false;
  return true;
}

export async function GET(req: Request) {
  const auth = await getAuthUserFromRequest(req);
  if (!auth) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (auth.role !== ROLE_NAMES.MANAGER) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

  const managerId = auth.userId;
  const today = normalizeToDayIST(new Date());
  const shift = deriveShiftIST(new Date());

  const [user, attendance, contextLabel] = await Promise.all([
    prisma.user.findUnique({
      where: { id: managerId },
      include: {
        role: { select: { name: true } }
      }
    }),
    prisma.staffAttendance.findUnique({
      where: {
        staffId_workDate: { staffId: managerId, workDate: today }
      }
    }),
    buildContextLabelForManager(managerId, today)
  ]);

  if (!user) {
    return Response.json({ message: "User not found." }, { status: 404 });
  }

  const isActive = isActiveFromAttendance(attendance?.checkInAt, attendance?.checkOutAt);
  const appVersion = process.env.APP_VERSION ?? process.env.npm_package_version ?? null;

  return Response.json({
    data: {
      profile: {
        manager_id: user.id,
        full_name: user.name,
        email: user.email,
        initials: initialsFromName(user.name),
        role: user.role.name.toUpperCase()
      },
      badges: {
        shift,
        status: isActive ? "ACTIVE" : "INACTIVE"
      },
      account: {
        propertyLabel: contextLabel,
        reportingTo: null,
        appVersion
      }
    }
  });
}

