import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { checkApk, write } from "../../pipeline/dist/src/integration.js";

export type DownloadState = { status: "pending" | "running" | "completed" | "failed"; bytes: number; totalBytes?: number; source?: string; message?: string };
export type ApkAcquirer = (packageId: string, destination: string, progress: (state: DownloadState) => Promise<void>) => Promise<string>;
const exec = promisify(execFile);
const allowedHosts = new Set(["ws75.aptoide.com", "pool.apk.aptoide.com"]);
function allowedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.has(url.hostname) || url.port && url.port !== "443") throw new Error("APK source returned an unsupported download URL.");
  return url.toString();
}
async function request(url: string, fetcher: typeof fetch, signal: AbortSignal) {
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetcher(allowedUrl(url), { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get("location"); await response.body?.cancel(); if (!location) throw new Error("APK source returned an empty redirect."); url = new URL(location, url).toString(); continue; }
    return response;
  }
  throw new Error("APK source returned too many redirects.");
}
export function apkAcquirer(options: { aapt: string; fetcher?: typeof fetch; maxBytes?: number; timeoutMs?: number; verify?: (file: string, packageId: string) => Promise<void> }): ApkAcquirer {
  const fetcher = options.fetcher || fetch, maxBytes = options.maxBytes || 256 * 1024 * 1024;
  return async (packageId, destination, progress) => {
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(packageId)) throw new Error("Invalid reference package ID.");
    const signal = AbortSignal.timeout(options.timeoutMs || 180000), temporary = `${destination}.${randomUUID()}.part.apk`;
    const state: DownloadState = { status: "running", bytes: 0, source: "Aptoide", message: "Looking up a downloadable APK…" };
    await progress({ ...state });
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const metadataUrl = `https://ws75.aptoide.com/api/7/app/get/package_name=${encodeURIComponent(packageId)}`;
      const response = await request(metadataUrl, fetcher, signal);
      if (!response.ok) throw new Error(response.status === 404 ? "No downloadable APK is available from Aptoide for this app." : `APK metadata request failed (HTTP ${response.status}).`);
      const metadataText = await response.text(); if (metadataText.length > 2 * 1024 * 1024) throw new Error("APK metadata exceeded its size limit.");
      const meta = JSON.parse(metadataText)?.nodes?.meta?.data;
      if (meta?.package !== packageId || typeof meta?.file?.path !== "string") throw new Error("APK source package does not match the selected app.");
      if (meta.file.malware?.rank !== "TRUSTED") throw new Error("APK source did not label this file trusted; automatic download stopped.");
      const url = allowedUrl(meta.file.path), expectedBytes = Number(meta.file.filesize), expectedMd5 = meta.file.md5sum;
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maxBytes || !/^[a-f\d]{32}$/i.test(expectedMd5 || "")) throw new Error("APK source size or checksum is missing or outside the download limit.");
      await fs.mkdir(path.dirname(destination), { recursive: true }); handle = await fs.open(temporary, "wx");
      const download = await request(url, fetcher, signal);
      if (!download.ok || !download.body) throw new Error(`APK download failed (HTTP ${download.status}).`);
      const declared = Number(download.headers.get("content-length")); if (declared > maxBytes) { await download.body.cancel(); throw new Error("APK exceeds the download limit."); }
      const md5 = createHash("md5"), sha256 = createHash("sha256"); state.totalBytes = expectedBytes; state.message = "Downloading APK…"; let lastUpdate = 0;
      for await (const chunk of download.body as any) {
        state.bytes += chunk.length; if (state.bytes > maxBytes || state.bytes > expectedBytes) throw new Error("APK exceeded the expected download size.");
        await handle.writeFile(chunk); md5.update(chunk); sha256.update(chunk);
        if (Date.now() - lastUpdate >= 500) { lastUpdate = Date.now(); await progress({ ...state }); }
      }
      await handle.close(); handle = undefined;
      if (state.bytes !== expectedBytes || md5.digest("hex") !== expectedMd5.toLowerCase()) throw new Error("APK download failed its size/checksum verification.");
      state.message = "Checking APK structure and package identity…"; await progress({ ...state });
      if (options.verify) await options.verify(temporary, packageId);
      else {
        await checkApk(temporary, `${temporary}.check.json`);
        const { stdout } = await exec(options.aapt, ["dump", "badging", temporary], { timeout: 30000, maxBuffer: 1024 * 1024 });
        if (stdout.match(/package: name='([^']+)'/)?.[1] !== packageId) throw new Error("Downloaded APK manifest does not match the selected app.");
      }
      await write(`${destination}.provenance.json`, { packageId, provider: "Aptoide", metadataUrl, url, version: meta.file.vername, bytes: state.bytes, sha256: sha256.digest("hex"), sourceMd5: expectedMd5, downloadedAt: new Date().toISOString(), limitations: ["Third-party mirror, not a Google Play download. Provider checksum and package identity checked; publisher signing identity is not independently established. Static analysis only."] });
      await fs.rename(temporary, destination); await progress({ ...state, status: "completed", message: "APK downloaded and verified." }); return destination;
    } catch (error) {
      const message = signal.aborted ? "APK download timed out. Retry downloading this reference." : (error as Error).message;
      await progress({ ...state, status: "failed", message }); throw new Error(message);
    } finally { await handle?.close(); await fs.rm(temporary, { force: true }); await fs.rm(`${temporary}.check.json`, { force: true }); }
  };
}
