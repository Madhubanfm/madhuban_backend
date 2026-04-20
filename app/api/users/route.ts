import { prisma } from "@/lib/prisma";
import { ROLE_NAMES } from "@/lib/constants";
import { hashPassword } from "@/lib/auth";
import { decryptPassword, encryptPassword } from "@/lib/password-encryption";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1).optional(),
  roleId: z.number().int().positive().optional(),
  password: z.string().min(1).optional(),
  confirmPassword: z.string().min(1).optional(),
  managerId: z.number().int().positive().optional(),
  supervisorId: z.number().int().positive().optional(),
  // `phone` is accepted for backward compatibility; we store to `mobileNumber`.
  mobileNumber: z.coerce.string().trim().min(1).optional(),
  phone: z.coerce.string().trim().min(1).optional(),
  phoneNumber: z.coerce.string().trim().min(1).optional(),
  status: z.string().min(1).optional(),
  department: z.string().min(1).optional()
}).refine((data) => data.roleId != null || (data.role != null && data.role.trim().length > 0), {
  message: "Either roleId or role is required."
}).refine((data) => {
  if (data.password === undefined) return true; // default password will be applied
  return data.confirmPassword !== undefined && data.password === data.confirmPassword;
}, {
  message: "Password and confirmPassword must match."
});

function normalizeRoleName(role: string) {
  return role.trim().toLowerCase();
}

function defaultPasswordForRole(roleName: string) {
  switch (roleName) {
    case ROLE_NAMES.ADMIN:
      return "Admin@123";
    case ROLE_NAMES.MANAGER:
      return "Manager@123";
    case ROLE_NAMES.SUPERVISOR:
      return "Supervisor@123";
    case ROLE_NAMES.STAFF:
      return "Staff@123";
    default:
      return "User@123";
  }
}

function serializeUser(u: {
  id: number;
  name: string;
  email: string;
  mobileNumber?: string | null;
  passwordHash: string;
  passwordEncrypted?: string | null;
  createdAt: Date;
  role: { name: string };
  manager: { id: number; name: string; email: string } | null;
  supervisor: { id: number; name: string; email: string } | null;
}) {
  let decryptedPassword: string | null = null;
  if (u.passwordEncrypted) {
    try {
      decryptedPassword = decryptPassword(u.passwordEncrypted);
    } catch {
      // Likely legacy/corrupt payload or key rotation; avoid crashing the endpoint.
      decryptedPassword = null;
    }
  }
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    mobileNumber: u.mobileNumber ?? null,
    password: decryptedPassword,
    role: u.role.name,
    manager: u.manager,
    supervisor: u.supervisor,
    createdAt: u.createdAt
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const page = Math.max(Number(url.searchParams.get("page") ?? "1"), 1);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "10"), 1), 100);

  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { id: "asc" },
      include: {
        role: true,
        manager: { select: { id: true, name: true, email: true } },
        supervisor: { select: { id: true, name: true, email: true } }
      }
    }),
    prisma.user.count()
  ]);

  return Response.json({
    data: users.map(serializeUser),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ message: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const role =
    parsed.data.roleId != null
      ? await prisma.role.findUnique({ where: { id: parsed.data.roleId } })
      : await prisma.role.findUnique({ where: { name: normalizeRoleName(parsed.data.role ?? "") } });
  if (!role) {
    return Response.json({ message: "Invalid role." }, { status: 400 });
  }
  const roleName = normalizeRoleName(role.name);

  const managerId = parsed.data.managerId;
  const supervisorId = parsed.data.supervisorId;

  // Role assignment rules:
  // - roleId 2: manager has no manager/supervisor
  // - roleId 3: supervisor must have managerId
  // - roleId 4: staff must have supervisorId (frontend may send it as managerId for compatibility)
  //
  // Note: We enforce by roleName (canonical) and also support the numeric mapping above when roleId is provided.
  const roleId = parsed.data.roleId;
  const isRoleId2 = roleId === 2;
  const isRoleId3 = roleId === 3;
  const isRoleId4 = roleId === 4;

  if (
    roleName === ROLE_NAMES.ADMIN ||
    roleName === ROLE_NAMES.MANAGER ||
    isRoleId2
  ) {
    if (managerId != null || supervisorId != null) {
      return Response.json(
        { message: "managerId/supervisorId are not allowed for this role." },
        { status: 400 }
      );
    }
  }

  if (roleName === ROLE_NAMES.SUPERVISOR || isRoleId3) {
    if (supervisorId != null) {
      return Response.json(
        { message: "supervisorId is not allowed for supervisor role. Use managerId." },
        { status: 400 }
      );
    }
    if (managerId == null) {
      return Response.json({ message: "managerId is required for supervisor role." }, { status: 400 });
    }
  }

  // For staff, accept either supervisorId (preferred) or managerId as an alias for supervisorId.
  const staffSupervisorId = supervisorId ?? (roleName === ROLE_NAMES.STAFF || isRoleId4 ? managerId : undefined);

  if (roleName === ROLE_NAMES.STAFF || isRoleId4) {
    if (staffSupervisorId == null) {
      return Response.json(
        { message: "supervisorId is required for staff role." },
        { status: 400 }
      );
    }
  }

  const passwordPlain = parsed.data.password ?? defaultPasswordForRole(roleName);
  const passwordHash = await hashPassword(passwordPlain);
  const passwordEncrypted = encryptPassword(passwordPlain);

  try {
    const created = await prisma.user.create({
      data: ({
        name: parsed.data.name.trim(),
        email: parsed.data.email.toLowerCase(),
        mobileNumber:
          parsed.data.mobileNumber ??
          parsed.data.phone ??
          parsed.data.phoneNumber ??
          null,
        passwordHash,
        passwordEncrypted,
        roleId: role.id,
        ...(roleName === ROLE_NAMES.SUPERVISOR || isRoleId3 ? { managerId: managerId ?? null } : {}),
        ...(roleName === ROLE_NAMES.STAFF || isRoleId4 ? { supervisorId: staffSupervisorId ?? null } : {})
      } as any),
      include: {
        role: true,
        manager: { select: { id: true, name: true, email: true } },
        supervisor: { select: { id: true, name: true, email: true } }
      }
    });

    return Response.json(
      {
        message: "User created.",
        data: serializeUser(created),
        meta: parsed.data.password
          ? undefined
          : { defaultPassword: passwordPlain, note: "Default password was applied." }
      },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return Response.json({ message: "Email already exists." }, { status: 409 });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      return Response.json(
        { message: "Invalid managerId or supervisorId reference." },
        { status: 400 }
      );
    }
    throw e;
  }
}
