import { prisma } from "@/lib/prisma";
import { ROLE_NAMES } from "@/lib/constants";
import { hashPassword } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  password: z.string().min(1).optional(),
  managerId: z.number().int().positive().optional(),
  supervisorId: z.number().int().positive().optional(),
  // Accepted for client compatibility (not stored in DB)
  phone: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  department: z.string().min(1).optional()
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
  createdAt: Date;
  role: { name: string };
  manager: { id: number; name: string; email: string } | null;
  supervisor: { id: number; name: string; email: string } | null;
}) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
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

  const roleName = normalizeRoleName(parsed.data.role);
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    return Response.json({ message: "Invalid role." }, { status: 400 });
  }

  const managerId = parsed.data.managerId;
  const supervisorId = parsed.data.supervisorId;

  if (roleName === ROLE_NAMES.MANAGER || roleName === ROLE_NAMES.ADMIN) {
    if (managerId != null || supervisorId != null) {
      return Response.json(
        { message: "managerId/supervisorId are not allowed for this role." },
        { status: 400 }
      );
    }
  }

  const passwordPlain = parsed.data.password ?? defaultPasswordForRole(roleName);
  const passwordHash = await hashPassword(passwordPlain);

  try {
    const created = await prisma.user.create({
      data: {
        name: parsed.data.name.trim(),
        email: parsed.data.email.toLowerCase(),
        passwordHash,
        roleId: role.id,
        ...(roleName === ROLE_NAMES.SUPERVISOR && managerId ? { managerId } : {}),
        ...(roleName === ROLE_NAMES.STAFF && supervisorId ? { supervisorId } : {})
      },
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
