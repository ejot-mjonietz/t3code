/**
 * omp's `ask` tool sends one agent-written HTML `<form>`. This ports omp's form model (pi-tui
 * `html-form`) to T3 questions: radios and checkboxes join one field per type and name wherever
 * they sit, and the text around a field becomes its question. The HTML is parsed, never rendered.
 */
import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { type DefaultTreeAdapterTypes, parse } from "parse5";

export interface OmpHtmlForm {
  /** One T3 question per answerable form field, in document order; form context (paragraphs, lists, tables, pre, headings, legends) is folded into question text as Markdown. */
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  /** omp's `data` reply keyed by control `name`: string, number, or string[]. Fields left unanswered take the form's defaults. */
  readonly toData: (
    answers: ProviderUserInputAnswers,
  ) => Record<string, string | number | ReadonlyArray<string>>;
}

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type QuestionOption = OrchestrationV2UserInputQuestion["options"][number];
type FormValue = string | number | ReadonlyArray<string>;

type SpanStyle = "code" | "strong" | "em";

/** Inline text; `"\n"` is a hard line break (`<br>`). */
interface Span {
  text: string;
  readonly style?: SpanStyle;
}

interface ChoiceOption {
  readonly value: string;
  readonly label: ReadonlyArray<Span>;
  checked: boolean;
  readonly disabled: boolean;
}

/** A radio group, checkbox group or `<select>`. */
interface ChoiceField {
  readonly kind: "choice";
  readonly name: string;
  readonly multi: boolean;
  readonly select: boolean;
  /** omp adds a free-text "Other" answer to radio and checkbox groups of two or more options. */
  other: boolean;
  /** The control's own label; empty for radio and checkbox groups, which take their options' labels. */
  readonly label: ReadonlyArray<Span>;
  readonly options: ChoiceOption[];
  required: boolean;
}

interface TextField {
  readonly kind: "text";
  readonly name: string;
  /** The `<input>` type, or `textarea`. */
  readonly type: string;
  readonly label: ReadonlyArray<Span>;
  readonly value: string;
  readonly required: boolean;
}

type Field = ChoiceField | TextField;

interface TextBlock {
  readonly kind: "text";
  readonly spans: ReadonlyArray<Span>;
  readonly heading: boolean;
}

interface FieldBlock {
  readonly kind: "field";
  readonly field: Field;
  /** Set when a radio or checkbox group's later options follow other blocks: the index past them. */
  optionsEnd?: number;
}

type Block =
  | TextBlock
  | { readonly kind: "list"; readonly items: ReadonlyArray<Span[]>; readonly ordered: boolean }
  | { readonly kind: "pre"; readonly text: string }
  | { readonly kind: "table"; readonly rows: ReadonlyArray<ReadonlyArray<Span[]>> }
  | FieldBlock;

/** A top-level `<fieldset>`, titled by its `<legend>`, or the loose content between fieldsets. */
interface Section {
  title: ReadonlyArray<Span>;
  readonly blocks: Block[];
}

interface ParsedForm {
  readonly sections: ReadonlyArray<Section>;
  readonly fields: ReadonlyArray<Field>;
  readonly hidden: ReadonlyArray<readonly [string, string]>;
}

/** A question's header, and the text before and after its prompt. */
interface FieldText {
  readonly header: string;
  readonly prompt: Part;
  readonly before: ReadonlyArray<Part>;
  readonly after: ReadonlyArray<Part>;
}

/** Question text: one-line plain text for comparisons, and its Markdown. */
interface Part {
  readonly text: string;
  readonly markdown: string;
  /** Set on a legend, which its own section's questions show as their header instead. */
  readonly titleOf?: Section;
}

// Sets and Maps, not object literals: tag names come from the form, and `constructor` must miss.
const SKIPPED = new Set([
  "button",
  "head",
  "iframe",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figure",
  "figcaption",
  "footer",
  "header",
  "li",
  "main",
  "nav",
  "p",
  "section",
]);

const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "summary"]);

const STYLE_OF = new Map<string, SpanStyle>([
  ["b", "strong"],
  ["code", "code"],
  ["em", "em"],
  ["i", "em"],
  ["kbd", "code"],
  ["samp", "code"],
  ["strong", "strong"],
  ["tt", "code"],
]);

const IGNORED_INPUTS = new Set(["button", "file", "image", "reset", "submit"]);

/** Parses the HTML form omp's `ask` tool sends; undefined when it holds no answerable field. */
export function parseOmpHtmlForm(html: string): OmpHtmlForm | undefined {
  const document = parse(html);
  // Like omp, content outside the first `<form>` is ignored when there is one.
  const form = buildForm(
    findElement(document, (element) => element.tagName === "form") ?? document,
  );

  const ids = new Map<Field, string>();
  const usedIds = new Set<string>();
  for (const field of form.fields) {
    // Ids must survive the contract's trim; a repeated name keeps its first field.
    const id = field.name.trim();
    if (id === "" || usedIds.has(id)) continue;
    if (
      field.kind === "choice" &&
      !field.other &&
      field.options.every((option) => option.disabled)
    ) {
      continue;
    }
    usedIds.add(id);
    ids.set(field, id);
  }
  if (ids.size === 0) return undefined;

  // omp's `fieldQuestions` and `fieldContexts` in one pass: the prompt is the field's label, else the
  // text right before it, else its legend; context is the text since the previous field, plus the text
  // between its own options and, for the last field, the text after it.
  const texts = new Map<Field, FieldText>();
  let pending: Part[] = [];
  let last: Part[] | undefined;
  for (const section of form.sections) {
    const title = oneLine(spansText(section.title));
    if (title !== "") {
      pending.push({
        ...blockPart({ kind: "text", spans: section.title, heading: true }),
        titleOf: section,
      });
    }
    let caption: TextBlock | undefined;
    let owner: Part[] | undefined;
    let ownerEnd = 0;
    for (const [index, block] of section.blocks.entries()) {
      if (block.kind !== "field") {
        caption = block.kind === "text" ? block : undefined;
        const part = blockPart(block);
        if (part.text === "") continue;
        if (owner !== undefined && index < ownerEnd) owner.push(part);
        else pending.push(part);
        continue;
      }
      const field = block.field;
      const captionSpans = caption?.spans ?? [];
      caption = undefined;
      const id = ids.get(field);
      if (id === undefined) continue;
      const prompt = promptPart(field, captionSpans, section.title, id);
      const after: Part[] = [];
      texts.set(field, {
        header: title || oneLine(spansText(field.label)) || id,
        prompt,
        before: pending.filter((part) => part.text !== prompt.text && part.titleOf !== section),
        after,
      });
      pending = [];
      last = after;
      owner = after;
      const end = block.optionsEnd ?? 0;
      // Text between the options stays with the group unless another question sits among them.
      const intervening = section.blocks.some(
        (later, at) => at > index && at < end && later.kind === "field" && ids.has(later.field),
      );
      ownerEnd = intervening ? 0 : end;
    }
  }
  last?.push(...pending);

  const asked = form.fields.flatMap((field) => {
    const id = ids.get(field);
    const text = texts.get(field);
    if (id === undefined || text === undefined) return [];
    return [
      { id, field, ...text, options: field.kind === "choice" ? answerableOptions(field) : [] },
    ];
  });

  return {
    questions: asked.map(
      ({ id, field, header, prompt, before, after, options }): OrchestrationV2UserInputQuestion => {
        const question = [...before, prompt, ...after]
          .map((part) => part.markdown)
          .join("\n\n")
          .trim();
        if (field.kind === "text") {
          return {
            id,
            header,
            question,
            options: [],
            allowCustomAnswer: true,
            // omp edits textareas and prefilled inputs in an editor: the answer is literal text.
            ...(field.type === "textarea" || field.value !== ""
              ? { initialAnswer: field.value }
              : {}),
            required: field.required,
          };
        }
        return {
          id,
          header,
          question,
          options: questionOptions(field, options),
          ...(field.multi ? { multiSelect: true } : {}),
          allowCustomAnswer: field.other,
          required: field.required,
        };
      },
    ),
    toData: (answers) =>
      Object.fromEntries([
        ...form.hidden,
        ...asked.flatMap(({ id, field, options }) => {
          const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
          const value =
            field.kind === "text" ? textData(field, answer) : choiceData(field, options, answer);
          return value === undefined ? [] : [[field.name, value] as const];
        }),
      ]),
  };
}

/** An option T3 offers: enabled, one per value (they submit the same data), with its shown label. */
interface AnswerableOption {
  readonly value: string;
  readonly label: string;
  readonly checked: boolean;
}

function answerableOptions(field: ChoiceField): ReadonlyArray<AnswerableOption> {
  const values = new Set<string>();
  const options: AnswerableOption[] = [];
  for (const option of field.options) {
    if (option.disabled || values.has(option.value)) continue;
    values.add(option.value);
    options.push({
      value: option.value,
      label: oneLine(spansText(option.label)) || option.value.trim() || "Empty value",
      checked: option.checked,
    });
  }
  return options;
}

function questionOptions(
  field: ChoiceField,
  options: ReadonlyArray<AnswerableOption>,
): QuestionOption[] {
  const checked = options.filter((option) => option.checked);
  // A single choice submits its first checked option, so only that one starts selected.
  const selected = new Set(field.multi ? checked : checked.slice(0, 1));
  return options.map((option) => ({
    label: option.label,
    description: option.label,
    value: option.value,
    ...(selected.has(option) ? { selected: true } : {}),
  }));
}

/** Option values match exactly, labels after trimming; other text is the "Other" answer. */
function choiceData(
  field: ChoiceField,
  options: ReadonlyArray<AnswerableOption>,
  answer: unknown,
): FormValue | undefined {
  const checked = new Set<AnswerableOption>();
  const custom: string[] = [];
  for (const entry of Array.isArray(answer) ? answer : [answer]) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    const option =
      options.find((candidate) => candidate.value === entry) ??
      options.find((candidate) => candidate.label === text);
    if (option !== undefined) checked.add(option);
    else if (text !== "") custom.push(text);
  }
  const typed = field.other ? custom.join("\n") : "";
  return checked.size === 0 && typed === ""
    ? choiceValue(field, options, (option) => option.checked, "")
    : choiceValue(field, options, (option) => checked.has(option), typed);
}

/** omp's `choiceValue`: typed "Other" text replaces a single choice's value or joins a group's array. */
function choiceValue(
  field: ChoiceField,
  options: ReadonlyArray<AnswerableOption>,
  isChecked: (option: AnswerableOption) => boolean,
  typed: string,
): FormValue | undefined {
  const values = options.flatMap((option) => (isChecked(option) ? [option.value] : []));
  // Lone checkboxes and single-option multi-selects submit one value, as in omp.
  if (field.multi && field.options.length > 1) return typed === "" ? values : [...values, typed];
  return typed || values[0];
}

function textData(field: TextField, answer: unknown): FormValue | undefined {
  const entries = (Array.isArray(answer) ? answer : [answer]).filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (entries.length > 0) return textValue(field, entries.join("\n"));
  return field.value === "" ? undefined : textValue(field, field.value);
}

function textValue(field: TextField, text: string): FormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

function promptPart(
  field: Field,
  caption: ReadonlyArray<Span>,
  title: ReadonlyArray<Span>,
  id: string,
): Part {
  // A lone checkbox ("I agree") asks its own label.
  const lone =
    field.kind === "choice" && field.options.length === 1 ? (field.options[0]?.label ?? []) : [];
  for (const spans of [field.label, caption, title, lone]) {
    const text = oneLine(spansText(spans));
    if (text !== "") return { text, markdown: inlineMarkdown(spans) };
  }
  return { text: id, markdown: inlineMarkdown([{ text: id }]) };
}

function blockPart(block: Exclude<Block, FieldBlock>): Part {
  switch (block.kind) {
    case "text":
      return {
        text: oneLine(spansText(block.spans)),
        markdown: block.heading
          ? wrapMarker(
              inlineMarkdown(
                block.spans.map((span) => (span.style === "strong" ? { text: span.text } : span)),
              ),
              "**",
            )
          : inlineMarkdown(block.spans),
      };
    case "list": {
      const marker = (index: number) => (block.ordered ? `${index + 1}.` : "-");
      return {
        text: oneLine(
          block.items.map((item, index) => `${marker(index)} ${spansText(item)}`).join("\n"),
        ),
        markdown: block.items
          .map((item, index) => {
            const indent = `\n${" ".repeat(marker(index).length + 1)}`;
            return `${marker(index)} ${inlineMarkdown(item).replaceAll("\n", indent)}`;
          })
          .join("\n"),
      };
    }
    case "pre": {
      const fence = "`".repeat(Math.max(3, longestBacktickRun(block.text) + 1));
      return { text: oneLine(block.text), markdown: `${fence}\n${block.text}\n${fence}` };
    }
    case "table":
      return {
        text: oneLine(block.rows.map((row) => row.map(spansText).join(" | ")).join("\n")),
        markdown: tableMarkdown(block.rows),
      };
  }
}

/** GFM needs a header row, so the first row is one. */
function tableMarkdown(rows: ReadonlyArray<ReadonlyArray<Span[]>>): string {
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: ReadonlyArray<Span[]>) => {
    const cells = Array.from({ length: width }, (_, column) =>
      inlineMarkdown(row[column] ?? [], true),
    );
    return `| ${cells.join(" | ")} |`;
  };
  const [head = [], ...body] = rows;
  return [line(head), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

// Form text is plain text: escape what Markdown, raw HTML, entities or math would read.
const MARKDOWN_SYNTAX = /[\\`*[\]<~$]|&(?=#?\w+;)|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;

/** Escapes line starts that would open a heading, list, quote or setext underline. */
function escapeLineStarts(markdown: string): string {
  return markdown
    .replace(/^(#{1,6}|[+-])(?=[ \t]|$)/gm, "\\$1")
    .replace(/^([-=])(?=[-= \t]*$)/gm, "\\$1")
    .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/gm, "$1\\$2")
    .replace(/^>/gm, "\\>");
}

function inlineMarkdown(spans: ReadonlyArray<Span>, inTable = false): string {
  let markdown = "";
  for (const span of spans) {
    const text = inTable ? span.text.replaceAll("\n", " ") : span.text;
    if (span.style === "code") markdown += codeSpan(text.replaceAll("\n", " "));
    else if (span.style === undefined) markdown += text.replace(MARKDOWN_SYNTAX, "\\$&");
    else {
      const marker = span.style === "strong" ? "**" : "*";
      markdown += wrapMarker(text.replace(MARKDOWN_SYNTAX, "\\$&"), marker);
    }
  }
  // GFM splits table rows at every unescaped pipe, code spans included.
  return inTable ? markdown.replaceAll("|", "\\|") : escapeLineStarts(markdown);
}

/** Emphasis cannot open or close next to whitespace, so edge whitespace moves outside the markers. */
function wrapMarker(content: string, marker: string): string {
  const [, lead = "", core = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(content) ?? [];
  return core === "" ? content : `${lead}${marker}${core}${marker}${trail}`;
}

function codeSpan(code: string): string {
  const longest = longestBacktickRun(code);
  const fence = "`".repeat(longest + 1);
  // CommonMark strips one space from each edge of a code span that has both and is not all spaces.
  const spaceEdges = code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code);
  const pad = spaceEdges || code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return longest;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function spansText(spans: ReadonlyArray<Span>): string {
  return spans.map((span) => span.text).join("");
}

/** Appends `text`, merging it into the previous span when the style matches. */
function appendSpan(spans: Span[], text: string, style: SpanStyle | undefined): void {
  if (text === "") return;
  const last = spans.at(-1);
  if (last !== undefined && last.style === style) last.text += text;
  else spans.push(style === undefined ? { text } : { text, style });
}

/** Collapses whitespace as HTML layout does; spaces next to a hard break and at the ends vanish. */
function normalizeSpans(spans: ReadonlyArray<Span>): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    appendSpan(out, span.text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n"), span.style);
  }
  const first = out[0];
  if (first !== undefined) first.text = first.text.replace(/^\s+/, "");
  const last = out.at(-1);
  if (last !== undefined) last.text = last.text.replace(/\s+$/, "");
  return out.filter((span) => span.text !== "");
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isText(node: Node): node is TextNode {
  return node.nodeName === "#text";
}

function isControl(element: Element): boolean {
  return (
    element.tagName === "input" || element.tagName === "select" || element.tagName === "textarea"
  );
}

function childNodes(node: Node): ReadonlyArray<Node> {
  return "childNodes" in node ? node.childNodes : [];
}

function elementChildren(element: Element): Element[] {
  return element.childNodes.filter(isElement);
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

function hasAttribute(element: Element, name: string): boolean {
  return element.attrs.some((attr) => attr.name === name);
}

function textContent(node: Node): string {
  if (isText(node)) return node.value;
  let text = "";
  for (const child of childNodes(node)) text += textContent(child);
  return text;
}

/** Descendant elements of `node` (not `node` itself) in document order. */
function descendants(node: Node, match: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  for (const child of childNodes(node)) {
    if (!isElement(child)) continue;
    if (match(child)) found.push(child);
    found.push(...descendants(child, match));
  }
  return found;
}

function findElement(node: Node, match: (element: Element) => boolean): Element | undefined {
  for (const child of childNodes(node)) {
    if (!isElement(child)) continue;
    if (match(child)) return child;
    const found = findElement(child, match);
    if (found !== undefined) return found;
  }
  return undefined;
}

function closest(element: Element, tag: string): Element | undefined {
  let node: Node | null = element;
  while (node !== null && isElement(node)) {
    if (node.tagName === tag) return node;
    node = node.parentNode;
  }
  return undefined;
}

function contains(ancestor: Element, element: Element): boolean {
  let node: Node | null = element;
  while (node !== null && isElement(node)) {
    if (node === ancestor) return true;
    node = node.parentNode;
  }
  return false;
}

/** omp's `FormBuilder`: walks the form into sections of text blocks and fields. */
function buildForm(root: Node): ParsedForm {
  const sections: Section[] = [];
  const fields: Field[] = [];
  const hidden: Array<readonly [string, string]> = [];
  // Radio and checkbox groups by type and name, with the section and block of their first option.
  const groups = new Map<
    string,
    { readonly field: ChoiceField; readonly section: Section; readonly block: FieldBlock }
  >();
  // `<label for>` elements by the id of the control they name.
  const labelFor = new Map<string, Element>();
  let section: Section = { title: [], blocks: [] };
  sections.push(section);
  let inline: Span[] = [];
  let fieldsetDepth = 0;

  const controlIds = new Set<string>();
  for (const control of descendants(root, isControl)) {
    const id = attribute(control, "id");
    if (id) controlIds.add(id);
  }
  for (const label of descendants(root, (element) => element.tagName === "label")) {
    const target = attribute(label, "for");
    if (target && controlIds.has(target) && !labelFor.has(target)) labelFor.set(target, label);
  }

  const flush = (heading: boolean): void => {
    const spans = normalizeSpans(inline);
    inline = [];
    if (spans.length > 0) section.blocks.push({ kind: "text", spans, heading });
  };

  const children = (node: Node, style: SpanStyle | undefined): void => {
    for (const child of childNodes(node)) walk(child, style);
  };

  const startSection = (title: ReadonlyArray<Span>): void => {
    if (section.blocks.length === 0 && section.title.length === 0) {
      section.title = title;
      return;
    }
    section = { title, blocks: [] };
    sections.push(section);
  };

  const addField = (field: Field): FieldBlock => {
    const block: FieldBlock = { kind: "field", field };
    fields.push(field);
    section.blocks.push(block);
    return block;
  };

  /** Inline spans of `element`, skipping controls: their label is the text around them. */
  const spansOf = (element: Element): Span[] => {
    const spans: Span[] = [];
    const visit = (node: Node, style: SpanStyle | undefined): void => {
      if (isText(node)) {
        appendSpan(spans, node.value, style);
        return;
      }
      if (!isElement(node)) return;
      const tag = node.tagName;
      if (SKIPPED.has(tag) || isControl(node) || tag === "svg") return;
      if (tag === "br") {
        appendSpan(spans, "\n", undefined);
        return;
      }
      if (tag === "img") {
        appendSpan(spans, attribute(node, "alt") ?? "", style);
        return;
      }
      if (BLOCK.has(tag) || HEADING.has(tag)) appendSpan(spans, " ", undefined);
      for (const child of node.childNodes) visit(child, STYLE_OF.get(tag) ?? style);
    };
    for (const child of element.childNodes) visit(child, undefined);
    return normalizeSpans(spans);
  };

  /** Label of a control outside any wrapping `<label>`: `<label for>`, then `aria-label`, `title`. */
  const detachedLabel = (control: Element): Span[] => {
    const id = attribute(control, "id");
    const label = id ? labelFor.get(id) : undefined;
    if (label !== undefined) return spansOf(label);
    const text = attribute(control, "aria-label") ?? attribute(control, "title");
    return text ? normalizeSpans([{ text }]) : [];
  };

  const addControl = (control: Element, wrapping: ReadonlyArray<Span> | undefined): void => {
    flush(false);
    const label = wrapping !== undefined && wrapping.length > 0 ? wrapping : detachedLabel(control);
    const name = attribute(control, "name") ?? "";
    const required = hasAttribute(control, "required");
    // omp's last-resort text field label: `sentry_dsn` reads `sentry dsn`.
    const textLabel =
      label.length > 0 || name === "" ? label : [{ text: name.replace(/[_-]+/g, " ") }];
    if (control.tagName === "select") {
      const multi = hasAttribute(control, "multiple");
      const options = descendants(control, (element) => element.tagName === "option").map(
        (option): ChoiceOption => {
          const text = oneLine(textContent(option));
          return {
            value: attribute(option, "value") ?? text,
            label: [{ text }],
            checked: hasAttribute(option, "selected"),
            disabled: hasAttribute(option, "disabled"),
          };
        },
      );
      // A single select always has a selection: the first enabled option unless one is marked.
      if (!multi && !options.some((option) => option.checked)) {
        const first = options.find((option) => !option.disabled);
        if (first !== undefined) first.checked = true;
      }
      addField({
        kind: "choice",
        name,
        multi,
        select: true,
        other: false,
        label,
        options,
        required,
      });
      return;
    }
    if (control.tagName === "textarea") {
      addField({
        kind: "text",
        name,
        type: "textarea",
        label: textLabel,
        value: textContent(control),
        required,
      });
      return;
    }
    const type = (attribute(control, "type") ?? "text").toLowerCase();
    if (IGNORED_INPUTS.has(type)) return;
    const value = attribute(control, "value");
    if (type === "hidden") {
      if (name !== "") hidden.push([name, value ?? ""]);
      return;
    }
    if (type === "radio" || type === "checkbox") {
      const option: ChoiceOption = {
        value: value ?? "on",
        label: label.length > 0 ? label : [{ text: value ?? name }],
        checked: hasAttribute(control, "checked"),
        disabled: hasAttribute(control, "disabled"),
      };
      const key = `${type}\0${name}`;
      const group = groups.get(key);
      if (group !== undefined) {
        group.field.options.push(option);
        group.field.required ||= required;
        if (group.section === section && section.blocks.at(-1) !== group.block) {
          group.block.optionsEnd = section.blocks.length;
        }
        return;
      }
      const field: ChoiceField = {
        kind: "choice",
        name,
        multi: type === "checkbox",
        select: false,
        other: false,
        label: [],
        options: [option],
        required,
      };
      groups.set(key, { field, section, block: addField(field) });
      return;
    }
    addField({
      kind: "text",
      name,
      type,
      label: textLabel,
      value: value ?? "",
      required,
    });
  };

  const walkLabel = (label: Element, style: SpanStyle | undefined): void => {
    const controls = descendants(label, isControl);
    if (controls.length > 0) {
      flush(false);
      const spans = spansOf(label);
      for (const control of controls) addControl(control, spans);
      return;
    }
    // A `<label for>` is its control's label, not text of its own.
    const target = attribute(label, "for");
    if (!target || labelFor.get(target) !== label) children(label, style);
  };

  const walkFieldset = (fieldset: Element): void => {
    flush(false);
    const legend = elementChildren(fieldset).find((child) => child.tagName === "legend");
    // Nested fieldsets stay in the outer section; their legend becomes a heading.
    if (fieldsetDepth > 0) {
      if (legend !== undefined) walk(legend, undefined);
    } else {
      startSection(legend === undefined ? [] : spansOf(legend));
    }
    fieldsetDepth++;
    for (const child of fieldset.childNodes) {
      if (child !== legend) walk(child, undefined);
    }
    flush(false);
    fieldsetDepth--;
    if (fieldsetDepth === 0) startSection([]);
  };

  const walkList = (list: Element, ordered: boolean): void => {
    flush(false);
    // A list of controls is layout, not content.
    if (findElement(list, isControl) !== undefined) {
      children(list, undefined);
      flush(false);
      return;
    }
    const items = elementChildren(list)
      .filter((child) => child.tagName === "li")
      .map(spansOf)
      .filter((spans) => spans.length > 0);
    if (items.length > 0) section.blocks.push({ kind: "list", items, ordered });
  };

  const walkTable = (table: Element): void => {
    flush(false);
    const rows = descendants(table, (element) => element.tagName === "tr").filter(
      (row) => closest(row, "table") === table,
    );
    const cellsOf = (row: Element) =>
      elementChildren(row).filter((cell) => cell.tagName === "td" || cell.tagName === "th");
    if (findElement(table, isControl) === undefined) {
      const cells = rows.map((row) => cellsOf(row).map(spansOf)).filter((row) => row.length > 0);
      if (cells.length > 0) section.blocks.push({ kind: "table", rows: cells });
      return;
    }
    // A table of controls: each row's text becomes a line, and an unlabeled control
    // borrows its column header as its label.
    let header: Span[][] = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      if (
        cells.every((cell) => cell.tagName === "th") &&
        findElement(row, isControl) === undefined
      ) {
        header = cells.map(spansOf);
        continue;
      }
      const text: Span[] = [];
      for (const cell of cells) {
        if (findElement(cell, isControl) !== undefined) continue;
        const spans = spansOf(cell);
        if (spans.length === 0) continue;
        if (text.length > 0) appendSpan(text, " · ", undefined);
        for (const span of spans) appendSpan(text, span.text, span.style);
      }
      if (text.length > 0) section.blocks.push({ kind: "text", spans: text, heading: false });
      for (const [column, cell] of cells.entries()) {
        for (const control of descendants(cell, isControl)) {
          const own = closest(control, "label");
          const spans = own !== undefined && contains(cell, own) ? spansOf(own) : spansOf(cell);
          addControl(control, spans.length > 0 ? spans : (header[column] ?? []));
        }
      }
    }
  };

  const walk = (node: Node, style: SpanStyle | undefined): void => {
    if (isText(node)) {
      appendSpan(inline, node.value, style);
      return;
    }
    if (!isElement(node)) return;
    const tag = node.tagName;
    if (SKIPPED.has(tag)) return;
    switch (tag) {
      case "br":
        appendSpan(inline, "\n", undefined);
        return;
      case "hr":
        flush(false);
        return;
      case "input":
      case "select":
      case "textarea":
        addControl(node, undefined);
        return;
      case "label":
        walkLabel(node, style);
        return;
      case "fieldset":
        walkFieldset(node);
        return;
      case "legend":
        flush(false);
        children(node, style);
        flush(true);
        return;
      case "ul":
      case "ol":
        walkList(node, tag === "ol");
        return;
      case "pre":
        flush(false);
        section.blocks.push({ kind: "pre", text: textContent(node).trimEnd() });
        return;
      case "table":
        walkTable(node);
        return;
      // Pictures break the text flow; questions carry text only.
      case "img":
        if (attribute(node, "src")?.trim()) flush(false);
        return;
      case "svg":
        flush(false);
        return;
    }
    if (HEADING.has(tag)) {
      flush(false);
      children(node, style);
      flush(true);
      return;
    }
    if (BLOCK.has(tag)) {
      flush(false);
      children(node, style);
      flush(false);
      return;
    }
    children(node, STYLE_OF.get(tag) ?? style);
  };

  children(root, undefined);
  flush(false);
  for (const field of fields) {
    if (field.kind !== "choice" || field.select || field.options.length < 2) continue;
    field.other = !field.options.some((option) => /^\s*other\b/i.test(spansText(option.label)));
  }
  return { sections, fields, hidden };
}
