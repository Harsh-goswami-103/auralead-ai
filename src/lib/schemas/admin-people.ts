/**
 * Request schemas for the super admin's workspace, people and audit routes (T29), shared by the
 * routes and the admin panel forms (plan §2: one schema set). Shape only; the services own the
 * rules (slug uniqueness, last-owner and last-admin guards, demo users in LIVE) and answer with a
 * code.
 *
 * Body keys never use `workspaceId`, `userId` or `role`: withRoute treats those as browser-supplied
 * identity and refuses any value that differs from the resolved context (A6). The workspace a
 * mutation targets is `targetWorkspaceId` or a path segment; the user is a path segment.
 */
import { z } from 'zod';
import { CAPABILITIES, type Capability } from '@/lib/domain/enums';
import { adminReason } from './admin';

export { ADMIN_REASON_MAX, ADMIN_REASON_MIN } from './admin';

/** 3 to 48 characters: lowercase letters, digits and single hyphens, starting and ending alphanumeric. */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,46}[a-z0-9]$/;

/**
 * Slugs a workspace may not take. `[ws]` sits beside static segments under /dashboard/employee
 * (e.g. `approvals`); a workspace with that slug could never be opened there. The rest are kept
 * free for panel and API paths.
 */
export const RESERVED_WORKSPACE_SLUGS: readonly string[] = ['approvals', 'admin', 'api', 'dashboard', 'new', 'settings', 'login', 'invite', 'reset', 'docs'];

export const DEFAULT_WORKSPACE_TIMEZONE = 'Asia/Kolkata';
export const PLAN_LABEL_MAX = 40;
export const WORKSPACE_NAME_MAX = 120;

const email = z.string().trim().toLowerCase().min(3).max(320).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.');
const planLabel = z.string().trim().min(1).max(PLAN_LABEL_MAX);
const id = z.string().trim().min(1).max(64);

export const WorkspaceCreateBody = z
  .object({
    name: z.string().trim().min(2).max(WORKSPACE_NAME_MAX),
    slug: z.string().trim().toLowerCase().regex(WORKSPACE_SLUG_PATTERN, 'Use 3-48 lowercase letters, digits and single hyphens.'),
    planLabel,
    timezone: z.string().trim().min(1).max(64).default(DEFAULT_WORKSPACE_TIMEZONE),
    ownerEmail: email,
    reason: adminReason,
  })
  .strict();
export type WorkspaceCreateBody = z.infer<typeof WorkspaceCreateBody>;

export const PlanLabelBody = z.object({ planLabel, reason: adminReason }).strict();
export type PlanLabelBody = z.infer<typeof PlanLabelBody>;

export const DrilldownBody = z.object({ reason: adminReason }).strict();
export type DrilldownBody = z.infer<typeof DrilldownBody>;

export const INVITABLE_ROLES = ['USER', 'EMPLOYEE', 'SUPER_ADMIN'] as const;
export const MEMBERSHIP_ROLES = ['OWNER', 'MEMBER'] as const;

export const InviteCreateBody = z
  .object({
    email,
    globalRole: z.enum(INVITABLE_ROLES),
    /** A client user's workspace (required for USER, refused for the platform roles). */
    targetWorkspaceId: id.optional(),
    membershipRole: z.enum(MEMBERSHIP_ROLES).optional(),
    reason: adminReason,
  })
  .strict();
export type InviteCreateBody = z.infer<typeof InviteCreateBody>;

export const ReasonBody = z.object({ reason: adminReason }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const RoleChangeBody = z.object({ globalRole: z.enum(INVITABLE_ROLES), reason: adminReason }).strict();
export type RoleChangeBody = z.infer<typeof RoleChangeBody>;

export const SETTABLE_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export const StatusChangeBody = z.object({ status: z.enum(SETTABLE_STATUSES), reason: adminReason }).strict();
export type StatusChangeBody = z.infer<typeof StatusChangeBody>;

export const MembershipSetBody = z
  .object({
    targetWorkspaceId: id,
    /** null removes the membership. */
    membershipRole: z.enum(MEMBERSHIP_ROLES).nullable(),
    reason: adminReason,
  })
  .strict();
export type MembershipSetBody = z.infer<typeof MembershipSetBody>;

export const AssignmentSetBody = z
  .object({
    targetWorkspaceId: id,
    capabilities: z
      .array(z.enum(CAPABILITIES))
      .max(CAPABILITIES.length)
      .transform((caps): Capability[] => [...new Set(caps)].sort()),
    /** The employee's own discount cap in basis points; null means the workspace limit applies. */
    maxDiscountBps: z.number().int().min(0).max(10_000).nullable(),
    active: z.boolean(),
    reason: adminReason,
  })
  .strict();
export type AssignmentSetBody = z.infer<typeof AssignmentSetBody>;

export const AUDIT_RESULTS = ['SUCCESS', 'DENIED', 'FAILED'] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/**
 * Audit search query (GET params). `actor` is a user id or an email; `workspace` a workspace id or
 * slug; `action` matches a prefix (`quote.` finds every quote action); dates are India calendar
 * days (IST), both inclusive; `before` is the keyset cursor (an event id).
 */
export const AuditSearchQuery = z
  .object({
    actor: z.string().trim().max(320).optional(),
    action: z.string().trim().max(80).optional(),
    targetType: z.string().trim().max(64).optional(),
    targetId: z.string().trim().max(128).optional(),
    workspace: z.string().trim().max(64).optional(),
    result: z.enum(AUDIT_RESULTS).optional(),
    from: day.optional(),
    to: day.optional(),
    correlationId: z.string().trim().max(128).optional(),
    before: z.string().trim().max(64).optional(),
  })
  .strict();
export type AuditSearchQuery = z.infer<typeof AuditSearchQuery>;
