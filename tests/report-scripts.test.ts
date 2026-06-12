import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");

function withTempProject(run: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "stock-report-test-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function runScript(cwd: string, script: string, ...args: string[]) {
  execFileSync(process.execPath, ["--import", tsxLoader, resolve(repoRoot, script), ...args], {
    cwd,
    encoding: "utf8",
  });
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

test("assemble-analysis prefers story files and preserves classification fallback stories", () => {
  withTempProject((cwd) => {
    writeJson(join(cwd, "data/tmp/classification.json"), {
      timestamp: "2026/06/05",
      date: "2026-06-05",
      summary: "盤後摘要",
      gainers: [
        {
          id: "g01",
          category: "低軌衛星/HDI高階PCB",
          stocks: ["華通(2313)"],
          story: "分類內故事",
        },
      ],
      losers: [
        {
          id: "l01",
          category: "其他弱勢",
          stocks: ["測試股(9999)"],
          story: "沿用故事",
        },
      ],
    });
    mkdirSync(join(cwd, "data/tmp/stories"), { recursive: true });
    writeFileSync(join(cwd, "data/tmp/stories/g01.txt"), "worker story\n", "utf8");

    runScript(cwd, "scripts/assemble-analysis.ts");

    const output = readJson<{
      timestamp: string;
      date: string;
      summary: string;
      gainers: Array<{ category: string; stocks: string[]; story: string }>;
      losers: Array<{ category: string; stocks: string[]; story: string }>;
    }>(join(cwd, "data/analysis-latest.json"));

    assert.equal(output.timestamp, "2026/06/05");
    assert.equal(output.date, "2026-06-05");
    assert.equal(output.summary, "盤後摘要");
    assert.deepEqual(output.gainers, [
      {
        category: "低軌衛星/HDI高階PCB",
        stocks: ["華通(2313)"],
        story: "worker story",
      },
    ]);
    assert.deepEqual(output.losers, [
      {
        category: "其他弱勢",
        stocks: ["測試股(9999)"],
        story: "沿用故事",
      },
    ]);
  });
});

test("refine-group-tasks splits known override stocks into deterministic categories", () => {
  withTempProject((cwd) => {
    const taskDir = join(cwd, "data/tmp/group-tasks");
    writeJson(join(taskDir, "01-gainer-pcb.json"), {
      tradingDate: "2026-06-05",
      timestamp: "2026/06/05",
      category: "PCB/傳統板廠與HDI板",
      direction: "gainer",
      stocks: ["華通(2313)", "燿華(2367)"],
      members: [
        { code: "2313", name: "華通", pct: 9.8 },
        { code: "2367", name: "燿華", pct: 7.1 },
      ],
      preliminaryStory: "原始 PCB 故事",
      queryHints: ["PCB 台股"],
    });
    writeJson(join(taskDir, "02-gainer-memory.json"), {
      tradingDate: "2026-06-05",
      timestamp: "2026/06/05",
      category: "電子零組件/半導體個股整理",
      direction: "gainer",
      stocks: ["商丞(8277)", "群聯(8299)"],
      members: [
        { code: "8277", name: "商丞", pct: 6.2 },
        { code: "8299", name: "群聯", pct: 5.4 },
      ],
      preliminaryStory: "",
      queryHints: [],
    });

    runScript(cwd, "scripts/refine-group-tasks.ts", taskDir);

    const tasks = readdirSync(taskDir)
      .sort()
      .map((file) => readJson<{ category: string; stocks: string[]; queryHints: string[] }>(join(taskDir, file)));

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].category, "低軌衛星/HDI高階PCB");
    assert.deepEqual(tasks[0].stocks, ["華通(2313)", "燿華(2367)"]);
    assert.ok(tasks[0].queryHints.some((hint) => hint.includes("低軌衛星")));
    assert.equal(tasks[1].category, "DRAM/NAND記憶體模組與控制IC");
    assert.deepEqual(tasks[1].stocks, ["商丞(8277)", "群聯(8299)"]);
  });
});

test("generate-group-tasks-fallback groups market data into report tasks", () => {
  withTempProject((cwd) => {
    writeJson(join(cwd, "data/market-latest.json"), {
      tradingDate: "2026-06-05",
      timestamp: "2026/06/05",
      gainers: [
        { code: "2313", name: "華通", pct: 9.8 },
        { code: "2367", name: "燿華", pct: 7.1 },
      ],
      losers: [{ code: "6488", name: "環球晶", pct: -4.2 }],
    });

    const taskDir = join(cwd, "data/tmp/group-tasks");
    runScript(cwd, "scripts/generate-group-tasks-fallback.ts", taskDir);

    const tasks = readdirSync(taskDir)
      .sort()
      .map((file) =>
        readJson<{
          tradingDate: string;
          timestamp: string;
          category: string;
          direction: "gainer" | "loser";
          stocks: string[];
          queryHints: string[];
        }>(join(taskDir, file)),
      );

    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((task) => task.category),
      ["低軌衛星/HDI高階PCB", "矽晶圓/半導體基板"],
    );
    assert.deepEqual(tasks[0].stocks, ["華通(2313)", "燿華(2367)"]);
    assert.equal(tasks[0].tradingDate, "2026-06-05");
    assert.equal(tasks[0].timestamp, "2026/06/05");
    assert.equal(tasks[1].direction, "loser");
    assert.ok(tasks[1].queryHints.includes("矽晶圓/半導體基板 台股 盤後"));
  });
});
