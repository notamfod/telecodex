import { describe, expect, it } from "vitest";
import type { DeployRecord, DeploySummaryRow } from "../src/mircli-deploy-data.js";
import { renderDeploySummary } from "../src/mircli-deploy-render.js";
const record: DeployRecord = { id: 1, jobId: 11, projectPath: "mircli/api", ref: "main", status: "success", sha: "a".repeat(40), createdAt: "2026-10-13T08:00:00Z", updatedAt: "2026-10-13T09:00:00Z", jobUrl: "https://gitlab.example.com/mircli/api/-/jobs/11", title: "Merge branch noisy title" };
describe("compact deploy summary", () => {
  it("animates an indeterminate bar and elapsed time only for a fresh running deploy", () => {
    const started = Date.parse("2026-10-13T09:00:00Z");
    const active = { ...record, status: "running", startedAt: "2026-10-13T09:00:00Z" };
    const row: DeploySummaryRow = { projectPath: record.projectPath, ref: "main", active: [active], success: record, checkedAt: "2026-10-13T09:00:00Z" };
    const first = renderDeploySummary([row], "main", started + 5_000)[0];
    const next = renderDeploySummary([row], "main", started + 10_000)[0];
    expect(first).toMatch(/[░█]{10}/);
    expect(next).toMatch(/[░█]{10}/);
    expect(next).not.toEqual(first);
    expect(next).toContain("10с");
    expect(next).not.toContain("%");
    expect(renderDeploySummary([{ ...row, error: "offline" }], "main", started + 10_000)[0]).not.toMatch(/[░█]{10}/);
    expect(renderDeploySummary([{ ...row, active: [], latest: record }], "main", started + 10_000)[0]).not.toMatch(/[░█]{10}/);
  });
  it("shows a safely escaped failure cause alongside the initiator", () => {
    const html = renderDeploySummary([{ projectPath: record.projectPath, ref: "main", active: [], latest: {
      ...record, status: "failed", deployer: "Alex", failureSummary: "Readiness <probe> & timeout",
    } }], "main")[0];
    expect(html).toContain("причина: Readiness &lt;probe&gt; &amp; timeout");
    expect(html).toContain("запустил: Alex");
  });
  it("shows a safely escaped initiator only for failed deployments", () => {
    const html = renderDeploySummary([
      { projectPath: "mircli/failed", ref: "main", active: [], latest: { ...record, status: "failed", deployer: "Alex <admin> & team" } },
      { projectPath: "mircli/healthy", ref: "main", active: [], latest: { ...record, deployer: "Healthy User" } },
    ], "main")[0];
    expect(html).toContain("запустил: Alex &lt;admin&gt; &amp; team");
    expect(html).not.toContain("Healthy User");
    expect(html).not.toContain("<admin>");
    expect(renderDeploySummary([{ projectPath: "mircli/failed", ref: "main", active: [], latest: { ...record, status: "failed" } }], "main")[0]).toContain("запустил: неизвестно");
  });
  it("fits 13 services in one card, shows Moscow time once and omits repeated noise", () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ projectPath: `mircli/service${i}`, ref: "main" as const, active: [], latest: { ...record, projectPath: `mircli/service${i}` }, success: { ...record, projectPath: `mircli/service${i}` }, checkedAt: "2026-10-13T09:00:00Z" }));
    const pages = renderDeploySummary(rows, "main");
    expect(pages).toHaveLength(1);
    const text = pages[0];
    expect(text).toContain("DEV");
    expect(text).toContain("12:00");
    for (let i = 0; i < 13; i++) expect(text).toContain(`service${i}`);
    expect(text).not.toMatch(/Активные: 0|Проверено:|Merge branch|deploy jobs|Последняя попытка/);
    expect(text.split("\n").length).toBeLessThan(22);
    expect(text.length).toBeLessThan(3900);
  });
  it("puts running and failed services above healthy ones and keeps last success for failures", () => {
    const row = (projectPath: string, status: string): DeploySummaryRow => ({ projectPath, ref: "main", active: status === "running" ? [{ ...record, projectPath, status }] : [], latest: { ...record, projectPath, status: status === "running" ? "success" : status }, success: { ...record, projectPath, id: status === "failed" ? 2 : 1 } });
    const html = renderDeploySummary([row("mircli/healthy", "success"), row("mircli/broken", "failed"), row("mircli/running", "running")], "main")[0];
    expect(html.indexOf("running")).toBeLessThan(html.indexOf("healthy"));
    expect(html.indexOf("broken")).toBeLessThan(html.indexOf("healthy"));
    expect(html).toContain("последний успех");
    expect(html).toContain("выкладывается");
  });
  it("marks stale data and hides services that have no deployments in the selected environment", () => {
    const html = renderDeploySummary([{ projectPath: "mircli/<bad>", ref: "main", active: [], latest: record, error: "<secret>" }, { projectPath: "mircli/empty", ref: "main", active: [] }], "main")[0];
    expect(html).toContain("&lt;bad&gt;");
    expect(html).toContain("устарели");
    expect(html).not.toContain("empty");
    expect(html).not.toContain("<secret>");
  });
  it("bounds oversized summaries and rejects unsafe links without splitting HTML", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ projectPath: `mircli/service${i}`, ref: "main" as const, active: [], latest: { ...record, jobUrl: "javascript:alert(1)" } }));
    const pages = renderDeploySummary(rows, "main");
    expect(pages).toHaveLength(1);
    expect(pages[0].length).toBeLessThan(3900);
    expect(pages[0]).not.toContain("javascript:");
    expect((pages[0].match(/<b>/g) ?? []).length).toBe((pages[0].match(/<\/b>/g) ?? []).length);
  });
});
