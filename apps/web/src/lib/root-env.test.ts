import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRootEnv, parseEnvFile } from "./root-env";

describe("root env", () => {
  it("parses quotes, export, comments", () => {
    expect(parseEnvFile('# c\nA=1\nexport B="x y" # note\nC=\'q\'\nD=v # c\nE=\n')).toEqual({ A: "1", B: "x y", C: "q", D: "v", E: "" });
  });
  it("fills gaps only: real env and earlier values win, .env.local beats .env", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-rootenv-"));
    fs.writeFileSync(path.join(d, ".env.local"), "A=local\nB=local\n");
    fs.writeFileSync(path.join(d, ".env"), "B=dot\nC=dot\n");
    const env: Record<string, string | undefined> = { A: "real" };
    expect(loadRootEnv(d, env).sort()).toEqual(["B", "C"]);
    expect(env).toEqual({ A: "real", B: "local", C: "dot" });
    expect(loadRootEnv(path.join(d, "missing"), env)).toEqual([]);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
