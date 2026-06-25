import { TextDecoration } from '../linq/client.js';

const DECORATION_STYLES = ['bold', 'italic', 'strikethrough', 'underline'] as const;
const DECORATION_ANIMATIONS = ['big', 'small', 'shake', 'nod', 'explode', 'ripple', 'bloom', 'jitter'] as const;
const ALL_DECORATIONS = [...DECORATION_STYLES, ...DECORATION_ANIMATIONS];

export function parseDecorations(input: string): { text: string; decorations: TextDecoration[] } {
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
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      markers.push({
        fullStart: match.index,
        fullEnd: match.index + match[0].length,
        contentStart: match.index + name.length + 2,
        contentEnd: match.index + match[0].length - 1,
        decoration: name as TextDecoration['style'] | TextDecoration['animation'],
        isStyle: (DECORATION_STYLES as readonly string[]).includes(name),
      });
    }
  }

  markers.sort((a, b) => a.fullStart - b.fullStart);
  const validMarkers: Marker[] = [];
  let lastEnd = -1;
  for (const marker of markers) {
    if (marker.fullStart >= lastEnd) {
      validMarkers.push(marker);
      lastEnd = marker.fullEnd;
    }
  }

  let cleanText = '';
  const decorations: TextDecoration[] = [];
  let i = 0;
  let markerIndex = 0;

  while (i < input.length) {
    if (markerIndex < validMarkers.length && i === validMarkers[markerIndex].fullStart) {
      const marker = validMarkers[markerIndex];
      const content = input.slice(marker.contentStart, marker.contentEnd);
      const decorationStart = cleanText.length;
      cleanText += content;
      const decorationEnd = cleanText.length;

      const decoration: TextDecoration = { range: [decorationStart, decorationEnd] };
      if (marker.isStyle) {
        decoration.style = marker.decoration as TextDecoration['style'];
      } else {
        decoration.animation = marker.decoration as TextDecoration['animation'];
      }
      decorations.push(decoration);

      i = marker.fullEnd;
      markerIndex++;
    } else {
      cleanText += input[i];
      i++;
    }
  }

  return { text: cleanText, decorations };
}

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

  let stripped = text;
  for (const name of ALL_DECORATIONS) {
    stripped = stripped.replace(new RegExp(`\\{${name}:([^}]+)\\}`, 'g'), '$1');
  }
  return { text: cleanResponse(stripped), decorations: [] };
}
