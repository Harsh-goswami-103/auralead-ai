/**
 * Demo identities. The four role-switcher personas are exactly DEMO_PERSONAS (T06, ADR-126); the
 * other people make the tenant matrix and the panels realistic: an owner per workspace, a
 * workspace member, an employee with one narrow assignment and an employee with none. Every user
 * is `isDemo`, ACTIVE unless stated, and has no password (DEMO signs in through the persona
 * route). Emails use the reserved `.test` TLD, so no fixture contact is deliverable.
 *
 * ADR-126: the `client` persona (Aarav Mehta) owns the presentation workspace codecraft-web, and
 * the employee persona is its operator with every capability except `consent.import` (ADR-120:
 * honouring a consent column stays with the workspace owner).
 */
import { CAPABILITIES, type Capability } from '../../../src/lib/domain/enums';
import { DEMO_PERSONAS } from '../../../src/server/auth/demo-personas';
import { PRESENTATION_SLUG } from './presentation';

export type UserFixture = {
  key: string;
  email: string;
  name: string;
  globalRole: 'USER' | 'EMPLOYEE' | 'SUPER_ADMIN';
  createdDaysAgo: number;
  /** Hours before SEED_NOW of the last sign-in, or null for never. */
  lastLoginHoursAgo: number | null;
};

export const USER_FIXTURES: readonly UserFixture[] = [
  { key: 'admin', email: DEMO_PERSONAS.admin.email, name: 'Meera Krishnan', globalRole: 'SUPER_ADMIN', createdDaysAgo: 150, lastLoginHoursAgo: 5 },
  { key: 'owner', email: DEMO_PERSONAS.user.email, name: 'Ananya Sharma', globalRole: 'USER', createdDaysAgo: 120, lastLoginHoursAgo: 20 },
  { key: 'employee', email: DEMO_PERSONAS.employee.email, name: 'Imran Qureshi', globalRole: 'EMPLOYEE', createdDaysAgo: 110, lastLoginHoursAgo: 2 },
  { key: 'rohan', email: 'rohan.mehta@ironpulse.demo.auralead.test', name: 'Rohan Mehta', globalRole: 'USER', createdDaysAgo: 90, lastLoginHoursAgo: 30 },
  { key: 'kavya', email: 'kavya.reddy@nestkey.demo.auralead.test', name: 'Kavya Reddy', globalRole: 'USER', createdDaysAgo: 75, lastLoginHoursAgo: 52 },
  { key: 'vikram', email: 'vikram.malhotra@kesari.demo.auralead.test', name: 'Vikram Malhotra', globalRole: 'USER', createdDaysAgo: 60, lastLoginHoursAgo: 8 },
  { key: 'pooja', email: 'pooja.iyer@kesari.demo.auralead.test', name: 'Pooja Iyer', globalRole: 'USER', createdDaysAgo: 40, lastLoginHoursAgo: null },
  { key: 'siddharth', email: 'siddharth.rao@pixelchai.demo.auralead.test', name: 'Siddharth Rao', globalRole: 'USER', createdDaysAgo: 45, lastLoginHoursAgo: 70 },
  { key: 'neha', email: 'neha.kapoor@team.demo.auralead.test', name: 'Neha Kapoor', globalRole: 'EMPLOYEE', createdDaysAgo: 30, lastLoginHoursAgo: 26 },
  { key: 'arjun', email: 'arjun.nair@team.demo.auralead.test', name: 'Arjun Nair', globalRole: 'EMPLOYEE', createdDaysAgo: 3, lastLoginHoursAgo: null },
  { key: 'client', email: DEMO_PERSONAS.client.email, name: 'Aarav Mehta', globalRole: 'USER', createdDaysAgo: 30, lastLoginHoursAgo: 6 },
];

export type MembershipFixture = { user: string; workspace: string; role: 'OWNER' | 'MEMBER'; createdDaysAgo: number };

export const MEMBERSHIP_FIXTURES: readonly MembershipFixture[] = [
  { user: 'owner', workspace: 'smile-avenue-dental', role: 'OWNER', createdDaysAgo: 120 },
  { user: 'rohan', workspace: 'ironpulse-fitness', role: 'OWNER', createdDaysAgo: 90 },
  { user: 'kavya', workspace: 'nestkey-realty', role: 'OWNER', createdDaysAgo: 75 },
  { user: 'vikram', workspace: 'kesari-crafts', role: 'OWNER', createdDaysAgo: 60 },
  { user: 'pooja', workspace: 'kesari-crafts', role: 'MEMBER', createdDaysAgo: 40 },
  { user: 'siddharth', workspace: 'pixelchai-studio', role: 'OWNER', createdDaysAgo: 45 },
  { user: 'client', workspace: PRESENTATION_SLUG, role: 'OWNER', createdDaysAgo: 30 },
];

export type AssignmentFixture = {
  employee: string;
  workspace: string;
  capabilities: Capability[];
  maxDiscountBps: number | null;
  active: boolean;
  createdDaysAgo: number;
};

const OPERATOR: Capability[] = [
  'leads.read',
  'leads.write',
  'leads.export',
  'drafts.generate',
  'quotes.edit',
  'approvals.decide',
  'dispatch.send',
  'automation.manage',
  'integrations.manage',
  'campaigns.control',
  'extension.manage',
  'sheets.manage',
  'scoring.manage',
  'pipeline.manage',
];

/** ADR-126: the presentation operator holds every capability except `consent.import` (OWNER only, ADR-120). */
export const PRESENTATION_OPERATOR_CAPABILITIES: Capability[] = CAPABILITIES.filter((c) => c !== 'consent.import');

export const ASSIGNMENT_FIXTURES: readonly AssignmentFixture[] = [
  { employee: 'employee', workspace: 'smile-avenue-dental', capabilities: OPERATOR, maxDiscountBps: 1000, active: true, createdDaysAgo: 110 },
  {
    employee: 'employee',
    workspace: 'kesari-crafts',
    capabilities: ['leads.read', 'leads.write', 'drafts.generate', 'quotes.edit', 'approvals.decide', 'dispatch.send', 'sheets.manage', 'extension.manage'],
    maxDiscountBps: 1500,
    active: true,
    createdDaysAgo: 55,
  },
  { employee: 'employee', workspace: 'nestkey-realty', capabilities: ['leads.read', 'drafts.generate'], maxDiscountBps: 500, active: false, createdDaysAgo: 70 },
  { employee: 'neha', workspace: 'ironpulse-fitness', capabilities: ['leads.read'], maxDiscountBps: 500, active: true, createdDaysAgo: 30 },
  { employee: 'employee', workspace: PRESENTATION_SLUG, capabilities: PRESENTATION_OPERATOR_CAPABILITIES, maxDiscountBps: 1000, active: true, createdDaysAgo: 28 },
];

/** Who created the assignments (the platform admin). */
export const ASSIGNMENT_CREATOR = 'admin';
