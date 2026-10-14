import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { apkAcquirer, type DownloadState } from "../../backend/src/apk-download";
const pkg = "com.example.reference", bytes = Buffer.from("fixture-apk-bytes"), url = "https://pool.apk.aptoide.com/fixture/reference.apk";
const metadata = (changes: Record<string, unknown> = {}) => ({ nodes: { meta: { data: { package: pkg, file: { path: url, filesize: bytes.length, md5sum: createHash("md5").update(bytes).digest("hex"), malware: { rank: "TRUSTED" }, ...changes } } } } });
async function fixture(work: (dir: string) => Promise<void>) { const dir = await mkdtemp(path.join(tmpdir(), "meld-apk-download-")); try { await work(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
const fetcher = (meta: unknown, payload = bytes) => (async (input: any) => String(input).includes("app/get/") ? Response.json(meta) : new Response(payload)) as typeof fetch;
test("verified streamed download retains provenance and real byte progress", async () => fixture(async dir => {
  const states: DownloadState[] = [], file = path.join(dir, "reference.apk");
  await apkAcquirer({ aapt: "unused", fetcher: fetcher(metadata()), verify: async (candidate, identity) => { expect(identity).toBe(pkg); expect(await readFile(candidate)).toEqual(bytes); } })(pkg, file, async value => { states.push(value); });
  expect(await readFile(file)).toEqual(bytes); expect(states.at(-1)).toMatchObject({ status: "completed", bytes: bytes.length, totalBytes: bytes.length });
  expect(JSON.parse(await readFile(`${file}.provenance.json`, "utf8"))).toMatchObject({ packageId: pkg, provider: "Aptoide", sha256: createHash("sha256").update(bytes).digest("hex") });
}));
for (const [name, meta, payload, message] of [
  ["checksum mismatch", metadata({ md5sum: "0".repeat(32) }), bytes, "checksum"],
  ["untrusted file", metadata({ malware: { rank: "UNKNOWN" } }), bytes, "trusted"],
  ["oversized file", metadata({ filesize: 300 * 1024 * 1024 }), bytes, "limit"],
  ["truncated download", metadata(), bytes.subarray(0, 3), "verification"],
  ["private download URL", metadata({ path: "https://127.0.0.1/private.apk" }), bytes, "unsupported"],
] as const) test(`acquisition rejects ${name} and removes incomplete APKs`, async () => fixture(async dir => {
  const states: DownloadState[] = [];
  await expect(apkAcquirer({ aapt: "unused", fetcher: fetcher(meta, payload), verify: async () => {} })(pkg, path.join(dir, "reference.apk"), async state => { states.push(state); })).rejects.toThrow(message);
  expect(states.at(-1)?.status).toBe("failed"); expect(await readdir(dir)).toEqual([]);
}));
test("cross-host redirects are rejected before making a private network request", async () => fixture(async dir => {
  const calls: string[] = [], mock = (async (input: any) => { calls.push(String(input)); return new Response(null, { status: 302, headers: { location: "https://localhost/secret" } }); }) as typeof fetch;
  await expect(apkAcquirer({ aapt: "unused", fetcher: mock })(pkg, path.join(dir, "reference.apk"), async () => {})).rejects.toThrow("unsupported"); expect(calls).toHaveLength(1);
}));
test("manifest verification failure never promotes a downloaded file", async () => fixture(async dir => {
  await expect(apkAcquirer({ aapt: "unused", fetcher: fetcher(metadata()), verify: async () => { throw new Error("Wrong manifest package"); } })(pkg, path.join(dir, "reference.apk"), async () => {})).rejects.toThrow("Wrong manifest package"); expect(await readdir(dir)).toEqual([]);
}));
