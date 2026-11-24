import type { Element, ElementContent, Root } from "hast";
import { decodeHTML } from "entities";
import type { ServerProviderPromptKeyword } from "@t3tools/contracts";
import {
  findPromptKeywords,
  promptKeywordGradient,
  type PromptKeywordMatch,
} from "@t3tools/shared/promptKeywords";

/** A CommonMark entity or numeric character reference. */
const CHARACTER_REFERENCE = /&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/g;

/**
 * Wraps the prompt keywords found in `source` in `prompt-keyword` spans where the rendered `tree`
 * shows them in prose (not code or links). Rendered text is placed back onto `source` in order, so
 * a word glows only where it lands exactly on a match; text the walk cannot place stays plain.
 */
export function paintPromptKeywords(
  tree: Root,
  source: string,
  keywords: ReadonlyArray<ServerProviderPromptKeyword>,
): void {
  const matches = findPromptKeywords(source, keywords);
  if (matches.length === 0) return;
  const matchAt = new Map<number, PromptKeywordMatch>();
  for (const match of matches) {
    if (!matchAt.has(match.start)) matchAt.set(match.start, match);
  }
  const styles = new Map<ServerProviderPromptKeyword, string>();
  const keywordSpan = (keyword: ServerProviderPromptKeyword): Element => {
    let style = styles.get(keyword);
    if (style === undefined) {
      style = `--prompt-keyword-gradient:${promptKeywordGradient(keyword)}`;
      styles.set(keyword, style);
    }
    return {
      type: "element",
      tagName: "span",
      properties: { className: ["prompt-keyword"], style },
      children: [{ type: "text", value: keyword.word }],
    };
  };
  // Prose decodes character references, so `&lt;` in the source shows as one `<`.
  const references: Array<{ start: number; end: number; value: string }> = [];
  for (const found of source.matchAll(CHARACTER_REFERENCE)) {
    const end = found.index + found[0].length;
    references.push({ start: found.index, end, value: decodeHTML(found[0]) });
  }
  let cursor = 0;
  /** `value` split around the keywords it shows, or null when it shows none. */
  const align = (value: string, paint: boolean, code: boolean): ElementContent[] | null => {
    let parts: ElementContent[] | null = null;
    let from = 0;
    for (let index = 0; index < value.length; index++) {
      // Whitespace places nothing, and Words writes line endings of its own between blocks.
      if (value.charCodeAt(index) <= 32) continue;
      const character = value[index]!;
      let at = source.indexOf(character, cursor);
      let next = at + 1;
      const reference = code
        ? undefined
        : references.find(
            (candidate) =>
              candidate.start >= cursor &&
              (at < 0 || candidate.start <= at) &&
              candidate.value === character,
          );
      if (reference) {
        at = reference.start;
        next = reference.end;
      }
      // A character the rest of the source lacks leaves the cursor where it was.
      if (at < 0) continue;
      const match = paint ? matchAt.get(at) : undefined;
      if (match === undefined || !value.startsWith(match.keyword.word, index)) {
        cursor = next;
        continue;
      }
      parts ??= [];
      if (index > from) parts.push({ type: "text", value: value.slice(from, index) });
      parts.push(keywordSpan(match.keyword));
      from = index + match.keyword.word.length;
      index = from - 1;
      cursor = match.end;
    }
    if (parts && from < value.length) parts.push({ type: "text", value: value.slice(from) });
    return parts;
  };
  const visit = (node: Root | Element, paint: boolean, code: boolean) => {
    const children = node.children as ElementContent[];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.type === "text") {
        const parts = align(child.value, paint, code);
        if (parts) {
          children.splice(index, 1, ...parts);
          index += parts.length - 1;
        }
        continue;
      }
      if (child.type !== "element") continue;
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start !== undefined) cursor = start;
      // Code blocks, math and footnotes are not prose in source order; only positions count.
      const opaque =
        child.tagName === "pre" ||
        child.tagName === "svg" ||
        child.properties.dataFootnotes !== undefined ||
        child.properties.dataFootnoteRef !== undefined;
      if (!opaque) {
        const inCode = code || child.tagName === "code";
        visit(child, paint && !inCode && child.tagName !== "a", inCode);
      }
      if (end !== undefined) cursor = end;
    }
  };
  visit(tree, true, false);
}
