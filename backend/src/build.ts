import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { z, write, fileSha, exists, json, WorkbenchError, checkApk } from "../../pipeline/dist/src/integration.js";
import { modelJson } from "./model";
import { sha } from "../../pipeline/dist/src/storage.js";
import { generateSources, SourceFiles, recoverCompletedBatch, recoverRepairPrefix } from "./codegen";
import type { BuildRunner } from "./projects";

export type AndroidEnvironment = { sdk: string; javaHome: string; templateDirectory: string; nativeSmoke?: { projectId: string; script: string; adb: string; serial: string; output: string } };
const Files = SourceFiles;
const isHarnessFailure = (message: string) => /\n(?:TypeError|FileNotFoundError|ModuleNotFoundError|subprocess\.CalledProcessError):/.test(message) || message.startsWith("Native harness");
const Review = z.object({ passed: z.boolean(), issues: z.array(z.string().max(1200)).max(20), acceptanceTests: z.array(z.string().max(1200)).min(1).max(30) }).strict();
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
async function gradle(source: string, environment: AndroidEnvironment, log: string) {
  const env = { ...process.env, JAVA_HOME: environment.javaHome, ANDROID_HOME: environment.sdk, ANDROID_SDK_ROOT: environment.sdk };
  for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN/.test(key)) delete env[key as keyof typeof env];
  return new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["./gradlew", "--no-daemon", "--console=plain", ":app:assembleDebug", ":app:testDebugUnitTest", ":app:lintDebug"], { cwd: source, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timedOut = false;
    const stop = () => child.kill("SIGTERM"); process.once("SIGTERM", stop); process.once("SIGINT", stop);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 1200000);
    const collect = (chunk: Buffer) => { if (output.length < 2000000) output += chunk.toString(); else child.kill("SIGKILL"); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const cleanup = () => { clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); void write(log, output).then(() => code === 0 && !timedOut ? resolve() : reject(new Error(`Android build checks failed (${timedOut ? "timeout" : code}). ${output.slice(-10000)}`))); });
  });
}
async function nativeCheck(config: NonNullable<AndroidEnvironment["nativeSmoke"]>, apk: string, packageId: string, directory: string, round: number) {
  const output = path.join(config.output, path.basename(directory), `round-${round}`);
  await fs.mkdir(output, { recursive: true });
  const env = { ...process.env, MELD_ANDROID_ADB: config.adb, MELD_ANDROID_SERIAL: config.serial, MELD_NATIVE_QA_OUTPUT: output };
  for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN/.test(key)) delete env[key as keyof typeof env];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", ["-u", config.script, apk, packageId], { env, stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 900000);
    const stop = () => child.kill("SIGTERM"); process.once("SIGTERM", stop); process.once("SIGINT", stop);
    const collect = (chunk: Buffer) => { if (text.length < 200000) text += chunk.toString(); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const cleanup = () => { clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); void write(path.join(directory, `native-smoke-${round}.log`), text).then(() => code === 0 ? resolve() : reject(isHarnessFailure(text) ? new WorkbenchError("native_harness", `Native harness failed. ${text.slice(-10000)}`, 500) : new Error(`Actual Android UI checks failed (${code}). ${text.slice(-10000)}`))); });
  });
  const report = z.object({ passed: z.literal(true), apkSha256: z.string().regex(/^[a-f\d]{64}$/), packageId: z.string(), device: z.object({ serial: z.string(), api: z.string(), abi: z.string(), display: z.string() }), cases: z.array(z.object({ case: z.string().min(1), passed: z.literal(true) })).min(6), scope: z.string().min(1) }).parse(await json(path.join(output, "runtime-report.json")));
  if (report.passed !== true || report.apkSha256 !== await fileSha(apk) || report.packageId !== packageId) throw new WorkbenchError("native_harness", "Native harness report does not verify this APK and package.", 500);
  await write(path.join(directory, `runtime-report-${round}.json`), report);
  return report;
}
export function androidBuildRunner(environment: AndroidEnvironment): BuildRunner {
  return async input => {
    if (!(await exists(path.join(environment.sdk, "platforms/android-35/android.jar"))) || !(await exists(path.join(environment.javaHome, "bin/java")))) throw new WorkbenchError("build_environment", "Configure Android SDK 35 and JDK 17+ on the backend before building.", 503);
    const source = path.join(input.directory, "source"), model = path.join(input.directory, "model"), packageId = `com.meld.apps.p${input.project.id.replace(/[^a-f0-9]/g, "").slice(-24)}`;
    await fs.mkdir(source, { recursive: true }); await fs.cp(environment.templateDirectory, source, { recursive: true });
    await write(path.join(source, "settings.gradle.kts"), `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = "GeneratedApp"\ninclude(":app")\n`);
    await write(path.join(source, "build.gradle.kts"), 'plugins { id("com.android.application") version "8.10.1" apply false; id("org.jetbrains.kotlin.android") version "2.1.20" apply false; id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false; id("com.google.devtools.ksp") version "2.1.20-2.0.1" apply false }\n');
    await write(path.join(source, "gradle.properties"), "org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nkotlin.code.style=official\norg.gradle.workers.max=4\n");
    await write(path.join(source, "local.properties"), `sdk.dir=${environment.sdk.replace(/\\/g, "/")}\n`);
    await write(path.join(source, "app/build.gradle.kts"), `plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose"); id("com.google.devtools.ksp") }\nandroid { namespace = "generated"; compileSdk = 35; defaultConfig { applicationId = "${packageId}"; minSdk = 26; targetSdk = 35; versionCode = ${Math.max(1, Number(input.revision.match(/^v(\d+)/)?.[1]) || 1)}; versionName = "1.${Math.max(1, Number(input.revision.match(/^v(\d+)/)?.[1]) || 1)}" }; buildFeatures { compose = true }; compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }; kotlinOptions { jvmTarget = "17" }; packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }; lint { abortOnError = true } }\nksp { arg("room.schemaLocation", "$projectDir/schemas") }\ndependencies { implementation(platform("androidx.compose:compose-bom:2025.05.01")); implementation("androidx.activity:activity-compose:1.10.1"); implementation("androidx.compose.material3:material3"); implementation("androidx.compose.material:material-icons-extended"); implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0"); implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0"); implementation("androidx.room:room-runtime:2.7.1"); implementation("androidx.room:room-ktx:2.7.1"); ksp("androidx.room:room-compiler:2.7.1"); implementation("androidx.core:core-ktx:1.16.0"); implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2"); testImplementation("junit:junit:4.13.2"); testImplementation("org.json:json:20240303"); testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2") }\n`);
    const design = input.design as { developer_design: { title: string } };
    await write(path.join(source, "app/src/main/AndroidManifest.xml"), `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/><application android:label="${xml(input.project.brief.name || design.developer_design.title)}" android:allowBackup="false" android:supportsRtl="true" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name="generated.MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity><provider android:name="androidx.core.content.FileProvider" android:authorities="${packageId}.files" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/meld_file_paths"/></provider></application></manifest>`);
    await write(path.join(source, "approved-design.json"), input.design);
    const instructions = "Implement the approved detailed design as a complete offline Android Kotlin/Jetpack Compose application. Generate actual feature logic, durable local persistence, navigation, all required screen states, save/delete behavior, accessibility and specified colors. Do not substitute a generic feature template or omit features. Namespace/package is generated. Use appProfile.name as the user-facing app name; the developer document title may contain specification wording and is not UI copy. Provide generated.MainActivity and meaningful JUnit tests of pure app logic (state transitions/serialization/rules), not UI instrumentation. Gradle/manifest are supplied and may not be changed. The supplied manifest includes a FileProvider at authority applicationId + .files, exposing only cacheDir/shared_images/. Encode temporary shared JPEGs there, grant read access using ClipData and FLAG_GRANT_READ_URI_PERMISSION, and clean them after 24 hours. The manifest also declares WRITE_EXTERNAL_STORAGE only through API 28; request it at runtime before legacy saving on API 26–28, handle denial without losing edits, and use MediaStore pending publication on API 29+. Never substitute an always-throwing platform gateway. Available dependencies: Compose Material3, material-icons-extended, lifecycle 2.9.0, Room 2.7.1, JUnit4. Use stable Material3 APIs or explicit OptIn annotations. Test code must not require Android runtime. Return only .kt files under app/src/main/java/generated/ or app/src/test/java/generated/. Do not perform network or host-process operations. Implement the exact approved design and its domain rules, including game mechanics, save/resume, and restart behavior when specified. Do not impose notes-only features on games. If approvedDesign.brief.market_signals.foundation is present, retain that base app’s primary function and core loop. Integrate approved enhancements into that experience; do not add unrelated standalone game modes or copy reference branding.";
    const delivered = input.project.lastDeliveredBuild || (input.project.latestBuild?.status === "succeeded" ? input.project.latestBuild : undefined);
    const integration = { gradle: await fs.readFile(path.join(source, "app/build.gradle.kts"), "utf8"), plugins: await fs.readFile(path.join(source, "build.gradle.kts"), "utf8"), manifest: await fs.readFile(path.join(source, "app/src/main/AndroidManifest.xml"), "utf8"), fileProviderPaths: await fs.readFile(path.join(source, "app/src/main/res/xml/meld_file_paths.xml"), "utf8"), initialBuild: !delivered, instruction: "This is an initial app schema unless previous implementation is supplied. Do not invent legacy migrations for nonexistent schema versions; preserve versioned migration infrastructure. Compiler and lint checks independently validate integration." };
    let prior: unknown = null, issues: string[] = [];
    const previous = input.project.latestBuild;
    if (previous?.status === "failed" && previous.revision === input.revision && previous.designHash === input.designHash) {
      let previousId: string | undefined = previous.id;
      for (let depth = 0; previousId && depth < 5; depth++) {
        if (!/^job-[a-f\d-]{36}$/.test(previousId)) break;
        const previousDirectory = path.join(path.dirname(input.directory), previousId);
        const savedInput = path.join(previousDirectory, "input.json");
        if (!(await exists(savedInput))) break;
        const saved = JSON.parse(await fs.readFile(savedInput, "utf8"));
        if (saved.revision !== input.revision || saved.designHash !== input.designHash) break;
        const failure = path.join(previousDirectory, "failure.json"), modelDirectory = path.join(previousDirectory, "model");
        const savedRounds = await exists(modelDirectory) ? (await fs.readdir(modelDirectory)).filter(name => /^implementation-\d+\.json$/.test(name)).map(name => Number(name.match(/\d+/)![0])) : [];
        const repair = await exists(modelDirectory) ? await recoverRepairPrefix(modelDirectory, integration) : null;
        if (repair && repair.round > Math.max(-1, ...savedRounds) && sha(JSON.stringify(repair.approvedDesign)) === sha(JSON.stringify(input.design)) && sha(JSON.stringify(repair.appProfile)) === sha(JSON.stringify(input.project.brief))) {
          prior = repair.prior; issues = repair.issues;
          await write(path.join(model, "repair-checkpoint-0.json"), { plan: repair.plan, files: repair.files });
          await write(path.join(input.directory, "recovered-prefix.json"), { previousBuildId: previousId, planResponse: repair.planResponse, planSha256: repair.planSha256, calls: repair.calls, recoveredFiles: repair.files.length, plannedFiles: repair.plan.files.length, recoveryOutputLimit: repair.recoveryOutputLimit });
          await write(path.join(input.directory, "retry-source.json"), { previousBuildId: previousId, revision: input.revision, designHash: input.designHash });
          break;
        }
        const checkpoint = path.join(modelDirectory, "generation-checkpoint.json");
        if (!(await exists(failure)) && await exists(checkpoint)) {
          await write(path.join(model, "generation-checkpoint.json"), JSON.parse(await fs.readFile(checkpoint, "utf8")));
          await write(path.join(input.directory, "retry-source.json"), { previousBuildId: previousId, revision: input.revision, designHash: input.designHash });
          break;
        }
        if (await exists(failure) && await exists(modelDirectory)) {
          const combined = (await fs.readdir(modelDirectory)).filter(name => /^implementation-\d+\.json$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
          if (combined.length) {
            prior = Files.parse(JSON.parse(await fs.readFile(path.join(modelDirectory, combined[0]), "utf8")));
            issues = z.array(z.string()).parse(JSON.parse(await fs.readFile(failure, "utf8")).issues);
            const recovered = await recoverCompletedBatch(modelDirectory, prior as any);
            if (recovered) {
              prior = recovered.sources;
              issues.unshift("A completed legacy batch repair was recovered after explicit validation under a 24k post-response budget. The original findings below describe the previous implementation; inspect the supplied latest files and repair only findings that remain. Do not undo its completed fixes.");
              await write(path.join(input.directory, "recovered-repair.json"), { previousBuildId: previousId, responseFile: recovered.responseFile, responseSha256: recovered.responseSha256, outputTokens: recovered.outputTokens, recoveryOutputLimit: recovered.recoveryOutputLimit });
            }
            await write(path.join(input.directory, "retry-source.json"), { previousBuildId: previousId, revision: input.revision, designHash: input.designHash });
            break;
          }
          const attempts = (await fs.readdir(modelDirectory)).filter(name => /^implement-\d+-\d+$/.test(name)).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
          for (const attempt of attempts) {
            const parsed = path.join(modelDirectory, attempt, "parsed.json");
            if (!(await exists(parsed))) continue;
            prior = Files.parse(JSON.parse(await fs.readFile(parsed, "utf8")));
            issues = z.array(z.string()).parse(JSON.parse(await fs.readFile(failure, "utf8")).issues);
            await write(path.join(input.directory, "retry-source.json"), { previousBuildId: previousId, revision: input.revision, designHash: input.designHash });
            break;
          }
          if (prior) break;
        }
        const retrySource = path.join(previousDirectory, "retry-source.json");
        previousId = await exists(retrySource) ? JSON.parse(await fs.readFile(retrySource, "utf8")).previousBuildId : undefined;
      }
    }
    if (!prior && delivered && /^job-[a-f\d-]{36}$/.test(delivered.id)) {
      const previousDirectory = path.join(path.dirname(input.directory), delivered.id), modelDirectory = path.join(previousDirectory, "model");
      const combined = (await fs.readdir(modelDirectory)).filter(name => /^implementation-\d+\.json$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
      const attempts = (await fs.readdir(modelDirectory)).filter(name => /^implement-\d+-\d+$/.test(name)).sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
      if (!attempts.length && !combined.length) throw new WorkbenchError("previous_source_missing", "The previously delivered app source is unavailable. Restore its source before updating this app.", 409);
      prior = Files.parse(JSON.parse(await fs.readFile(combined.length ? path.join(modelDirectory, combined[0]) : path.join(modelDirectory, attempts[0], "parsed.json"), "utf8")));
      issues = ["Update the previously delivered app supplied in prior. Preserve its database name, existing records and IDs. Any schema change requires an explicit version increase and lossless Room migration from the previous schema. Retain all unchanged behavior while implementing this approved revision."];
      await write(path.join(input.directory, "update-source.json"), { previousBuildId: delivered.id, previousRevision: delivered.revision, previousDesignHash: delivered.designHash });
    }
    const feedbackId = input.project.latestBuild?.id || delivered?.id;
    if (prior && feedbackId && /^job-[a-f\d-]{36}$/.test(feedbackId)) {
      const feedback = path.join(path.dirname(input.directory), feedbackId, "runtime-findings.json");
      if (await exists(feedback)) {
        const findings = z.object({ apkSha256: z.string().regex(/^[a-f\d]{64}$/), issues: z.array(z.string().max(3000)).min(1).max(20) }).strict().parse(await json(feedback));
        issues.push(...findings.issues);
        await write(path.join(input.directory, "runtime-feedback-source.json"), { previousBuildId: feedbackId, ...findings });
      }
    }
    const rebuildOnly = Boolean(prior && issues.length && issues.every(isHarnessFailure));
    if (rebuildOnly) await write(path.join(input.directory, "harness-retry.json"), { previousBuildId: input.project.latestBuild?.id, reason: "Rebuild the unchanged accepted source after a native harness error; do not repair application code for test-script exceptions." });
    let runtimeReport: any = null;
    for (let round = 0; round < 5; round++) {
      await input.progress(round ? "Correcting app implementation checks…" : "Implementing your approved app design…");
      const output = round === 0 && rebuildOnly ? Files.parse(prior) : await generateSources(model, round, instructions, { appProfile: input.project.brief, approvedDesign: input.design, integration, packageId }, prior as any, issues, input.progress);
      if (round === 0 && rebuildOnly) await write(path.join(model, "implementation-0.json"), output);
      if (new Set(output.files.map(f => f.path)).size !== output.files.length || !output.files.some(f => f.path === "app/src/main/java/generated/MainActivity.kt") || !output.files.some(f => f.path.startsWith("app/src/test/java/generated/"))) throw new WorkbenchError("invalid_code", "Generated app files are incomplete.", 422);
      const mainFile = output.files.find(f => f.path === "app/src/main/java/generated/MainActivity.kt")!;
      if (!/\bpackage\s+generated\b/.test(mainFile.content) || !/\bclass\s+MainActivity\b/.test(mainFile.content)) throw new WorkbenchError("invalid_code", "The generated launcher class does not match the app manifest.", 422);
      for (const file of output.files) {
        if (!/^app\/src\/(main|test)\/java\/generated\/[A-Za-z0-9_/-]+\.kt$/.test(file.path) || file.path.includes("..") || /ProcessBuilder|Runtime\.getRuntime|java\.net\.|System\.exit/.test(file.content)) throw new WorkbenchError("invalid_code", "Generated files fall outside the Android app implementation contract.", 422);
      }
      await fs.rm(path.join(source, "app/src/main/java"), { recursive: true, force: true }); await fs.rm(path.join(source, "app/src/test/java"), { recursive: true, force: true });
      for (const file of output.files) await write(path.join(source, file.path), file.content);
      await input.progress("Building the APK and running tests…");
      try { await gradle(source, environment, path.join(input.directory, `gradle-${round}.log`)); }
      catch (error) { prior = output; issues = [(error as Error).message]; await write(path.join(input.directory, "failure.json"), { issues }); continue; }
      runtimeReport = null;
      if (environment.nativeSmoke?.projectId === input.project.id) {
        await input.progress("Testing your app on Android…");
        try { runtimeReport = await nativeCheck(environment.nativeSmoke, path.join(source, "app/build/outputs/apk/debug/app-debug.apk"), packageId, input.directory, round); }
        catch (error) { prior = output; issues = [(error as Error).message]; await write(path.join(input.directory, "failure.json"), { issues }); if (error instanceof WorkbenchError && error.code === "native_harness") throw error; continue; }
      }
      await input.progress("Checking the implementation against your design…");
      const review = await modelJson(model, `review-${round}`, "Independently review every required feature, screen, persistence rule, design choice, color and acceptance criterion against the supplied Kotlin files. Identify missing behavior or compile/API concerns. Pass only a complete implementation. This is code review, not runtime verification.", { appProfile: input.project.brief, approvedDesign: input.design, integration, files: output.files }, Review, 24000, "high", 1200000);
      await write(path.join(input.directory, `review-${round}.json`), review);
      if (!review.passed) { prior = output; issues = review.issues; await write(path.join(input.directory, "failure.json"), { issues }); continue; }
      const reportDir = path.join(source, "app/build/test-results/testDebugUnitTest");
      let testsRun = 0, failedTests = 0;
      for (const name of await fs.readdir(reportDir).catch(() => [] as string[])) if (name.endsWith(".xml")) {
        const report = await fs.readFile(path.join(reportDir, name), "utf8");
        const suite = report.match(/<testsuite\b[^>]*>/)?.[0] || "";
        testsRun += Number(suite.match(/\btests="(\d+)"/)?.[1] || 0);
        failedTests += Number(suite.match(/\bfailures="(\d+)"/)?.[1] || 0) + Number(suite.match(/\berrors="(\d+)"/)?.[1] || 0);
      }
      if (!testsRun || failedTests) { prior = output; issues = ["Provide meaningful JUnit tests that actually execute and pass; no tests or failed tests were reported."]; continue; }
      const apk = path.join(source, "app/build/outputs/apk/debug/app-debug.apk");
      await checkApk(apk, path.join(input.directory, "apk-check.json"));
      const artifacts = path.join(input.directory, "artifacts"); await fs.mkdir(artifacts, { recursive: true });
      await fs.copyFile(apk, path.join(artifacts, "app.apk")); await write(path.join(artifacts, "approved-design.json"), input.design);
      await write(path.join(artifacts, "build-report.json"), { projectId: input.project.id, revision: input.revision, designHash: input.designHash, packageId, review, build: true, unitTests: true, lint: true, runtimeVerified: Boolean(runtimeReport) });
      if (runtimeReport) await write(path.join(artifacts, "runtime-report.json"), runtimeReport);
      const metadata = await Promise.all(["app.apk", "approved-design.json", "build-report.json", ...(runtimeReport ? ["runtime-report.json"] : [])].map(async name => ({ name, url: `/api/projects/${input.project.id}/builds/${path.basename(input.directory)}/artifacts/${name}`, sha256: await fileSha(path.join(artifacts, name)) })));
      await write(path.join(input.directory, "artifacts.json"), metadata);
      return { artifacts: metadata, validation: { build: true, unitTests: true, lint: true, runtimeVerified: Boolean(runtimeReport), limitations: runtimeReport ? ["Native smoke interactions passed on the recorded Android emulator. Other devices and all failure paths are not covered."] : ["Static implementation review and Gradle checks passed. Device/emulator interaction has not been verified by this build worker."] } };
    }
    await write(path.join(input.directory, "failure.json"), { issues });
    throw new WorkbenchError("build_failed", "The app did not pass implementation or build checks after four repairs. Your approved design is preserved; retry the build.", 422);
  };
}
