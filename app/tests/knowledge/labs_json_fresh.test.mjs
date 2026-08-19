import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const REPO = new URL("../../..", import.meta.url).pathname;

test("labs.json 建置產物與 labs.yaml 同步（--check 守衛）", () => {
  const out = execFileSync("python3", ["app/scripts/build_labs_json.py", "--check"],
    { cwd: REPO, encoding: "utf-8" });
  assert.match(out, /同步/);
});

test("body_refs.json 建置產物與 body_refs.yaml 同步（--check 守衛）", () => {
  const out = execFileSync("python3", ["app/scripts/build_body_refs_json.py", "--check"],
    { cwd: REPO, encoding: "utf-8" });
  assert.match(out, /同步/);
});
