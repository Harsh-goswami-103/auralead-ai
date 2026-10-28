// ADR-118 (slice F1, P1): the rules of website email extraction. Addresses come from mailto links
// and page text (encoded @ included), never from file names; placeholders and the run's blacklist
// are dropped; each kept address is ROLE, PERSONAL or FREEMAIL; at most two same-host contact pages
// are followed; robots.txt is honoured for our bot's own group, else `*`, longest match winning.
import { describe, expect, it } from 'vitest';
import { blacklisted, contactPageUrls, emailCandidates, emailKind, isPlaceholder, isPlausibleAddress, keepEmails, mergeEmails, robotsAllows, robotsRules } from '@/server/services/lead-finder/email-extract';

const PAGE = `<html><body>
<a href="mailto:Info@Sharma-Sweets.in?subject=Hi">Write to us</a>
<p>Owner: rahul.sharma&#64;sharma-sweets.in, orders [at] nowhere</p>
<img src="/img/logo@2x.png"> <p>Example: your@email.com or name@example.com</p>
<a href="mailto:sales%40sharma-sweets.in,care@sharma-sweets.in">Sales</a>
<p>Personal mail: sharmasweets@gmail.com</p>
<a href="/contact-us">Contact</a> <a href="https://other.example.in/contact">Partner</a>
<a href="/about"><span>About us</span></a> <a href="/menu">Menu</a> <a href="/enquiry">Enquiry</a>
</body></html>`;

describe('candidates and filters', () => {
  it('reads mailto links and text, decoding entities and percent-encoding', () => {
    const c = emailCandidates(PAGE);
    expect(c).toEqual(expect.arrayContaining(['info@sharma-sweets.in', 'sales@sharma-sweets.in', 'care@sharma-sweets.in', 'rahul.sharma@sharma-sweets.in', 'sharmasweets@gmail.com']));
    expect(c).not.toContain('orders@nowhere');
  });

  it('drops file names, placeholders and implausible addresses', () => {
    expect(isPlausibleAddress('logo@2x.png')).toBe(false);
    expect(isPlausibleAddress('a..b@shop.in')).toBe(false);
    expect(isPlausibleAddress('hello@shop.in')).toBe(true);
    for (const a of ['your@email.com', 'name@example.com', 'info@yourdomain.in', 'noreply@shop.in']) expect(isPlaceholder(a), a).toBe(true);
    expect(isPlaceholder('info@shop.in')).toBe(false);
  });

  it('applies the blacklist to whole addresses and to domains with their subdomains', () => {
    expect(blacklisted('a@gmail.com', ['gmail.com'])).toBe(true);
    expect(blacklisted('a@mail.shop.in', ['shop.in'])).toBe(true);
    expect(blacklisted('a@notshop.in', ['shop.in'])).toBe(false);
    expect(blacklisted('care@shop.in', ['care@shop.in'])).toBe(true);
    expect(blacklisted('info@shop.in', ['care@shop.in'])).toBe(false);
  });

  it('classifies role, personal and free-mail addresses', () => {
    expect(emailKind('info@shop.in')).toBe('ROLE');
    expect(emailKind('sales2@shop.in')).toBe('ROLE');
    expect(emailKind('rahul.sharma@shop.in')).toBe('PERSONAL');
    expect(emailKind('sharmasweets@gmail.com')).toBe('FREEMAIL');
    expect(emailKind('x@rediffmail.com')).toBe('FREEMAIL');
  });

  it('keeps the page source, de-duplicates and caps', () => {
    const kept = keepEmails(emailCandidates(PAGE), 'https://sharma-sweets.in/', ['gmail.com']);
    expect(kept.map((e) => e.address)).toEqual(['info@sharma-sweets.in', 'sales@sharma-sweets.in', 'care@sharma-sweets.in', 'rahul.sharma@sharma-sweets.in']);
    expect(kept.every((e) => e.sourceUrl === 'https://sharma-sweets.in/')).toBe(true);
    const merged = mergeEmails([kept, [{ address: 'info@sharma-sweets.in', sourceUrl: 'https://sharma-sweets.in/contact', kind: 'ROLE' }]]);
    expect(merged).toHaveLength(4);
    const many = Array.from({ length: 15 }, (_, i) => ({ address: `p${i}@shop.in`, sourceUrl: 'https://shop.in/', kind: 'PERSONAL' as const }));
    expect(mergeEmails([many])).toHaveLength(10);
  });
});

describe('contact pages', () => {
  it('follows at most two same-host links that name a contact page', () => {
    expect(contactPageUrls(PAGE, 'https://sharma-sweets.in/')).toEqual(['https://sharma-sweets.in/contact-us', 'https://sharma-sweets.in/about']);
    expect(contactPageUrls(PAGE, 'https://sharma-sweets.in/', 3)).toEqual(['https://sharma-sweets.in/contact-us', 'https://sharma-sweets.in/about', 'https://sharma-sweets.in/enquiry']);
    expect(contactPageUrls('<a href="javascript:alert(1)">contact</a>', 'https://shop.in/')).toEqual([]);
  });
});

describe('robots.txt', () => {
  it('uses our own group when there is one, else *', () => {
    const txt = 'User-agent: *\nDisallow: /private\n\nUser-agent: AuraLeadBot\nDisallow: /\nAllow: /contact\n';
    const own = robotsRules(txt);
    expect(robotsAllows(own, '/')).toBe(false);
    expect(robotsAllows(own, '/contact')).toBe(true);
    const star = robotsRules('User-agent: *\nDisallow: /private\n# comment\nUser-agent: OtherBot\nDisallow: /\n');
    expect(robotsAllows(star, '/')).toBe(true);
    expect(robotsAllows(star, '/private/x')).toBe(false);
  });

  it('an empty Disallow allows everything; wildcards and $ anchors match', () => {
    expect(robotsAllows(robotsRules('User-agent: *\nDisallow:\n'), '/anything')).toBe(true);
    const rules = robotsRules('User-agent: *\nDisallow: /*.php$\nDisallow: /tmp*\n');
    expect(robotsAllows(rules, '/contact.php')).toBe(false);
    expect(robotsAllows(rules, '/contact.php?x=1')).toBe(true);
    expect(robotsAllows(rules, '/tmpfile')).toBe(false);
    expect(robotsAllows([], '/')).toBe(true);
  });

  it('two agents in one group share its rules', () => {
    const rules = robotsRules('User-agent: Googlebot\nUser-agent: AuraLeadBot\nDisallow: /\n');
    expect(robotsAllows(rules, '/')).toBe(false);
  });
});

describe('hostile input stays linear (adversarial review)', () => {
  it('matches a many-wildcard robots rule against a long path without backtracking', () => {
    const rules = robotsRules(`User-agent: *\nDisallow: /${'*a'.repeat(12)}*b\n`);
    const path = `/contact-${'a'.repeat(300)}`;
    const started = performance.now();
    expect(robotsAllows(rules, path)).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('still matches wildcards in order, with and without the $ anchor', () => {
    const rules = robotsRules('User-agent: *\nDisallow: /a*b*c$\nDisallow: /x*y\nAllow: /x*y*z\n');
    expect(robotsAllows(rules, '/aXbYc')).toBe(false);
    expect(robotsAllows(rules, '/aXbYcZ')).toBe(true);
    expect(robotsAllows(rules, '/acb')).toBe(true);
    expect(robotsAllows(rules, '/x1y')).toBe(false);
    expect(robotsAllows(rules, '/x1y2z')).toBe(true);
    expect(robotsAllows(robotsRules('User-agent: *\nDisallow: /p*$\n'), '/p')).toBe(false);
    expect(robotsAllows(robotsRules('User-agent: *\nDisallow: /ab*b$\n'), '/ab')).toBe(true);
  });

  it('ignores an absurdly long rule and keeps a bounded number of rules', () => {
    const long = `User-agent: *\nDisallow: /${'a*'.repeat(5000)}\n`;
    expect(robotsAllows(robotsRules(long), '/aaaa')).toBe(true);
    const many = `User-agent: *\n${Array.from({ length: 50_000 }, (_, i) => `Disallow: /p${i}`).join('\n')}\n`;
    expect(robotsRules(many).length).toBeLessThanOrEqual(2_000);
  });

  it('finds contact links on a page of many unclosed <a> tags in linear time', () => {
    const html = `${'<a href="/x" '.repeat(80_000)}>`;
    const started = performance.now();
    expect(contactPageUrls(html, 'https://shop.in/')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(contactPageUrls(`<a href="/${'c'.repeat(5000)}-contact">x</a><a href="/contact">Contact</a>`, 'https://shop.in/')).toEqual(['https://shop.in/contact']);
  });
});
