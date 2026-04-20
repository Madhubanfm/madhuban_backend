import { ROLE_NAMES } from "@/lib/constants";
import { hashPassword } from "@/lib/auth";
import { decryptPassword, encryptPassword } from "@/lib/password-encryption";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const updateUserSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    managerId: z.number().int().positive().nullable().optional(),
    supervisorId: z.number().int().positive().nullable().optional(),
    // `phone` is accepted for backward compatibility; we store to `mobileNumber`.
    mobileNumber: z.coerce.string().trim().min(1).optional(),
    phone: z.coerce.string().trim().min(1).optional(),
    phoneNumber: z.coerce.string().trim().min(1).optional(),
    status: z.string().min(1).optional(),
    department: z.string().min(1).optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Provide at least one field." });

function parseUserId(idParam: string): number | null {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) {
    return null;
  }
  return id;
}

function normalizeRoleName(role: string) {
  return role.trim().toLowerCase();
}

function serializeUser(u: {
  id: number;
  name: string;
  email: string;
  mobileNumber?: string | null;
  passwordHash: string;
  passwordEncrypted?: string | null;
  createdAt: Date;
  updatedAt: Date;
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
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  };
}

const userInclude = {
  role: true,
  manager: { select: { id: true, name: true, email: true } },
  supervisor: { select: { id: true, name: true, email: true } }
} satisfies Prisma.UserInclude;

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await context.params;
  const id = parseUserId(idParam);
  if (id === null) {
    return Response.json({ message: "Invalid user id." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id },
    include: userInclude
  });

  if (!user) {
    return Response.json({ message: "User not found." }, { status: 404 });
  }

  return Response.json({ data: serializeUser(user) });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await context.params;
  const id = parseUserId(idParam);
  if (id === null) {
    return Response.json({ message: "Invalid user id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ message: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({
    where: { id },
    include: { role: true }
  });

  if (!existing) {
    return Response.json({ message: "User not found." }, { status: 404 });
  }

  const roleName = parsed.data.role ? normalizeRoleName(parsed.data.role) : existing.role.name;
  const role =
    roleName === existing.role.name
      ? { id: existing.roleId, name: existing.role.name }
      : await prisma.role.findUnique({ where: { name: roleName } });

  if (!role) {
    return Response.json({ message: "Invalid role." }, { status: 400 });
  }

  const managerId = parsed.data.managerId;
  const supervisorId = parsed.data.supervisorId;

  if (roleName === ROLE_NAMES.MANAGER || roleName === ROLE_NAMES.ADMIN) {
    if (managerId !== undefined || supervisorId !== undefined) {
      return Response.json(
        { message: "managerId/supervisorId are not allowed for this role." },
        { status: 400 }
      );
    }
  }

  const data: Prisma.UserUncheckedUpdateInput = {};

  if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
  if (parsed.data.email !== undefined) data.email = parsed.data.email.toLowerCase();
  if (parsed.data.role !== undefined) data.roleId = role.id;
  if (parsed.data.mobileNumber !== undefined) (data as any).mobileNumber = parsed.data.mobileNumber;
  if (parsed.data.phone !== undefined) (data as any).mobileNumber = parsed.data.phone;
  if (parsed.data.phoneNumber !== undefined) (data as any).mobileNumber = parsed.data.phoneNumber;

  if (parsed.data.password !== undefined) {
    data.passwordHash = await hashPassword(parsed.data.password);
    (data as any).passwordEncrypted = encryptPassword(parsed.data.password);
  }

  // Ensure relational fields are consistent with the final role.
  if (roleName === ROLE_NAMES.SUPERVISOR) {
    if (managerId !== undefined) data.managerId = managerId;
    data.supervisorId = null;
  } else if (roleName === ROLE_NAMES.STAFF) {
    if (supervisorId !== undefined) data.supervisorId = supervisorId;
    data.managerId = null;
  } else {
    data.managerId = null;
    data.supervisorId = null;
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data,
      include: userInclude
    });
    return Response.json({ message: "User updated.", data: serializeUser(updated) });
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

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await context.params;
  const id = parseUserId(idParam);
  if (id === null) {
    return Response.json({ message: "Invalid user id." }, { status: 400 });
  }

  try {
    await prisma.user.delete({ where: { id } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return Response.json({ message: "User not found." }, { status: 404 });
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      return Response.json(
        { message: "Cannot delete: user is referenced by other records." },
        { status: 409 }
      );
    }
    throw e;
  }

  return Response.json({ message: "User deleted." });
}

