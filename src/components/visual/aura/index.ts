/*
 * Public surface of the AuraLead 3D visual (design spec §3). Pages use the wrappers: AuraHero
 * (landing), AuraAuthBackdrop (/login, /invite) and AuraTile (command center, >= 1440px). The WebGL
 * scene module (AuraScene) is deliberately not exported: AuraVisual reaches it only through
 * next/dynamic({ ssr: false }), so importing from here never pulls three into a page bundle.
 */
export { AuraAuthBackdrop, AuraHero, AuraTile, AuraVisual, type AuraVisualProps } from './AuraVisual';
export { AuraPoster } from './AuraPoster';
export { decideBudget, useVisualBudget, type BudgetInputs, type VisualBudget } from './visual-budget';
export { AURA_COLORS, heroAnchors, heroAspect, type AuraPreset, type AuraStreamKey, type AuraTier } from './aura-layout';
