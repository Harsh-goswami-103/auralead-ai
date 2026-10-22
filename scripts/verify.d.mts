export type VerifyStep = { id: string; title: string; args: string[]; env?: Record<string, string> };
export type EvidenceRow = { integration: string; implemented: string; fixtureTested: string; demoVerified: string; liveVerified: string };
export type EvidenceCheck = { ok: true; claimed: boolean } | { ok: false; claimed: true; why: string };

export const STEPS: VerifyStep[];
export function parseEvidenceMatrix(markdown: string): EvidenceRow[];
export function checkLiveEvidence(row: EvidenceRow, exists?: (relativePath: string) => boolean): EvidenceCheck;
