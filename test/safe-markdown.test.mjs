import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSafeMarkdown, safeExternalUrl } from '../src/utils/safe-markdown.ts';

test('escapes markdown text and attributes exactly once', () => {
  const html = renderSafeMarkdown('[A & <tag> "quote"](https://example.com?a=1&b=2)');
  assert.equal(html, '<a href="https://example.com?a=1&amp;b=2" rel="nofollow noreferrer">A &amp; &lt;tag&gt; &quot;quote&quot;</a>');
  assert.doesNotMatch(html, /&amp;amp;/);
});

test('escapes image alt text and preserves a safe query string', () => {
  const html = renderSafeMarkdown('![A & <tag> "quote"](https://cdn.example.com/photo.jpg?x=1&y=2)');
  assert.equal(html, '<img src="https://cdn.example.com/photo.jpg?x=1&amp;y=2" alt="A &amp; &lt;tag&gt; &quot;quote&quot;" loading="lazy" referrerpolicy="no-referrer">');
});

test('rejects non-HTTPS and private external destinations', () => {
  assert.equal(safeExternalUrl('http://example.com/menu'), false);
  assert.equal(safeExternalUrl('javascript:alert(1)'), false);
  assert.equal(safeExternalUrl('https://127.0.0.1/menu'), false);
  assert.equal(renderSafeMarkdown('[unsafe](http://example.com/menu)'), '[unsafe](http://example.com/menu)');
});

test('escapes raw HTML before rendering inline markdown', () => {
  const html = renderSafeMarkdown('<script>alert("x")</script> **safe**');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /<strong>safe<\/strong>/);
});

test('preserves private-use characters in plain text', () => {
  const privateUse = '\uE0000\uE001';
  assert.equal(renderSafeMarkdown(privateUse), privateUse);
});

test('preserves private-use characters around rendered links', () => {
  const privateUse = '\uE0000\uE001';
  const html = renderSafeMarkdown(`${privateUse} [safe](https://example.com?a=1&b=2) ${privateUse}`);
  assert.equal(html, `${privateUse} <a href="https://example.com?a=1&amp;b=2" rel="nofollow noreferrer">safe</a> ${privateUse}`);
});
