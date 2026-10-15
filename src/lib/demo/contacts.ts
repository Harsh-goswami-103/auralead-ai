/**
 * Deterministic fictitious contacts for the DEMO source simulators (T11, R11). Every value is a
 * pure function of a seed string, so a simulated batch replayed with the same id has the same
 * content (and replays as a duplicate), while different batch ids give different people.
 *
 * Phones are well-formed Indian mobile numbers that pass libphonenumber validation (the caller
 * checks and moves to the next candidate when one does not); emails use the `demo-leads.in`
 * domain. DEMO makes zero outbound calls, so none of these is ever contacted.
 */
import { parsePhone } from '../phone';

/** FNV-1a 32-bit over the UTF-16 code units: stable, fast, no crypto needed. */
export function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function pick<T>(seed: string, list: readonly T[]): T {
  if (list.length === 0) throw new RangeError('pick: empty list');
  return list[seedHash(seed) % list.length]!;
}

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Ishaan', 'Kavya', 'Vihaan', 'Ananya', 'Arjun', 'Meera', 'Rohan', 'Saanvi', 'Kabir', 'Aditi',
  'Nikhil', 'Pooja', 'Siddharth', 'Riya', 'Aditya', 'Neha', 'Karthik', 'Lakshmi', 'Farhan', 'Zoya', 'Harpreet', 'Tanvi',
] as const;
const LAST_NAMES = [
  'Sharma', 'Iyer', 'Reddy', 'Nair', 'Gupta', 'Kapoor', 'Menon', 'Patel', 'Rao', 'Banerjee', 'Singh', 'Joshi',
  'Kulkarni', 'Chatterjee', 'Pillai', 'Khan', 'Desai', 'Bhat', 'Saxena', 'Verma',
] as const;
export const DEMO_CITIES = ['Gurugram', 'Noida', 'New Delhi', 'Mumbai', 'Pune', 'Bengaluru', 'Hyderabad', 'Chennai'] as const;

const MOBILE_LEADS = ['98', '99', '97', '96', '93', '90', '88', '87', '81', '70'] as const;

/** A valid Indian mobile number in display form (`+91 98xxx xxxxx`). */
export function demoMobile(seed: string): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const h = seedHash(`${seed}#${attempt}`);
    const lead = pick(`${seed}#lead${attempt}`, MOBILE_LEADS);
    const rest = String(h % 100_000_000).padStart(8, '0');
    const digits = `${lead}${rest}`;
    const display = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    if (parsePhone(display).valid) return display;
  }
  throw new Error(`demoMobile: no valid number for seed ${seed}`);
}

export type DemoPerson = { name: string; phone: string; email: string; city: string };

export function demoPerson(seed: string): DemoPerson {
  const first = pick(`${seed}:first`, FIRST_NAMES);
  const last = pick(`${seed}:last`, LAST_NAMES);
  const n = seedHash(`${seed}:n`) % 90 + 10;
  return {
    name: `${first} ${last}`,
    phone: demoMobile(`${seed}:phone`),
    email: `${first}.${last}${n}@demo-leads.in`.toLowerCase(),
    city: pick(`${seed}:city`, DEMO_CITIES),
  };
}

const BUSINESS_KINDS = [
  { category: 'Dental clinic', words: ['Smile', 'Dental Care', 'Tooth Studio'] },
  { category: 'Gym', words: ['Fitness', 'Strength Club', 'Gym'] },
  { category: 'Bakery', words: ['Bakehouse', 'Patisserie', 'Bakers'] },
  { category: 'Salon', words: ['Salon', 'Hair Studio', 'Beauty Lounge'] },
  { category: 'Interior designer', words: ['Interiors', 'Design Studio', 'Living Spaces'] },
  { category: 'Coaching centre', words: ['Academy', 'Classes', 'Learning Centre'] },
] as const;
const BUSINESS_PREFIXES = ['Shree', 'Royal', 'Urban', 'Green Leaf', 'Sunrise', 'Lotus', 'Prime', 'Golden', 'Nova', 'Kesar'] as const;
const LOCALITIES = ['Sector 29', 'Indiranagar', 'Bandra West', 'Koramangala', 'DLF Phase 3', 'Andheri East', 'HSR Layout', 'Sector 18'] as const;

export type DemoBusiness = {
  placeId: string;
  name: string;
  phone: string;
  website: string | null;
  address: string;
  city: string;
  category: string;
  rating: number;
  reviewCount: number;
};

export function demoBusiness(seed: string): DemoBusiness {
  const kind = pick(`${seed}:kind`, BUSINESS_KINDS);
  const prefix = pick(`${seed}:prefix`, BUSINESS_PREFIXES);
  const word = pick(`${seed}:word`, kind.words);
  const name = `${prefix} ${word}`;
  const city = pick(`${seed}:city`, DEMO_CITIES);
  const hasWebsite = seedHash(`${seed}:web`) % 3 !== 0;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return {
    placeId: `ChIJdemo${seedHash(`${seed}:place`).toString(36)}`,
    name,
    phone: demoMobile(`${seed}:phone`),
    website: hasWebsite ? `https://www.${slug}${seedHash(`${seed}:n`) % 100}.in` : null,
    address: `${seedHash(`${seed}:no`) % 300 + 1}, ${pick(`${seed}:loc`, LOCALITIES)}, ${city}`,
    city,
    category: kind.category,
    /** Stars, one decimal (3.5 to 4.9), as Maps shows them. */
    rating: (35 + (seedHash(`${seed}:rating`) % 15)) / 10,
    reviewCount: 5 + (seedHash(`${seed}:reviews`) % 900),
  };
}
