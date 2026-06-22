import { TextDecoration } from '../linq/client.js';

// All decoration names (styles + animations) for the {name:content} syntax
const DECORATION_STYLES = ['bold', 'italic', 'strikethrough', 'underline'] as const;
const DECORATION_ANIMATIONS = ['big', 'small', 'shake', 'nod', 'explode', 'ripple', 'bloom', 'jitter'] as const;
const ALL_DECORATIONS = [...DECORATION_STYLES, ...DECORATION_ANIMATIONS];

// Parse {decoration:content} markup into plain text + text_decorations array
// Used for iMessage only — SMS/RCS uses cleanResponse() which strips everything
export function parseDecorations(input: string): { text: string; decorations: TextDecoration[] } {
  // Phase 1: Find all {decoration:content} markers in original text
  interface Marker {
    fullStart: number;
    fullEnd: number;
    contentStart: number;
    contentEnd: number;
    decoration: TextDecoration['style'] | TextDecoration['animation'];
    isStyle: boolean;
  }

  const markers: Marker[] = [];

  for (const name of ALL_DECORATIONS) {
    const regex = new RegExp(`\\{${name}:([^}]+)\\}`, 'g');
    let match;
    while ((match = regex.exec(input)) !== null) {
      markers.push({
        fullStart: match.index,
        fullEnd: match.index + match[0].length,
        contentStart: match.index + name.length + 2, // skip {name:
        contentEnd: match.index + match[0].length - 1, // skip }
        decoration: name as TextDecoration['style'] | TextDecoration['animation'],
        isStyle: (DECORATION_STYLES as readonly string[]).includes(name),
      });
    }
  }

  // Sort by position, remove overlapping markers (first match wins)
  markers.sort((a, b) => a.fullStart - b.fullStart);
  const validMarkers: Marker[] = [];
  let lastEnd = -1;
  for (const m of markers) {
    if (m.fullStart >= lastEnd) {
      validMarkers.push(m);
      lastEnd = m.fullEnd;
    }
  }

  // Phase 2: Build clean text and compute decoration ranges
  let cleanText = '';
  const decorations: TextDecoration[] = [];
  let i = 0;
  let markerIdx = 0;

  while (i < input.length) {
    if (markerIdx < validMarkers.length && i === validMarkers[markerIdx].fullStart) {
      const marker = validMarkers[markerIdx];
      const content = input.slice(marker.contentStart, marker.contentEnd);
      const decoStart = cleanText.length;
      cleanText += content;
      const decoEnd = cleanText.length;

      const deco: TextDecoration = { range: [decoStart, decoEnd] };
      if (marker.isStyle) {
        deco.style = marker.decoration as TextDecoration['style'];
      } else {
        deco.animation = marker.decoration as TextDecoration['animation'];
      }
      decorations.push(deco);

      i = marker.fullEnd;
      markerIdx++;
    } else {
      cleanText += input[i];
      i++;
    }
  }

  return { text: cleanText, decorations };
}

// Clean up LLM response formatting quirks before sending (SMS/RCS)
export function cleanResponse(text: string): string {
  return text
    .replace(/\n\s*-\s*/g, ' - ')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// For iMessage: parse decorations then clean up remaining formatting quirks
// For SMS/RCS: strip all markup including decoration syntax
export function processResponse(text: string, isIMessage: boolean): { text: string; decorations: TextDecoration[] } {
  if (isIMessage) {
    const { text: parsed, decorations } = parseDecorations(text);
    const cleaned = parsed
      .replace(/\n\s*-\s*/g, ' - ')
      .replace(/  +/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const trimmedLeading = parsed.length - parsed.trimStart().length;
    const adjustedDecorations = trimmedLeading > 0
      ? decorations.map(d => ({
          ...d,
          range: [d.range[0] - trimmedLeading, d.range[1] - trimmedLeading] as [number, number],
        })).filter(d => d.range[1] > 0)
      : decorations;

    return { text: cleaned, decorations: adjustedDecorations };
  }

  // SMS/RCS: strip everything including decoration syntax
  let stripped = text;
  for (const name of ALL_DECORATIONS) {
    stripped = stripped.replace(new RegExp(`\\{${name}:([^}]+)\\}`, 'g'), '$1');
  }
  return { text: cleanResponse(stripped), decorations: [] };
}
