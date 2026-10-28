/**
 * The template studio of one assigned workspace (ADR-123, slice F4; plan §0 step 5): write a
 * WhatsApp template after choosing its category, generate the copy (AI in LIVE with an AI
 * integration, the labelled local template in DEMO), preview it as a WhatsApp bubble, save the
 * draft, submit it for approval and follow Meta's verdict (Pending, Approved, Rejected with the
 * reason). The `[ws]` slug is resolved against the employee's assignments; reading needs
 * `leads.read`, every action `templates.manage`. LIVE without WhatsApp shows the configuration gate
 * with the setup link; DEMO says Simulated and contacts nothing.
 */
import type { Metadata } from 'next';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { PageHeader } from '@/components/patterns/PageHeader';
import { TemplateStudio } from '@/components/templates/TemplateStudio';
import { getRuntime } from '@/server/boot';
import { getTemplateStudio } from '@/server/services/integrations/template-authoring';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';

export const metadata: Metadata = { title: 'Message templates' };
export const dynamic = 'force-dynamic';

export default async function TemplatesPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const view = await readOrNull(() => getTemplateStudio(page.ctx, { graphVersion: getRuntime().config.meta.graphVersion }));
  const name = view?.workspace.name ?? ws;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={name}
        title="Message templates"
        description="Write WhatsApp templates, generate the copy, preview them and submit them to Meta for approval. A business can start a WhatsApp conversation only with an approved template."
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {view === null ? <NotInAssignment what="Message templates" /> : <TemplateStudio workspaceSlug={ws} view={view} />}
    </div>
  );
}
