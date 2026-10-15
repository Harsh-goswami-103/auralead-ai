/**
 * A small static HTML renderer for presentational React trees (T16).
 *
 * The public quote page is served by a route handler so it can answer 404, 410 and 429 with the
 * right status (C3, plan §9 rate limits); App Router pages can only produce 200, 404, 401 and 403.
 * Route handlers run in the React Server Components layer, where `react-dom/server` is not
 * available, so the page's elements are serialized here. Scope is deliberately narrow:
 *  - host elements, fragments, arrays, strings, numbers and plain function components (no hooks,
 *    no context, no class components);
 *  - every text node and attribute value is HTML-escaped;
 *  - event handlers, `dangerouslySetInnerHTML`, unsafe attribute names and anything else that
 *    could carry script are refused with an error;
 *  - `<script>` and `<style>` take exactly one constant string child, written raw, and may not
 *    contain a closing tag. Page data never goes into them (it travels in data attributes).
 */
import type { ReactNode } from 'react';

const ELEMENT_TYPES = new Set([Symbol.for('react.transitional.element'), Symbol.for('react.element')]);
const FRAGMENT = Symbol.for('react.fragment');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9:_.-]*$/;
const TAG_NAME = /^[a-z][a-z0-9-]*$/;
const RENAMED: Record<string, string> = { className: 'class', htmlFor: 'for', defaultValue: 'value', defaultChecked: 'checked', acceptCharset: 'accept-charset', httpEquiv: 'http-equiv', charSet: 'charset' };
const SKIPPED = new Set(['children', 'key', 'ref']);
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom']);

type AnyElement = { $$typeof: symbol; type: unknown; props: Record<string, unknown> };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

function isElement(node: unknown): node is AnyElement {
  return typeof node === 'object' && node !== null && ELEMENT_TYPES.has((node as { $$typeof?: symbol }).$$typeof as symbol);
}

function styleString(style: unknown): string {
  if (typeof style !== 'object' || style === null) throw new Error('static markup: style must be an object');
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(style as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === false) continue;
    if (!/^[a-zA-Z]+$/.test(key)) throw new Error(`static markup: invalid style property ${key}`);
    const prop = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const value = typeof raw === 'number' && raw !== 0 && !UNITLESS.has(key) ? `${raw}px` : String(raw);
    if (/[;{}<>]/.test(value)) throw new Error(`static markup: unsafe style value for ${key}`);
    parts.push(`${prop}:${value}`);
  }
  return parts.join(';');
}

function attributes(props: Record<string, unknown>): string {
  let out = '';
  for (const [name, value] of Object.entries(props)) {
    if (SKIPPED.has(name)) continue;
    if (name === 'dangerouslySetInnerHTML') throw new Error('static markup: raw HTML (dangerouslySetInnerHTML) is not allowed');
    if (typeof value === 'function' || /^on[A-Z]/.test(name)) throw new Error(`static markup: event handler ${name} is not allowed`);
    if (!ATTR_NAME.test(name)) throw new Error(`static markup: invalid attribute name ${JSON.stringify(name)}`);
    if (value === null || value === undefined || value === false) continue;
    const attr = RENAMED[name] ?? name;
    if (name === 'style') {
      const css = styleString(value);
      if (css) out += ` style="${escapeHtml(css)}"`;
      continue;
    }
    if (value === true) {
      out += attr.startsWith('aria-') || attr.startsWith('data-') ? ` ${attr}="true"` : ` ${attr}`;
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`static markup: attribute ${name} must be a string, number or boolean`);
    out += ` ${attr}="${escapeHtml(String(value))}"`;
  }
  return out;
}

function rawText(tag: string, children: unknown): string {
  if (children === undefined || children === null) return '';
  if (typeof children !== 'string') throw new Error(`static markup: <${tag}> takes a single string child`);
  if (/<\//.test(children)) throw new Error(`static markup: <${tag}> text may not contain a closing tag`);
  return children;
}

function render(node: unknown, depth: number): string {
  if (depth > 200) throw new Error('static markup: tree too deep');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return escapeHtml(node);
  if (typeof node === 'number' || typeof node === 'bigint') return escapeHtml(String(node));
  if (Array.isArray(node)) return node.map((n) => render(n, depth + 1)).join('');
  if (!isElement(node)) throw new Error('static markup: unsupported node');
  const { type, props } = node;
  if (type === FRAGMENT) return render(props.children, depth + 1);
  if (typeof type === 'function') return render((type as (p: Record<string, unknown>) => unknown)(props), depth + 1);
  if (typeof type !== 'string' || !TAG_NAME.test(type)) throw new Error('static markup: unsupported element type');
  const open = `<${type}${attributes(props)}>`;
  if (VOID.has(type)) {
    if (props.children !== undefined && props.children !== null) throw new Error(`static markup: <${type}> cannot have children`);
    return open;
  }
  const inner = RAW_TEXT.has(type) ? rawText(type, props.children) : render(props.children, depth + 1);
  return `${open}${inner}</${type}>`;
}

/** Serializes a presentational element tree to HTML. Throws on anything outside the safe subset. */
export function renderStaticMarkup(node: ReactNode): string {
  return render(node, 0);
}

/** A full document: the doctype plus the rendered `<html>` element. */
export function renderStaticDocument(node: ReactNode): string {
  return `<!DOCTYPE html>${renderStaticMarkup(node)}`;
}
