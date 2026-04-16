import { getAuthUserFromRequest } from "@/lib/auth";
import { ROLE_NAMES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

function getIntId(value: string) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().max(2000).optional()
});

export async function POST(req: Request, ctx: { params: Promise<{ dailyTaskId: string }> }) {
  const user = await getAuthUserFromRequest(req);
  if (!user) return Response.json({ message: "Unauthorized." }, { status: 401 });
  if (user.role !== ROLE_NAMES.MANAGER) return Response.json({ message: "Not allowed." }, { status: 403 });

  const { dailyTaskId } = await ctx.params;
  const id = getIntId(dailyTaskId);
  if (!id) return Response.json({ message: "Invalid dailyTaskId." }, { status: 400 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ message: "Invalid payload." }, { status: 400 });
  }

  const nextStatus = parsed.data.action === "approve" ? "APPROVED" : "REJECTED";
  const decidedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const approval = await tx.taskApproval.findUnique({
      where: { dailyStaffTaskId: id },
      select: {
        id: true,
        supervisorId: true,
        status: true,
        submittedAt: true,
        decidedAt: true,
        decisionNote: true
      }
    });

    if (!approval) return { kind: "not_found" as const };
    // Manager decisions are only valid after a supervisor has approved,
    // but manager can still reject even if supervisor already approved.
    if (parsed.data.action === "approve" && approval.status !== "APPROVED") {
      return { kind: "supervisor_not_approved" as const, status: approval.status };
    }

    const dailyTask = await tx.dailyStaffTask.findUnique({
      where: { id },
      select: { id: true, status: true }
    });
    if (!dailyTask) return { kind: "not_found" as const };
    if (!["IN_REVIEW", "APPROVED"].includes(dailyTask.status)) {
      return { kind: "invalid_task_status" as const, status: dailyTask.status };
    }

    const supervisor = await tx.user.findUnique({
      where: { id: approval.supervisorId },
      select: { id: true, managerId: true }
    });
    if (!supervisor) return { kind: "not_found" as const };
    if (supervisor.managerId !== user.userId) return { kind: "forbidden" as const };

    // Manager "approve" is effectively a forward/no-op: we purposely do not overwrite
    // supervisor decision metadata (decidedAt/decisionNote).
    if (parsed.data.action === "approve") {
      return {
        kind: "ok" as const,
        approval: {
          id: approval.id,
          dailyStaffTaskId: id,
          status: approval.status,
          submittedAt: approval.submittedAt,
          decidedAt: approval.decidedAt,
          decisionNote: approval.decisionNote,
          supervisorId: approval.supervisorId
        }
      };
    }

    const updated = await tx.taskApproval.update({
      where: { dailyStaffTaskId: id },
      data: {
        status: nextStatus,
        decidedAt,
        decisionNote: parsed.data.comment ?? null
      },
      select: {
        id: true,
        dailyStaffTaskId: true,
        status: true,
        submittedAt: true,
        decidedAt: true,
        decisionNote: true,
        supervisorId: true
      }
    });

    await tx.dailyStaffTask.update({
      where: { id },
      data: {
        status: nextStatus,
        completedAt: nextStatus === "APPROVED" ? decidedAt : null
      },
      select: { id: true }
    });

    return { kind: "ok" as const, approval: updated };
  });

  if (result.kind === "not_found") {
    return Response.json({ message: "Review not found." }, { status: 404 });
  }
  if (result.kind === "forbidden") {
    return Response.json({ message: "Not allowed." }, { status: 403 });
  }
  if (result.kind === "invalid_task_status") {
    return Response.json(
      { message: "Task must be IN_REVIEW/APPROVED to decide.", data: { currentStatus: result.status } },
      { status: 409 }
    );
  }
  if (result.kind === "supervisor_not_approved") {
    return Response.json(
      { message: "Supervisor must approve before manager can approve.", data: { currentStatus: result.status } },
      { status: 409 }
    );
  }

  return Response.json({
    data: {
      approval: {
        id: result.approval.id,
        dailyTaskId: result.approval.dailyStaffTaskId,
        status: result.approval.status,
        submittedAt: result.approval.submittedAt.toISOString(),
        decidedAt: result.approval.decidedAt?.toISOString() ?? null,
        decisionNote: result.approval.decisionNote,
        supervisorId: result.approval.supervisorId
      }
    }
  });
}

