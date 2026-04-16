import { getAuthUserFromRequest, hashPassword } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { encryptPassword } from "@/lib/password-encryption";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const bodySchema = z
  .object({
    password: z.string().min(1),
    confirmPassword: z.string().min(1)
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Password and confirmPassword must match."
  });

function parseUserId(idParam: string): number | null {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUserFromRequest(req);
  if (!auth) {
    return Response.json({ message: "Unauthorized." }, { status: 401 });
  }
  if (auth.role !== ROLE_NAMES.ADMIN) {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }

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

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const passwordEncrypted = encryptPassword(parsed.data.password);

  try {
    await prisma.user.update({
      where: { id },
      data: ({ passwordHash, passwordEncrypted } as any)
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return Response.json({ message: "User not found." }, { status: 404 });
    }
    throw e;
  }

  return Response.json({
    message: "Password reset.",
    data: { userId: id, password: parsed.data.password }
  });
}

