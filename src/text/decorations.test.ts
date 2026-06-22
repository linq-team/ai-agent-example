import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecorations, processResponse, cleanResponse } from './decorations.js';

describe('parseDecorations', () => {
  it('returns plain text unchanged', () => {
    const result = parseDecorations('hello world');
    assert.equal(result.text, 'hello world');
    assert.deepEqual(result.decorations, []);
  });

  it('parses a single style decoration', () => {
    const result = parseDecorations('{bold:hello} world');
    assert.equal(result.text, 'hello world');
    assert.deepEqual(result.decorations, [
      { range: [0, 5], style: 'bold' },
    ]);
  });

  it('parses a single animation decoration', () => {
    const result = parseDecorations('oh {shake:no}!');
    assert.equal(result.text, 'oh no!');
    assert.deepEqual(result.decorations, [
      { range: [3, 5], animation: 'shake' },
    ]);
  });

  it('parses multiple decorations in one string', () => {
    const result = parseDecorations('{bold:Hello} {shake:world}');
    assert.equal(result.text, 'Hello world');
    assert.deepEqual(result.decorations, [
      { range: [0, 5], style: 'bold' },
      { range: [6, 11], animation: 'shake' },
    ]);
  });

  it('handles all style types', () => {
    const styles = ['bold', 'italic', 'strikethrough', 'underline'] as const;
    for (const style of styles) {
      const result = parseDecorations(`{${style}:text}`);
      assert.equal(result.text, 'text');
      assert.equal(result.decorations.length, 1);
      assert.equal(result.decorations[0].style, style);
      assert.deepEqual(result.decorations[0].range, [0, 4]);
    }
  });

  it('handles all animation types', () => {
    const animations = ['big', 'small', 'shake', 'nod', 'explode', 'ripple', 'bloom', 'jitter'] as const;
    for (const anim of animations) {
      const result = parseDecorations(`{${anim}:text}`);
      assert.equal(result.text, 'text');
      assert.equal(result.decorations.length, 1);
      assert.equal(result.decorations[0].animation, anim);
      assert.deepEqual(result.decorations[0].range, [0, 4]);
    }
  });

  it('computes correct ranges with text before and after', () => {
    const result = parseDecorations('hey u really {explode:killed it} today');
    assert.equal(result.text, 'hey u really killed it today');
    assert.deepEqual(result.decorations, [
      { range: [13, 22], animation: 'explode' },
    ]);
  });

  it('handles multiple decorations with varying gap text', () => {
    const result = parseDecorations('a {bold:b} c {italic:d} e');
    assert.equal(result.text, 'a b c d e');
    assert.deepEqual(result.decorations, [
      { range: [2, 3], style: 'bold' },
      { range: [6, 7], style: 'italic' },
    ]);
  });

  it('handles decoration at end of string', () => {
    const result = parseDecorations('check this {shake:out}');
    assert.equal(result.text, 'check this out');
    assert.deepEqual(result.decorations, [
      { range: [11, 14], animation: 'shake' },
    ]);
  });

  it('handles decoration at start of string', () => {
    const result = parseDecorations('{big:WOW} thats cool');
    assert.equal(result.text, 'WOW thats cool');
    assert.deepEqual(result.decorations, [
      { range: [0, 3], animation: 'big' },
    ]);
  });

  it('handles entire string as one decoration', () => {
    const result = parseDecorations('{explode:BOOM}');
    assert.equal(result.text, 'BOOM');
    assert.deepEqual(result.decorations, [
      { range: [0, 4], animation: 'explode' },
    ]);
  });

  it('handles adjacent decorations with no gap', () => {
    const result = parseDecorations('{bold:hello}{italic:world}');
    assert.equal(result.text, 'helloworld');
    assert.deepEqual(result.decorations, [
      { range: [0, 5], style: 'bold' },
      { range: [5, 10], style: 'italic' },
    ]);
  });

  it('drops overlapping markers (first wins)', () => {
    // Construct a scenario where markers overlap — this would be unusual
    // but the parser should handle it gracefully
    const result = parseDecorations('{bold:a{italic:b}c}');
    // {bold:...} matches first and captures "a{italic:b}c" minus the closing }
    // Wait — the regex is [^}]+ so it stops at the first }
    // {bold:a{italic:b} matches {bold: then "a{italic:b" then }
    // Actually no — let me think. regex: \{bold:([^}]+)\}
    // Input: {bold:a{italic:b}c}
    // The [^}]+ will match "a{italic:b" (stops at first })
    // So {bold:a{italic:b} is the full match, with content "a{italic:b"
    // Then "c}" is leftover text
    assert.equal(result.text, 'a{italic:bc}');
    assert.equal(result.decorations.length, 1);
    assert.equal(result.decorations[0].style, 'bold');
  });

  it('ignores unknown decoration names', () => {
    const result = parseDecorations('{unknown:text}');
    assert.equal(result.text, '{unknown:text}');
    assert.deepEqual(result.decorations, []);
  });

  it('handles empty content gracefully', () => {
    // {bold:} won't match because [^}]+ requires at least one char
    const result = parseDecorations('{bold:}');
    assert.equal(result.text, '{bold:}');
    assert.deepEqual(result.decorations, []);
  });

  it('preserves emoji in content', () => {
    const result = parseDecorations('{shake:🔥🔥🔥}');
    assert.equal(result.text, '🔥🔥🔥');
    assert.equal(result.decorations.length, 1);
    assert.equal(result.decorations[0].animation, 'shake');
  });

  it('handles multiple same-type decorations', () => {
    const result = parseDecorations('{bold:one} and {bold:two}');
    assert.equal(result.text, 'one and two');
    assert.deepEqual(result.decorations, [
      { range: [0, 3], style: 'bold' },
      { range: [8, 11], style: 'bold' },
    ]);
  });
});

describe('processResponse', () => {
  describe('iMessage (isIMessage = true)', () => {
    it('parses decorations and returns them', () => {
      const result = processResponse('thats {bold:insane}', true);
      assert.equal(result.text, 'thats insane');
      assert.deepEqual(result.decorations, [
        { range: [6, 12], style: 'bold' },
      ]);
    });

    it('cleans up whitespace quirks while preserving decorations', () => {
      const result = processResponse('  {shake:hello}  world  ', true);
      // parseDecorations → text: '  hello  world  ', decoration at [2,7]
      // trim leading 2 spaces → 'hello world', range adjusted to [0,5]
      assert.equal(result.text, 'hello world');
      assert.deepEqual(result.decorations, [
        { range: [0, 5], animation: 'shake' },
      ]);
    });

    it('returns no decorations for plain text', () => {
      const result = processResponse('just normal text', true);
      assert.equal(result.text, 'just normal text');
      assert.deepEqual(result.decorations, []);
    });

    it('handles animation decorations', () => {
      const result = processResponse('{explode:BOOM}', true);
      assert.equal(result.text, 'BOOM');
      assert.deepEqual(result.decorations, [
        { range: [0, 4], animation: 'explode' },
      ]);
    });
  });

  describe('SMS/RCS (isIMessage = false)', () => {
    it('strips decoration syntax and returns plain text', () => {
      const result = processResponse('thats {bold:insane}', false);
      assert.equal(result.text, 'thats insane');
      assert.deepEqual(result.decorations, []);
    });

    it('strips animation syntax too', () => {
      const result = processResponse('{shake:EARTHQUAKE}', false);
      assert.equal(result.text, 'EARTHQUAKE');
      assert.deepEqual(result.decorations, []);
    });

    it('strips multiple decorations', () => {
      const result = processResponse('{bold:hello} {shake:world}', false);
      assert.equal(result.text, 'hello world');
      assert.deepEqual(result.decorations, []);
    });

    it('also strips markdown formatting', () => {
      const result = processResponse('**bold** and *italic*', false);
      assert.equal(result.text, 'bold and italic');
      assert.deepEqual(result.decorations, []);
    });

    it('strips decorations AND markdown together', () => {
      const result = processResponse('**hey** {shake:whoa}', false);
      assert.equal(result.text, 'hey whoa');
      assert.deepEqual(result.decorations, []);
    });
  });
});

describe('cleanResponse', () => {
  it('strips markdown bold', () => {
    assert.equal(cleanResponse('**hello**'), 'hello');
  });

  it('strips markdown italic', () => {
    assert.equal(cleanResponse('*hello*'), 'hello');
  });

  it('strips markdown underline/italic', () => {
    assert.equal(cleanResponse('_hello_'), 'hello');
  });

  it('collapses multiple spaces', () => {
    assert.equal(cleanResponse('hello   world'), 'hello world');
  });

  it('trims whitespace', () => {
    assert.equal(cleanResponse('  hello  '), 'hello');
  });

  it('converts newline-dash to inline dash', () => {
    assert.equal(cleanResponse('hello\n - world'), 'hello - world');
  });
});
