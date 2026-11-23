import type { ServerProviderPromptKeyword } from "@t3tools/contracts";

/**
 * Provider-declared prompt keywords (omp's magic keywords): standalone prose
 * words that glow with a per-word gradient in the composer and sent bubbles.
 * Matching ports omp's rules so T3 highlights exactly what the provider acts on.
 */

export interface PromptKeywordMatch {
  readonly start: number;
  readonly end: number;
  readonly keyword: ServerProviderPromptKeyword;
}

/** Characters that bind a keyword into an identifier, path segment, or symbol reference. */
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;

/** Characters that keep a keyword embedded in code: identifiers, paths, file extensions, calls. */
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

/** Global matchers by word; `matchAll` clones them, so sharing is stateless. */
const keywordPatterns = new Map<string, RegExp>();

function keywordPattern(word: string): RegExp {
  let pattern = keywordPatterns.get(word);
  if (!pattern) {
    const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    pattern = new RegExp(`${LEFT_BOUNDARY}${escaped}${RIGHT_BOUNDARY}`, "gu");
    keywordPatterns.set(word, pattern);
  }
  return pattern;
}

/** Fence opener/closer: up to three spaces of indent, then three or more backticks or tildes. */
const FENCE_RE = /^( {0,3})([`~]{3,})/;

/** HTML/XML element name; sticky so it probes a precise offset without slicing. */
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;

/** Index just past the run of backticks beginning at `i`. */
function backtickRunEnd(text: string, i: number): number {
  let j = i;
  while (j < text.length && text[j] === "`") j++;
  return j;
}

/** Index just past the unmasked backtick run of exactly `runLen` closing a code span, or -1. */
function findBacktickClose(text: string, from: number, runLen: number, masked: Uint8Array): number {
  let k = from;
  while (k < text.length) {
    if (masked[k]) {
      k++;
      continue;
    }
    if (text[k] === "`") {
      const end = backtickRunEnd(text, k);
      if (end - k === runLen) return end;
      k = end;
      continue;
    }
    k++;
  }
  return -1;
}

/** Index of the `>` closing a tag whose attributes start at `j`, honoring quotes; -1 when malformed. */
function findTagEnd(text: string, j: number): number {
  let quote = "";
  for (let k = j; k < text.length; k++) {
    const ch = text[k];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return k;
    if (ch === "<") return -1;
  }
  return -1;
}

/** Index just past the `</name>` balancing an opening tag, counting nested same-name tags; -1 when unclosed. */
function findMatchingClose(text: string, start: number, name: string, masked: Uint8Array): number {
  const lname = name.toLowerCase();
  let depth = 1;
  let k = start;
  while (k < text.length) {
    if (masked[k] || text[k] !== "<") {
      k++;
      continue;
    }
    let m = k + 1;
    let isClose = false;
    if (text[m] === "/") {
      isClose = true;
      m++;
    }
    TAG_NAME.lastIndex = m;
    const nm = TAG_NAME.exec(text);
    if (!nm) {
      k++;
      continue;
    }
    const gt = findTagEnd(text, TAG_NAME.lastIndex);
    if (gt < 0) {
      k++;
      continue;
    }
    if (nm[0].toLowerCase() === lname) {
      if (isClose) {
        depth--;
        if (depth === 0) return gt + 1;
      } else if (text[gt - 1] !== "/") {
        depth++;
      }
    }
    k = gt + 1;
  }
  return -1;
}

/**
 * Masks the comment, closing/self-closing tag, or opening tag plus content
 * through its balancing close that starts at `<` index `i`. Returns the index
 * past the masked region, or `i` when the `<` is literal.
 */
function maskTagAt(text: string, i: number, masked: Uint8Array): number {
  if (text.startsWith("<!--", i)) {
    const end = text.indexOf("-->", i + 4);
    const stop = end < 0 ? text.length : end + 3;
    masked.fill(1, i, stop);
    return stop;
  }
  let j = i + 1;
  let closing = false;
  if (text[j] === "/") {
    closing = true;
    j++;
  }
  TAG_NAME.lastIndex = j;
  const nm = TAG_NAME.exec(text);
  if (!nm) return i;
  const gt = findTagEnd(text, TAG_NAME.lastIndex);
  if (gt < 0) return i;
  const tagEnd = gt + 1;
  masked.fill(1, i, tagEnd);
  if (closing || text[gt - 1] === "/") return tagEnd;
  const close = findMatchingClose(text, tagEnd, nm[0], masked);
  if (close < 0) return tagEnd;
  masked.fill(1, tagEnd, close);
  return close;
}

/**
 * Same-length copy of `text` with fenced code blocks, matched inline code
 * spans, HTML/XML tags with their enclosed content, and comments blanked to
 * spaces (newlines kept), so match indices address the original text.
 * Unmatched backtick runs and stray `<` stay literal prose.
 */
function maskNonProse(text: string): string {
  if (!text.includes("`") && !text.includes("<") && !text.includes("~~~")) return text;
  const n = text.length;
  const masked = new Uint8Array(n);

  // Fenced code blocks, line by line.
  let fenceChar = "";
  let fenceLen = 0;
  let lineStart = 0;
  while (lineStart <= n) {
    let nl = text.indexOf("\n", lineStart);
    if (nl < 0) nl = n;
    const line = text.slice(lineStart, nl);
    const open = FENCE_RE.exec(line);
    if (fenceChar) {
      masked.fill(1, lineStart, nl);
      // A closing fence repeats the opening char at least as long, with nothing after it.
      if (
        open &&
        open[2]![0] === fenceChar &&
        open[2]!.length >= fenceLen &&
        line.slice(open[1]!.length + open[2]!.length).trim() === ""
      ) {
        fenceChar = "";
        fenceLen = 0;
      }
    } else if (open) {
      const marker = open[2]!;
      const ch = marker[0]!;
      // A backtick fence's info string may not contain a backtick.
      if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
        fenceChar = ch;
        fenceLen = marker.length;
        masked.fill(1, lineStart, nl);
      }
    }
    if (nl === n) break;
    lineStart = nl + 1;
  }

  // Inline code spans and HTML/XML over regions fences left unmasked.
  let i = 0;
  while (i < n) {
    if (masked[i]) {
      i++;
      continue;
    }
    const c = text[i];
    if (c === "`") {
      const runEnd = backtickRunEnd(text, i);
      const close = findBacktickClose(text, runEnd, runEnd - i, masked);
      if (close >= 0) {
        masked.fill(1, i, close);
        i = close;
      } else {
        i = runEnd;
      }
      continue;
    }
    if (c === "<") {
      const end = maskTagAt(text, i, masked);
      i = end > i ? end : i + 1;
      continue;
    }
    i++;
  }

  let out = "";
  for (let p = 0; p < n; p++) {
    const ch = text[p]!;
    out += masked[p] && ch !== "\n" ? " " : ch;
  }
  return out;
}

/** UTF-16 [start, end) ranges of standalone keywords in prompt source text, outside code fences, inline code spans, HTML/XML tags and comments; omp's case-sensitive matching rules. */
export function findPromptKeywords(
  text: string,
  keywords: ReadonlyArray<ServerProviderPromptKeyword>,
): PromptKeywordMatch[] {
  const matches: PromptKeywordMatch[] = [];
  let masked: string | undefined;
  for (const keyword of keywords) {
    if (!text.includes(keyword.word)) continue;
    masked ??= maskNonProse(text);
    for (const match of masked.matchAll(keywordPattern(keyword.word))) {
      matches.push({ start: match.index, end: match.index + match[0].length, keyword });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Color stops in one gradient sweep, matching omp's editor palette. */
const GRADIENT_STOPS = 14;

/** CSS `linear-gradient(90deg, ...)` of omp's hue/lightness sweep (14 stops, saturation 90%), drawn twice in a row so `background-size: 200% 100%` shows one sweep and can scroll seamlessly. Stops sit at explicit k/28 positions and close on the first color at 100%, so the image repeats exactly every 50% and wraps last-to-first like omp's palette. */
export function promptKeywordGradient(keyword: ServerProviderPromptKeyword): string {
  const { hue, lightness = { from: 62, to: 62 } } = keyword;
  const colors: string[] = [];
  for (let k = 0; k < GRADIENT_STOPS; k++) {
    const t = k / GRADIENT_STOPS;
    const h = ((Math.round(hue.from + (hue.to - hue.from) * t) % 360) + 360) % 360;
    const l = Math.round(lightness.from + (lightness.to - lightness.from) * t);
    colors.push(`hsl(${h} 90% ${l}%)`);
  }
  const stops: string[] = [];
  for (let k = 0; k < GRADIENT_STOPS * 2; k++) {
    stops.push(`${colors[k % GRADIENT_STOPS]} ${(k * 100) / (GRADIENT_STOPS * 2)}%`);
  }
  stops.push(`${colors[0]} 100%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
