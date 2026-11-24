import { assert, describe, it } from "@effect/vitest";

import { parseOmpHtmlForm } from "./htmlForm.ts";

describe("parseOmpHtmlForm", () => {
  it("asks radio groups with their checked default, Other answers and required flag", () => {
    const form = parseOmpHtmlForm(`<form>
      <fieldset>
        <legend>Database</legend>
        <p>Pick the primary store.</p>
        <label><input type="radio" name="db" value="sqlite" checked required> SQLite</label>
        <label><input type="radio" name="db" value="pg"> Postgres</label>
      </fieldset>
      <fieldset>
        <legend>Cache</legend>
        <label><input type="radio" name="cache" value="none"> None</label>
        <label><input type="radio" name="cache" value="custom"> Other (describe it in notes)</label>
      </fieldset>
    </form>`);
    assert(form !== undefined);
    assert.deepStrictEqual(form.questions, [
      {
        id: "db",
        header: "Database",
        question: "Pick the primary store.",
        options: [
          { label: "SQLite", description: "SQLite", value: "sqlite", selected: true },
          { label: "Postgres", description: "Postgres", value: "pg" },
        ],
        allowCustomAnswer: true,
        required: true,
      },
      {
        id: "cache",
        header: "Cache",
        question: "Cache",
        options: [
          { label: "None", description: "None", value: "none" },
          {
            label: "Other (describe it in notes)",
            description: "Other (describe it in notes)",
            value: "custom",
          },
        ],
        allowCustomAnswer: false,
        required: false,
      },
    ]);
    assert.deepStrictEqual(form.toData({ db: "pg", cache: "none" }), { db: "pg", cache: "none" });
    assert.deepStrictEqual(form.toData({ db: "Postgres" }), { db: "pg" });
    // Typed text answers a group with an automatic Other; a group without one keeps its default.
    assert.deepStrictEqual(form.toData({ db: " MySQL ", cache: "Redis" }), { db: "MySQL" });
    assert.deepStrictEqual(form.toData({}), { db: "sqlite" });
  });

  it("joins a checkbox group split across table cells", () => {
    const form = parseOmpHtmlForm(`<form>
      <p>Which targets?</p>
      <table>
        <tr>
          <td><label><input type="checkbox" name="targets" value="mac" checked> macOS</label></td>
          <td><label><input type="checkbox" name="targets" value="linux"> Linux</label></td>
        </tr>
        <tr>
          <td><label><input type="checkbox" name="targets" value="win" disabled> Windows</label></td>
          <td><label><input type="checkbox" name="targets" value="web"> Web</label></td>
        </tr>
      </table>
    </form>`);
    assert(form !== undefined);
    assert.deepStrictEqual(form.questions, [
      {
        id: "targets",
        header: "targets",
        question: "Which targets?",
        options: [
          { label: "macOS", description: "macOS", value: "mac", selected: true },
          { label: "Linux", description: "Linux", value: "linux" },
          { label: "Web", description: "Web", value: "web" },
        ],
        multiSelect: true,
        allowCustomAnswer: true,
        required: false,
      },
    ]);
    assert.deepStrictEqual(form.toData({ targets: ["web", "Linux", "Mobile"] }), {
      targets: ["linux", "web", "Mobile"],
    });
    assert.deepStrictEqual(form.toData({}), { targets: ["mac"] });
  });

  it("asks a multiple select by its label[for] without free text", () => {
    const form = parseOmpHtmlForm(`<form>
      <label for="langs">Languages</label>
      <select id="langs" name="langs" multiple>
        <option value="ts" selected>TypeScript</option>
        <option value="rs">Rust</option>
        <option selected>Go</option>
        <option value="c" disabled>C</option>
      </select>
    </form>`);
    assert(form !== undefined);
    assert.deepStrictEqual(form.questions, [
      {
        id: "langs",
        header: "Languages",
        question: "Languages",
        options: [
          { label: "TypeScript", description: "TypeScript", value: "ts", selected: true },
          { label: "Rust", description: "Rust", value: "rs" },
          { label: "Go", description: "Go", value: "Go", selected: true },
        ],
        multiSelect: true,
        allowCustomAnswer: false,
        required: false,
      },
    ]);
    assert.deepStrictEqual(form.toData({ langs: ["rs", "Go"] }), { langs: ["rs", "Go"] });
    assert.deepStrictEqual(form.toData({ langs: ["Perl"] }), { langs: ["ts", "Go"] });
  });

  it("submits number inputs as numbers when the text parses", () => {
    const form = parseOmpHtmlForm(
      `<form><label>Port <input type="number" name="port" value="8080" required></label></form>`,
    );
    assert(form !== undefined);
    assert.deepStrictEqual(form.questions, [
      {
        id: "port",
        header: "Port",
        question: "Port",
        options: [],
        allowCustomAnswer: true,
        initialAnswer: "8080",
        required: true,
      },
    ]);
    assert.deepStrictEqual(form.toData({ port: " 3000 " }), { port: 3000 });
    assert.deepStrictEqual(form.toData({ port: "auto" }), { port: "auto" });
    assert.deepStrictEqual(form.toData({}), { port: 8080 });
  });

  it("prefills textareas with their literal content", () => {
    const form = parseOmpHtmlForm(
      `<form><label>Notes<textarea name="notes">\n  keep indentation\n</textarea></label><textarea name="release_notes"></textarea></form>`,
    );
    assert(form !== undefined);
    assert.deepStrictEqual(form.questions, [
      {
        id: "notes",
        header: "Notes",
        question: "Notes",
        options: [],
        allowCustomAnswer: true,
        initialAnswer: "  keep indentation\n",
        required: false,
      },
      {
        id: "release_notes",
        header: "release notes",
        question: "release notes",
        options: [],
        allowCustomAnswer: true,
        initialAnswer: "",
        required: false,
      },
    ]);
    assert.deepStrictEqual(form.toData({ notes: "Ship it", release_notes: "" }), {
      notes: "Ship it",
      release_notes: "",
    });
    assert.deepStrictEqual(form.toData({}), { notes: "  keep indentation\n" });
  });

  it("folds headings, paragraphs, tables, pre and lists into the question as Markdown", () => {
    const form = parseOmpHtmlForm(`<form>
      <h2>Release</h2>
      <p>Current versions:</p>
      <table>
        <thead><tr><th>Package</th><th>Version</th></tr></thead>
        <tbody><tr><td><code>web</code></td><td>1.2.0</td></tr></tbody>
      </table>
      <pre>git tag v1.3.0</pre>
      <ul><li>Run *tests* first</li><li>Then tag</li></ul>
      <label>Next version <input name="version" value="1.3.0"></label>
      <p>Tags are pushed to origin.</p>
    </form>`);
    assert(form !== undefined);
    assert.deepStrictEqual(form.questions, [
      {
        id: "version",
        header: "Next version",
        question: [
          "**Release**",
          "Current versions:",
          "| Package | Version |\n| --- | --- |\n| `web` | 1.2.0 |",
          "```\ngit tag v1.3.0\n```",
          "- Run \\*tests\\* first\n- Then tag",
          "Next version",
          "Tags are pushed to origin.",
        ].join("\n\n"),
        options: [],
        allowCustomAnswer: true,
        initialAnswer: "1.3.0",
        required: false,
      },
    ]);
  });

  it("escapes form text as Markdown", () => {
    const form = parseOmpHtmlForm(
      `<form><p>Pick <code>a|b</code> or <b>2 * 3</b> &lt;now&gt;</p><label><input type="radio" name="x" value="1"> One</label></form>`,
    );
    assert(form !== undefined);
    assert.strictEqual(form.questions[0]?.question, "Pick `a|b` or **2 \\* 3** \\<now>");
  });

  it("returns undefined for a form without an answerable field", () => {
    assert.strictEqual(
      parseOmpHtmlForm(`<form>
        <p>Nothing to answer.</p>
        <input type="hidden" name="token" value="x">
        <input type="submit" value="Send">
        <button name="go">Go</button>
        <input type="text">
        <select name="locked"><option disabled>Only</option></select>
      </form>`),
      undefined,
    );
    assert.strictEqual(parseOmpHtmlForm(""), undefined);
  });

  it("fills unanswered fields with the form's defaults", () => {
    const form = parseOmpHtmlForm(`<form>
      <input type="hidden" name="token" value="abc">
      <p>Plan</p>
      <label><input type="radio" name="plan" value="free"> Free</label>
      <label><input type="radio" name="plan" value="pro"> Pro</label>
      <p>Features</p>
      <label><input type="checkbox" name="features" value="sso"> SSO</label>
      <label><input type="checkbox" name="features" value="audit"> Audit log</label>
      <label><input type="checkbox" name="agree" checked> I agree</label>
      <label>Name <input name="name" value="Ada"></label>
      <label>Email <input type="email" name="email"></label>
      <label>Size <select name="size"><option value="s">Small</option><option value="m">Medium</option></select></label>
    </form>`);
    assert(form !== undefined);
    assert.deepStrictEqual(
      form.questions.map((question) => [question.id, question.question]),
      [
        ["plan", "Plan"],
        ["features", "Features"],
        ["agree", "I agree"],
        ["name", "Name"],
        ["email", "Email"],
        ["size", "Size"],
      ],
    );
    assert.deepStrictEqual(form.questions[2], {
      id: "agree",
      header: "agree",
      question: "I agree",
      options: [{ label: "I agree", description: "I agree", value: "on", selected: true }],
      multiSelect: true,
      allowCustomAnswer: false,
      required: false,
    });
    assert.deepStrictEqual(form.questions[5]?.options, [
      { label: "Small", description: "Small", value: "s", selected: true },
      { label: "Medium", description: "Medium", value: "m" },
    ]);
    // An unchecked radio group is left out; an unchecked checkbox group submits `[]`.
    assert.deepStrictEqual(form.toData({}), {
      token: "abc",
      features: [],
      agree: "on",
      name: "Ada",
      size: "s",
    });
    assert.deepStrictEqual(
      form.toData({
        plan: "pro",
        features: ["audit"],
        email: "ada@example.com",
        size: "Medium",
      }),
      {
        token: "abc",
        plan: "pro",
        features: ["audit"],
        agree: "on",
        name: "Ada",
        email: "ada@example.com",
        size: "m",
      },
    );
  });
});
