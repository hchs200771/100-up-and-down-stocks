import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxLoader = resolve(root, "node_modules/tsx/dist/loader.mjs");
const runTs = (cwd: string, script: string, args: string[] = []) =>
  execFileSync(process.execPath, ["--import", tsxLoader, resolve(root, script), ...args], { cwd, encoding: "utf8" });

test("controller 漏股時保留既有分類並 deterministic 補齊", () => {
  const cwd = mkdtempSync(join(tmpdir(), "split-controller-"));
  mkdirSync(join(cwd, "data"));
  writeFileSync(join(cwd, "data/market-latest.json"), JSON.stringify({
    tradingDate: "2026-09-16",
    timestamp: "2026/09/16",
    gainers: [
      { code: "1001", name: "甲", pct: 10 },
      { code: "1002", name: "乙", pct: 9 },
    ],
    losers: [],
  }));
  const controller = join(cwd, "controller.json");
  writeFileSync(controller, JSON.stringify({
    direction: "gainer",
    groups: [{
      slug: "alpha",
      category: "測試族群",
      members: [{ code: "1001", name: "甲", pct: 10 }],
      preliminaryStory: "測試族群受到需求與資金帶動。",
      queryHints: ["測試族群"],
    }],
  }));

  const taskDir = join(cwd, "tasks");
  const output = runTs(cwd, "scripts/split-codex-controller-output.ts", [controller, taskDir, "gainer"]);
  const files = readdirSync(taskDir).filter((file) => file.endsWith(".json"));
  const tasks = files.map((file) => JSON.parse(readFileSync(join(taskDir, file), "utf8")));
  assert.match(output, /1 supplemented/);
  assert.deepEqual(tasks.flatMap((task) => task.members.map((member: { code: string }) => member.code)).sort(), ["1001", "1002"]);
  assert.equal(tasks.find((task) => task.members.some((member: { code: string }) => member.code === "1002"))?.category, "其他強勢個股事件整理");
});

test("analysis 完整性檢查拒絕空白上漲族群", () => {
  const cwd = mkdtempSync(join(tmpdir(), "analysis-completeness-"));
  mkdirSync(join(cwd, "data/tmp"), { recursive: true });
  writeFileSync(join(cwd, "data/market-latest.json"), JSON.stringify({ tradingDate: "2026-09-16", gainers: [{}], losers: [{}] }));
  writeFileSync(join(cwd, "data/tmp/analysis-skeleton.json"), JSON.stringify({
    date: "2026-09-16",
    gainers: [{ category: "強勢", stocks: ["甲(1001)"] }],
    losers: [{ category: "弱勢", stocks: ["乙(1002)"] }],
  }));
  writeFileSync(join(cwd, "data/analysis-latest.json"), JSON.stringify({
    date: "2026-09-16",
    gainers: [],
    losers: [{ category: "弱勢", stocks: ["乙(1002)"] }],
  }));

  const result = spawnSync(process.execPath, ["--import", tsxLoader, resolve(root, "scripts/validate-analysis-completeness.ts")], { cwd, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /analysis is empty/);
});
