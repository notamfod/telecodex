import { describe, expect, it } from "vitest";

import {
  MAX_FINDINGS,
  buildFixPrompt,
  fingerprintFinding,
  fixTopicName,
  keepExistingFiles,
  parseFindings,
  renderFindingHTML,
  renderRunHTML,
  triageFindings,
} from "../src/recipes.js";

const line = (severity: string, at: string, category: string, text: string) =>
  `FINDING|${severity}|${at}|${category}|${text}`;

describe("parseFindings", () => {
  it("parses a well-formed finding line", () => {
    const [finding] = parseFindings(
      line("high", "app/Services/Feed.php:42", "n+1", "Product::find в цикле импорта"),
    );

    expect(finding).toEqual({
      severity: "high",
      file: "app/Services/Feed.php",
      line: 42,
      category: "n+1",
      description: "Product::find в цикле импорта",
    });
  });

  it("ignores the prose the agent wraps around the machine-readable lines", () => {
    const findings = parseFindings(
      [
        "Посмотрел диff, вот что нашёл:",
        line("medium", "app/Jobs/Sync.php:10", "queue", "нет timeout"),
        "",
        "Больше ничего серьёзного.",
      ].join("\n"),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("queue");
  });

  it("returns nothing for the NO_FINDINGS sentinel", () => {
    expect(parseFindings("NO_FINDINGS")).toEqual([]);
  });

  it("keeps a finding whose file carries no line number", () => {
    const [finding] = parseFindings(line("low", "database/migrations", "index", "нет индекса"));

    expect(finding.file).toBe("database/migrations");
    expect(finding.line).toBeUndefined();
  });

  it("keeps a description that contains the delimiter", () => {
    const [finding] = parseFindings(
      line("high", "a.php:1", "raw-sql", "DB::raw('a' | 'b') склеивает ввод"),
    );

    expect(finding.description).toBe("DB::raw('a' | 'b') склеивает ввод");
  });

  it("downgrades an unrecognised severity instead of dropping the finding", () => {
    const [finding] = parseFindings(line("ОЧЕНЬ ВАЖНО", "a.php:1", "misc", "что-то"));

    expect(finding.severity).toBe("medium");
  });

  it("skips a line that has no description at all", () => {
    expect(parseFindings("FINDING|high|a.php:1|n+1|")).toEqual([]);
  });

  it("sorts by severity, worst first", () => {
    const findings = parseFindings(
      [
        line("low", "c.php:1", "x", "третья"),
        line("critical", "a.php:1", "x", "первая"),
        line("medium", "b.php:1", "x", "вторая"),
      ].join("\n"),
    );

    expect(findings.map((f) => f.description)).toEqual(["первая", "вторая", "третья"]);
  });

  it("caps the list so one noisy run cannot flood the topic", () => {
    const many = Array.from({ length: MAX_FINDINGS + 5 }, (_, i) =>
      line("high", `f${i}.php:1`, "x", `находка ${i}`),
    ).join("\n");

    expect(parseFindings(many)).toHaveLength(MAX_FINDINGS);
  });
});

describe("keepExistingFiles", () => {
  const findings = parseFindings(
    [
      "FINDING|high|src/app/Real.php:10|n+1|настоящая находка",
      "FINDING|high|src/database/migrations/2026_08_11_add_slug.php:18|index-not-concurrent|пример из промпта",
    ].join("\n"),
  );

  it("drops a finding about a file the repository does not have", () => {
    const kept = keepExistingFiles(findings, (file) => file === "src/app/Real.php");

    expect(kept.map((f) => f.description)).toEqual(["настоящая находка"]);
  });

  it("keeps everything when every path checks out", () => {
    expect(keepExistingFiles(findings, () => true)).toHaveLength(2);
  });

  it("drops the format line if the agent echoes the template", () => {
    const echoed = parseFindings("FINDING|severity|путь/к/файлу.php:строка|категория|краткое описание");

    expect(keepExistingFiles(echoed, () => false)).toEqual([]);
  });
});

describe("fingerprintFinding", () => {
  const base = {
    severity: "high" as const,
    file: "app/Services/Feed.php",
    line: 42,
    category: "n+1",
    description: "Product::find в цикле импорта",
  };

  it("ignores the line number, so a finding surviving a rebase stays one finding", () => {
    expect(fingerprintFinding({ ...base, line: 42 })).toBe(fingerprintFinding({ ...base, line: 380 }));
  });

  it("ignores case and whitespace churn in the description", () => {
    expect(fingerprintFinding({ ...base, description: "Product::find   В Цикле импорта" })).toBe(
      fingerprintFinding(base),
    );
  });

  it("ignores digits inside the description, which usually echo the line number", () => {
    expect(fingerprintFinding({ ...base, description: "N+1 на строке 42" })).toBe(
      fingerprintFinding({ ...base, description: "N+1 на строке 380" }),
    );
  });

  it("separates findings that differ by file", () => {
    expect(fingerprintFinding({ ...base, file: "app/Services/Other.php" })).not.toBe(
      fingerprintFinding(base),
    );
  });

  it("separates findings that differ by category", () => {
    expect(fingerprintFinding({ ...base, category: "queue" })).not.toBe(fingerprintFinding(base));
  });
});

describe("triageFindings", () => {
  const findings = parseFindings(
    [
      line("high", "a.php:1", "n+1", "первая"),
      line("high", "b.php:1", "queue", "вторая"),
      line("low", "c.php:1", "index", "третья"),
    ].join("\n"),
  );
  const [first, second, third] = findings;

  it("calls everything fresh on the very first run", () => {
    const result = triageFindings(findings, { seen: [], ignored: [] });

    expect(result.fresh).toHaveLength(3);
    expect(result.repeated).toHaveLength(0);
    expect(result.suppressed).toHaveLength(0);
  });

  it("moves a finding seen in the previous run out of fresh", () => {
    const result = triageFindings(findings, { seen: [fingerprintFinding(first)], ignored: [] });

    expect(result.fresh.map((f) => f.description)).toEqual(["вторая", "третья"]);
    expect(result.repeated.map((f) => f.description)).toEqual(["первая"]);
  });

  it("suppresses a finding the user muted, even when it is new this run", () => {
    const result = triageFindings(findings, { seen: [], ignored: [fingerprintFinding(second)] });

    expect(result.fresh.map((f) => f.description)).toEqual(["первая", "третья"]);
    expect(result.suppressed.map((f) => f.description)).toEqual(["вторая"]);
  });

  it("prefers suppressed over repeated, so a muted finding never resurfaces", () => {
    const fp = fingerprintFinding(third);
    const result = triageFindings(findings, { seen: [fp], ignored: [fp] });

    expect(result.repeated).toHaveLength(0);
    expect(result.suppressed.map((f) => f.description)).toEqual(["третья"]);
  });

  it("reports nothing to deliver when every finding is old news", () => {
    const result = triageFindings(findings, {
      seen: findings.map(fingerprintFinding),
      ignored: [],
    });

    expect(result.fresh).toHaveLength(0);
    expect(result.shouldDeliver).toBe(false);
  });

  it("asks for delivery as soon as one finding is fresh", () => {
    const result = triageFindings(findings, {
      seen: [fingerprintFinding(first), fingerprintFinding(second)],
      ignored: [],
    });

    expect(result.shouldDeliver).toBe(true);
  });
});

describe("renderFindingHTML", () => {
  const [finding] = parseFindings(
    "FINDING|critical|app/Jobs/Import.php:88|dispatch-in-transaction|dispatch внутри транзакции",
  );

  it("shows the location, the category and the text", () => {
    const html = renderFindingHTML(finding);

    expect(html).toContain("app/Jobs/Import.php:88");
    expect(html).toContain("dispatch-in-transaction");
    expect(html).toContain("dispatch внутри транзакции");
  });

  it("escapes code quoted in the description", () => {
    const [risky] = parseFindings("FINDING|high|a.php:1|xss|<b>bold</b>");

    expect(renderFindingHTML(risky)).toContain("&lt;b&gt;");
  });

  it("prefixes the path with the project, since each finding is read on its own", () => {
    expect(renderFindingHTML(finding, "mir-back")).toContain("mir-back/app/Jobs/Import.php:88");
  });

  it("leaves the path alone when no project is given", () => {
    expect(renderFindingHTML(finding)).toContain("app/Jobs/Import.php:88");
  });

  it("does not repeat the project when the path already starts with it", () => {
    const [dep] = parseFindings("FINDING|low|mir-back/src/composer.json|dep-safe|12 обновлений");

    expect(renderFindingHTML(dep, "mir-back")).not.toContain("mir-back/mir-back");
  });
});

describe("fixTopicName", () => {
  const [finding] = parseFindings(
    "FINDING|critical|src/app/Jobs/ImportFeed.php:88|dispatch-in-transaction|dispatch внутри транзакции",
  );

  it("names the file and the category, not the whole path", () => {
    const name = fixTopicName(finding);

    expect(name).toContain("ImportFeed.php");
    expect(name).toContain("dispatch-in-transaction");
    expect(name).not.toContain("src/app/Jobs");
  });

  it("keeps the line number, since the same file can have two findings", () => {
    expect(fixTopicName(finding)).toContain("88");
  });

  it("stays inside Telegram's topic name limit", () => {
    const [long] = parseFindings(
      `FINDING|high|${"a".repeat(200)}/File.php:1|${"категория".repeat(20)}|текст`,
    );

    expect([...fixTopicName(long)].length).toBeLessThanOrEqual(128);
  });

  it("copes with a finding that has no line number", () => {
    const [noLine] = parseFindings("FINDING|low|composer.json|dep-safe|12 обновлений безопасны");

    expect(fixTopicName(noLine)).toContain("composer.json");
  });
});

describe("buildFixPrompt", () => {
  const [finding] = parseFindings(
    "FINDING|critical|app/Jobs/Import.php:88|dispatch-in-transaction|dispatch внутри транзакции",
  );

  it("quotes the finding so the agent knows what to check", () => {
    const prompt = buildFixPrompt("daily-diff-review", finding);

    expect(prompt).toContain("app/Jobs/Import.php:88");
    expect(prompt).toContain("dispatch внутри транзакции");
  });

  it("names the recipe the finding came from", () => {
    expect(buildFixPrompt("migration-audit", finding)).toContain("migration-audit");
  });

  it("asks the agent to confirm the finding before touching anything", () => {
    expect(buildFixPrompt("daily-diff-review", finding)).toMatch(/подтверд|проверь/i);
  });

  it("tells the agent not to commit", () => {
    expect(buildFixPrompt("daily-diff-review", finding)).toMatch(/не коммить/i);
  });
});

describe("renderRunHTML", () => {
  const findings = parseFindings(
    [
      line("critical", "app/Jobs/Import.php:88", "queue", "dispatch внутри транзакции"),
      line("medium", "app/Models/Product.php:12", "n+1", "аксессор дёргает связь"),
    ].join("\n"),
  );

  it("names the recipe and lists every fresh finding with its location", () => {
    const html = renderRunHTML({
      recipe: "daily-diff-review",
      fresh: findings,
      repeated: [],
      suppressed: [],
    });

    expect(html).toContain("daily-diff-review");
    expect(html).toContain("app/Jobs/Import.php:88");
    expect(html).toContain("dispatch внутри транзакции");
    expect(html).toContain("app/Models/Product.php:12");
  });

  it("escapes HTML so a finding quoting code cannot break the message", () => {
    const html = renderRunHTML({
      recipe: "r",
      fresh: parseFindings(line("high", "a.php:1", "xss", "<script>alert(1)</script>")),
      repeated: [],
      suppressed: [],
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("mentions the muted and repeated counts without listing them", () => {
    const html = renderRunHTML({
      recipe: "r",
      fresh: [findings[0]],
      repeated: [findings[1]],
      suppressed: [findings[1]],
    });

    expect(html).toContain("dispatch внутри транзакции");
    expect(html).not.toContain("аксессор");
    expect(html).toMatch(/повтор/i);
    expect(html).toMatch(/заглуш/i);
  });

  it("says so plainly when the run produced nothing fresh", () => {
    const html = renderRunHTML({ recipe: "r", fresh: [], repeated: findings, suppressed: [] });

    expect(html).toMatch(/новых находок нет/i);
  });

  it("stays inside the Telegram message limit even with a full batch", () => {
    const fresh = parseFindings(
      Array.from({ length: MAX_FINDINGS }, (_, i) =>
        line("high", `app/Very/Long/Path/File${i}.php:${i}`, "category", "о".repeat(600)),
      ).join("\n"),
    );

    expect(renderRunHTML({ recipe: "r", fresh, repeated: [], suppressed: [] }).length).toBeLessThanOrEqual(4096);
  });
});
