import { highlightGitlabDiff } from "../web/src/gitlab-review-highlight.js";

describe("GitLab diff syntax highlighting", () => {
  it("keeps diff prefixes while tokenizing JavaScript keywords, strings, numbers, and comments", () => {
    const diff = [
      "@@ -1,2 +1,3 @@",
      "-const removed = 1;",
      "+const value = \"safe\"; // note",
      " console.log(value);",
    ].join("\n");

    const rows = highlightGitlabDiff(diff, "src/example.js");

    expect(rows.map((row) => row.tokens.map((token) => token.text).join("")).join("\n")).toBe(diff);
    expect(rows[0]).toEqual({ kind: "hunk", tokens: [{ text: "@@ -1,2 +1,3 @@", className: "" }] });
    expect(rows[2]?.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "const", className: expect.stringContaining("hljs-keyword") }),
      expect.objectContaining({ text: "\"safe\"", className: expect.stringContaining("hljs-string") }),
      expect.objectContaining({ text: "// note", className: expect.stringContaining("hljs-comment") }),
    ]));
    expect(rows[1]?.tokens[0]).toMatchObject({ text: "-" });
  });

  it("keeps old and new projections independent across multiline comments and resets at a hunk", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      "-/* old comment",
      "-still old */",
      "+const fresh = 7;",
      "@@ -10,1 +10,1 @@",
      "+const next = 8;",
    ].join("\n");

    const rows = highlightGitlabDiff(diff, "src/example.ts");

    expect(rows[3]?.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "const", className: expect.stringContaining("hljs-keyword") }),
      expect.objectContaining({ text: "7", className: expect.stringContaining("hljs-number") }),
    ]));
    expect(rows[5]?.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "const", className: expect.stringContaining("hljs-keyword") }),
      expect.objectContaining({ text: "8", className: expect.stringContaining("hljs-number") }),
    ]));
  });

  it("leaves headers, unknown files, and HTML-looking code as safe plain text", () => {
    const diff = ["--- a/file", "+++ b/file", "\\ No newline at end of file", "+<img src=x onerror=alert(1)>"].join("\n");
    const rows = highlightGitlabDiff(diff, "README.unknown", "README.unknown");

    expect(rows.map((row) => row.kind)).toEqual(["hunk", "hunk", "context", "added"]);
    expect(rows.flatMap((row) => row.tokens).map((token) => token.text).join("\n")).toBe(diff);
    expect(rows.every((row) => row.tokens.every((token) => token.className === ""))).toBe(true);
  });

  it("preserves a trailing newline without synthesizing a context prefix", () => {
    const diff = "@@ -1 +1 @@\n+const value = 1;\n";
    const rows = highlightGitlabDiff(diff, "value.js");

    expect(rows.map((row) => row.tokens.map((token) => token.text).join("")).join("\n")).toBe(diff);
    expect(rows.at(-1)).toEqual({ kind: "context", tokens: [{ text: "", className: "" }] });
  });

  it("highlights multiline comments and treats triple-sign code inside a hunk as changes", () => {
    const diff = "--- a/count.js\n+++ b/count.js\n@@ -1,2 +1,5 @@\n--- count;\n+++ count;\n+/* note\n+ continued comment\n+ */\n+const count = 1;";
    const rows = highlightGitlabDiff(diff, "count.js");
    expect(rows[3]?.kind).toBe("removed");
    expect(rows[4]?.kind).toBe("added");
    expect(rows[6]?.tokens.some(token => token.className.includes("hljs-comment"))).toBe(true);
    expect(rows[8]?.tokens.some(token => token.className.includes("hljs-keyword"))).toBe(true);
    expect(rows.map(row => row.tokens.map(token => token.text).join("")).join("\n")).toBe(diff);
  });

  it("preserves markup-looking text in supported syntax without turning it into HTML", () => {
    const diff = '@@ -0,0 +1 @@\n+const html = "<img src=x onerror=alert(1)>";';
    const rows = highlightGitlabDiff(diff, "view.js");
    expect(rows[1]?.tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '\"<img src=x onerror=alert(1)>\"', className: expect.stringContaining("hljs-string") }),
    ]));
    expect(rows.map(row => row.tokens.map(token => token.text).join("")).join("\n")).toBe(diff);
  });

  it("numbers each version independently and restarts at the next hunk", () => {
    const diff = "--- a/test.txt\n+++ b/test.txt\n@@ -10,3 +20,4 @@ heading\n first\n-old\n+new\n+extra\n last\n\\ No newline at end of file\n@@ -50 +80 @@\n-previous\n+next\n";
    const rows = highlightGitlabDiff(diff, "test.txt");
    expect(rows.map(row => [row.oldLine, row.newLine])).toEqual([
      [undefined, undefined], [undefined, undefined], [undefined, undefined],
      [10, 20], [11, undefined], [undefined, 21], [undefined, 22], [12, 23],
      [undefined, undefined], [undefined, undefined], [50, undefined], [undefined, 80],
      [undefined, undefined],
    ]);
  });

  it("handles new/deleted files and stops numbering when a range ends or is invalid", () => {
    const diff = "@@ -0,0 +1,2 @@\n+first\n+second\n+outside\n@@ -7,2 +0,0 @@\n-old\n-older\n@@ broken @@\n+unknown\n@@ -9007199254740992 +1 @@\n+invalid";
    const rows = highlightGitlabDiff(diff, "test.js");
    expect(rows.map(row => [row.oldLine, row.newLine])).toEqual([
      [undefined, undefined], [undefined, 1], [undefined, 2], [undefined, undefined],
      [undefined, undefined], [7, undefined], [8, undefined], [undefined, undefined],
      [undefined, undefined], [undefined, undefined], [undefined, undefined],
    ]);
  });

});
