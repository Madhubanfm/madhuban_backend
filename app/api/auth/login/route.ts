import { comparePassword, signAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return Response.json({ message: "Invalid request body." }, { status: 400 });
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { role: true }
    });

    if (!user) {
      return Response.json({ message: "Invalid email or password." }, { status: 401 });
    }

    const isValidPassword = await comparePassword(password, user.passwordHash);
    if (!isValidPassword) {
      return Response.json({ message: "Invalid email or password." }, { status: 401 });
    }

    const token = await signAuthToken({
      userId: user.id,
      email: user.email,
      role: user.role.name
    });

    return Response.json({
      message: "Login successful.",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.name
      }
    });
  } catch {
    return Response.json({ message: "Something went wrong." }, { status: 500 });
  }
}
