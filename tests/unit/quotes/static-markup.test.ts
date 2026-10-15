/**
 * T16: the static markup renderer behind the public quote page (route handlers run in the React
 * Server Components layer, where react-dom/server is unavailable). It must escape every text
 * and attribute value, refuse anything that could carry script (event handlers, raw HTML,
 * script or style text from data), and render host elements, fragments and function components.
 */
import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';
import { renderStaticMarkup } from '@/components/quote/static-markup';

describe('renderStaticMarkup', () => {
  it('renders elements, attributes, styles, fragments, arrays and function components', () => {
    const Item = ({ label }: { label: string }) => createElement('li', { className: 'item', 'data-field': 'x' }, label);
    const html = renderStaticMarkup(
      createElement(
        'div',
        { id: 'root', style: { marginTop: 4, backgroundColor: '#fff' }, 'aria-hidden': true, hidden: false },
        createElement(Fragment, null, createElement('ul', null, [createElement(Item, { key: 'a', label: 'One' }), createElement(Item, { key: 'b', label: 'Two' })])),
        createElement('br'),
        createElement('label', { htmlFor: 'n' }, 'Name'),
        createElement('input', { id: 'n', name: 'n', required: true, defaultValue: 'v' }),
        null,
        false,
        0,
      ),
    );
    expect(html).toBe(
      '<div id="root" style="margin-top:4px;background-color:#fff" aria-hidden="true"><ul><li class="item" data-field="x">One</li><li class="item" data-field="x">Two</li></ul><br><label for="n">Name</label><input id="n" name="n" required value="v">0</div>',
    );
  });

  it('escapes text and attribute values', () => {
    const html = renderStaticMarkup(createElement('p', { title: '"><script>alert(1)</script>' }, '<img src=x onerror=alert(1)> & \'quotes\''));
    expect(html).toBe('<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quotes&#39;</p>');
  });

  it('refuses event handlers, raw HTML and unsafe attribute names', () => {
    expect(() => renderStaticMarkup(createElement('button', { onClick: () => undefined }, 'x'))).toThrow(/handler/);
    expect(() => renderStaticMarkup(createElement('div', { dangerouslySetInnerHTML: { __html: '<b>x</b>' } }))).toThrow(/raw HTML/);
    expect(() => renderStaticMarkup(createElement('div', { 'x" onload="y': '1' }))).toThrow(/attribute/);
  });

  it('keeps script and style text raw but refuses a closing tag inside it', () => {
    expect(renderStaticMarkup(createElement('style', { nonce: 'n1' }, 'a>b{color:red}'))).toBe('<style nonce="n1">a>b{color:red}</style>');
    expect(() => renderStaticMarkup(createElement('script', null, 'x="</script><b>"'))).toThrow(/closing tag/);
    expect(() => renderStaticMarkup(createElement('script', null, ['a', 'b']))).toThrow(/single string/);
  });

  it('refuses unknown element types', () => {
    class Legacy {}
    expect(() => renderStaticMarkup(createElement(Legacy as never))).toThrow();
  });
});
