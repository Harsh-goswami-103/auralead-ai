// R14 (T12): the opportunity score is a pure function of the lead's stored fields and one
// versioned ScoringConfigVersion. Every point is explained by a reason, unknown inputs contribute
// 0 and are listed separately, and the caption says what the number is not.
import { describe, expect, it } from 'vitest';
import { SCORE_CAPTION, SCORE_INPUTS, parseScoringConfig, scoringConfigSchema, type ScoringConfig } from '@/lib/schemas/scoring';
import { scoreLead, type ScoreInput } from '@/server/services/scoring/score';
import { SCORING_V1 } from '../../../prisma/seed/fixtures/configs';

const V1 = { id: 'scv_1', version: 1, config: parseScoringConfig(SCORING_V1) };

const FULL: ScoreInput = {
  phoneE164: '+919876543210',
  emailNormalized: 'hello@clinic.example',
  websiteStatus: 'REACHABLE',
  rating: 50,
  reviewCount: 250,
  category: 'Dental clinic',
  firstSource: 'META_ADS',
};

const BARE: ScoreInput = {
  phoneE164: '+919876543210',
  emailNormalized: null,
  websiteStatus: 'UNKNOWN',
  rating: null,
  reviewCount: null,
  category: null,
  firstSource: 'GMAPS_EXTENSION',
};

function sumOf(reasons: { points: number }[]) {
  return reasons.reduce((s, r) => s + r.points, 0);
}

function withConfig(patch: Partial<ScoringConfig>, version = 2) {
  return { id: `scv_${version}`, version, config: parseScoringConfig({ ...SCORING_V1, ...patch }) };
}

describe('scoring config schema', () => {
  it('accepts the seeded v1 config', () => {
    expect(scoringConfigSchema.safeParse(SCORING_V1).success).toBe(true);
    expect(Object.keys(V1.config.weights).sort()).toEqual([...SCORE_INPUTS].sort());
  });

  it('rejects weights that do not sum to 100, negative or fractional weights, and unknown inputs', () => {
    const bad = [
      { ...SCORING_V1, weights: { ...SCORING_V1.weights, phonePresent: 16 } },
      { ...SCORING_V1, weights: { ...SCORING_V1.weights, phonePresent: -15, emailPresent: 40 } },
      { ...SCORING_V1, weights: { ...SCORING_V1.weights, phonePresent: 14.5, emailPresent: 10.5 } },
      { ...SCORING_V1, weights: { ...SCORING_V1.weights, intentToBuy: 0 } },
      { ...SCORING_V1, schemaVersion: 2 },
    ];
    for (const config of bad) expect(scoringConfigSchema.safeParse(config).success).toBe(false);
    expect(() => parseScoringConfig({ nope: true })).toThrow(expect.objectContaining({ code: 'SCORING_CONFIG_INVALID' }));
  });
});

describe('scoreLead', () => {
  it('reasons sum exactly to the score, each within its configured weight', () => {
    for (const input of [FULL, BARE, { ...FULL, rating: 37, reviewCount: 13 }, { ...BARE, websiteStatus: 'VERIFIED_ABSENT' as const }]) {
      const result = scoreLead(input, V1);
      expect(result.score).toBe(sumOf(result.reasons));
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      for (const r of result.reasons) {
        expect(r.points).toBeGreaterThanOrEqual(0);
        expect(r.points).toBeLessThanOrEqual(r.maxPoints);
        expect(r.maxPoints).toBe(V1.config.weights[r.input]);
        expect(r.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('gives unknown inputs weight 0 and lists them, never as a negative signal', () => {
    const result = scoreLead(BARE, V1);
    expect(result.unknownInputs.map((u) => u.input).sort()).toEqual(['categoryMatch', 'rating', 'reviewCount', 'websiteStatus']);
    for (const u of result.unknownInputs) {
      expect(result.reasons.find((r) => r.input === u.input)).toBeUndefined();
      expect(u.label.length).toBeGreaterThan(0);
    }
    expect(result.unknownInputs.find((u) => u.input === 'websiteStatus')?.label).toBe('Website: unknown, not verified absent');
    // Known inputs: phone 15, email 0 (known absent), Maps listing 0.
    expect(result.reasons.map((r) => [r.input, r.points])).toEqual([
      ['phonePresent', 15],
      ['emailPresent', 0],
      ['sourceIntent', 0],
    ]);
    expect(result.score).toBe(15);
  });

  it('treats only REACHABLE and VERIFIED_ABSENT as known website states', () => {
    const statuses = ['UNKNOWN', 'PRESENT_UNVERIFIED', 'REACHABLE', 'UNREACHABLE', 'BLOCKED', 'VERIFIED_ABSENT'] as const;
    const known = statuses.filter((s) => scoreLead({ ...BARE, websiteStatus: s }, V1).reasons.some((r) => r.input === 'websiteStatus'));
    expect(known).toEqual(['REACHABLE', 'VERIFIED_ABSENT']);
    const pts = (s: (typeof statuses)[number], cfg = V1) => scoreLead({ ...BARE, websiteStatus: s }, cfg).reasons.find((r) => r.input === 'websiteStatus')!.points;
    expect(pts('REACHABLE')).toBe(20);
    expect(pts('VERIFIED_ABSENT')).toBe(0);
    // A workspace that sells websites can prefer leads without one.
    const absentPreferred = withConfig({ websitePreference: 'ABSENT' });
    expect(pts('REACHABLE', absentPreferred)).toBe(0);
    expect(pts('VERIFIED_ABSENT', absentPreferred)).toBe(20);
  });

  it('scales rating and review count, and matches categories only against configured targets', () => {
    const result = scoreLead({ ...FULL, rating: 45, reviewCount: 50 }, V1);
    expect(result.reasons.find((r) => r.input === 'rating')?.points).toBe(18);
    expect(result.reasons.find((r) => r.input === 'reviewCount')?.points).toBe(8);
    // v1 configures no target categories: the match is unknown, not zero.
    expect(result.unknownInputs.find((u) => u.input === 'categoryMatch')?.reasonCode).toBe('NO_TARGET_CATEGORIES');

    const targeted = withConfig({ targetCategories: ['dental'] });
    expect(scoreLead(FULL, targeted).reasons.find((r) => r.input === 'categoryMatch')?.points).toBe(15);
    expect(scoreLead({ ...FULL, category: 'Gym' }, targeted).reasons.find((r) => r.input === 'categoryMatch')?.points).toBe(0);
    expect(scoreLead(FULL, targeted).score).toBe(100);
  });

  it('is versioned: the result names its config version and another version scores differently', () => {
    const a = scoreLead(FULL, V1);
    expect(a).toMatchObject({ configVersionId: 'scv_1', configVersion: 1 });
    expect(scoreLead(FULL, V1)).toEqual(a);

    const v2 = withConfig({ weights: { phonePresent: 50, emailPresent: 50, websiteStatus: 0, rating: 0, reviewCount: 0, categoryMatch: 0, sourceIntent: 0 } }, 2);
    const b = scoreLead({ ...BARE, emailNormalized: null }, v2);
    expect(b).toMatchObject({ configVersionId: 'scv_2', configVersion: 2, score: 50 });
    expect(scoreLead({ ...BARE, emailNormalized: null }, V1).score).not.toBe(b.score);
  });

  it('carries the fixed "heuristic" caption', () => {
    expect(SCORE_CAPTION).toBe('Heuristic fit score. Not purchase intent or consent.');
    expect(scoreLead(FULL, V1).caption).toBe(SCORE_CAPTION);
  });
});
