'use client';

/**
 * The Kanban board of the Leads area (T26, R4, R31): one column per sales stage, each with its
 * newest cards in the chosen order and the number of leads in that stage (capped "1,000+").
 *
 * Three ways to move a card, all through the same stage compare-and-set (`useStageMove`):
 *  - the card's "Move to stage" menu (the keyboard path; every card has one),
 *  - dragging the card onto another column (pointer only; HTML drag and drop),
 *  - from the detail sheet or page.
 * LOST asks for a reason first. Nothing moves on screen until the server agreed; a stale version
 * (someone else moved it, or an automatic promotion) reloads the board with a message instead.
 * Without leads.write the cards are read-only and the board says why once (plan §12 GatedAction).
 *
 * Look (design spec §6): columns are neutral surfaces with the stage chip and count in the header;
 * the drop target gets a panel-hue ring while a card is over it. No per-card motion.
 */
import Link from 'next/link';
import { useState, type DragEvent } from 'react';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { cn } from '@/components/ui/cn';
import type { SalesStage } from '@/lib/domain/enums';
import { ScoreMeter } from './ScoreMeter';
import { StageChip } from './StageChip';
import { LostReasonDialog, StageMoveMenu, useStageMove } from './StageMoveMenu';
import { cappedCountText, type BoardColumnDto, type LeadRowDto, type StageLead } from './types';

const DRAG_TYPE = 'application/x-auralead-lead';

function Card(props: { lead: LeadRowDto; canMove: boolean; workspaceSlug?: string; onDragStart: (lead: LeadRowDto) => void; onDragEnd: () => void }) {
  const { lead } = props;
  return (
    <li
      data-lead-card={lead.id}
      data-sales-stage={lead.salesStage}
      draggable={props.canMove}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, lead.id);
        e.dataTransfer.effectAllowed = 'move';
        props.onDragStart(lead);
      }}
      onDragEnd={props.onDragEnd}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/70 p-3 transition-colors duration-fast hover:border-border-strong',
        props.canMove && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <Link href={lead.href} scroll={false} className="min-w-0 font-medium break-words text-cyan underline-offset-4 hover:underline">
          {lead.displayName}
        </Link>
        {lead.simulated ? <ModeChip simulated /> : null}
      </span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
        <SourceChip source={lead.firstSource} />
        {lead.city ? <span>{lead.city}</span> : null}
      </span>
      <span className="flex items-center gap-2 text-xs">
        {lead.score === null ? (
          <span className="text-fg-2">Not scored</span>
        ) : (
          <>
            <span className="tabular text-fg-1">{`${lead.score} / 100`}</span>
            <ScoreMeter value={lead.score} animate={false} />
          </>
        )}
      </span>
      {props.canMove ? <StageMoveMenu lead={lead} workspaceSlug={props.workspaceSlug} className="self-start" /> : null}
    </li>
  );
}

export function LeadBoard(props: {
  columns: BoardColumnDto[];
  /** Null when the viewer may move leads; otherwise why not (permission). */
  moveGate: Gate | null;
  workspaceSlug?: string;
  /** Where the full list lives, for a column that shows only its newest cards. */
  tableHref: string;
}) {
  const canMove = props.moveGate === null;
  const { move } = useStageMove(props.workspaceSlug);
  const [dragging, setDragging] = useState<LeadRowDto | null>(null);
  const [over, setOver] = useState<SalesStage | null>(null);
  const [lostFor, setLostFor] = useState<StageLead | null>(null);

  function allowDrop(stage: SalesStage, e: DragEvent<HTMLElement>) {
    if (!canMove || dragging === null || dragging.salesStage === stage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (over !== stage) setOver(stage);
  }

  function drop(stage: SalesStage, e: DragEvent<HTMLElement>) {
    e.preventDefault();
    const lead = dragging;
    setOver(null);
    setDragging(null);
    if (!canMove || lead === null || lead.salesStage === stage) return;
    if (stage === 'LOST') setLostFor(lead);
    else void move(lead, stage);
  }

  return (
    <div className="flex flex-col gap-3">
      {props.moveGate ? <GatedAction label="Move leads between stages" gate={props.moveGate} size="sm" /> : null}
      {canMove ? <p className="text-xs text-fg-2">Drag a card to another column, or use its &quot;Move to stage&quot; menu (Enter opens it, arrow keys choose).</p> : null}
      <div className="relative -mx-1 overflow-x-auto pb-2">
        <ol aria-label="Leads by sales stage" className="flex min-w-max gap-3 px-1">
          {props.columns.map((column) => {
            const shown = column.rows.length;
            return (
              <li
                key={column.stage}
                data-board-column={column.stage}
                data-drop-active={over === column.stage ? '' : undefined}
                onDragOver={(e) => allowDrop(column.stage, e)}
                onDragEnter={(e) => allowDrop(column.stage, e)}
                onDragLeave={() => setOver((s) => (s === column.stage ? null : s))}
                onDrop={(e) => drop(column.stage, e)}
                className={cn(
                  'flex w-64 shrink-0 flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1/80 p-3 transition-[border-color,box-shadow] duration-fast',
                  over === column.stage && 'border-panel/60 ring-2 ring-panel/40',
                )}
              >
                <h3 className="flex items-center justify-between gap-2">
                  <StageChip stage={column.stage} />
                  <span className="tabular rounded-full border border-border-subtle bg-bg-2 px-2 py-0.5 text-xs text-fg-1">
                    <span className="sr-only">Leads in this stage: </span>
                    {cappedCountText(column.total)}
                  </span>
                </h3>
                {shown === 0 ? (
                  <p className="rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-fg-2">No leads in this stage.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {column.rows.map((lead) => (
                      <Card key={lead.id} lead={lead} canMove={canMove} workspaceSlug={props.workspaceSlug} onDragStart={setDragging} onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }} />
                    ))}
                  </ul>
                )}
                {column.total.capped || column.total.count > shown ? (
                  <p className="text-xs text-fg-2">
                    Showing the first {shown} of {cappedCountText(column.total)}.{' '}
                    <Link href={props.tableHref} className="font-medium text-cyan underline-offset-4 hover:underline">
                      Page through them in the table
                    </Link>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
      <LostReasonDialog lead={lostFor} onClose={() => setLostFor(null)} onConfirm={(reason) => move(lostFor!, 'LOST', reason, { inline: true })} />
    </div>
  );
}
