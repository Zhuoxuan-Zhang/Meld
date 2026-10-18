import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { z, write, fileSha, exists, json, WorkbenchError, checkApk } from "../../pipeline/dist/src/integration.js";
import { buildModelJson as modelJson } from "./model";
import { sha } from "../../pipeline/dist/src/storage.js";
import { generateSources, SourceFiles, recoverCompletedBatch, recoverRepairPrefix, removeSourceFiles } from "./codegen";
import type { BuildRunner } from "./projects";
import { uiValidationEntry, uiReferenceContext, validateBuiltUi, uiObservationPreflight } from "./ui-validation";
import type { Project } from "../../shared/contracts";

export function hasForbiddenSourceOperation(source: string): boolean {
  let inspected = source;
  // A Runtime instance may be used solely for heap statistics. Require a plain
  // immutable assignment and account for every reference before accepting it.
  const declarations = [...source.matchAll(/\bval[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*(?:java\.lang\.)?Runtime\s*\.\s*getRuntime\s*\(\s*\)[ \t]*(?=;|\r?\n|$)/g)];
  for (const declaration of declarations) {
    const name = declaration[1];
    const candidate = inspected.replace(declaration[0], '').replace(new RegExp(`\\b${name}\\s*\\.\\s*(?:maxMemory|totalMemory|freeMemory)\\s*\\(\\s*\\)`, 'g'), '0L');
    if (!new RegExp(`\\b${name}\\b`).test(candidate)) inspected = candidate;
  }
  inspected = inspected.replace(/\b(?:java\.lang\.)?Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*(?:maxMemory|totalMemory|freeMemory)\s*\(\s*\)/g, '0L');
  return /ProcessBuilder|Runtime\s*\.\s*getRuntime|java\.net\.|System\s*\.\s*exit/.test(inspected);
}

export type AndroidEnvironment = { sdk: string; javaHome: string; templateDirectory: string; uiValidationConfig?: string; nativeSmoke?: { projectId: string; script: string; adb: string; serial: string; output: string } };
const Files = SourceFiles;
const productRequirements = " When approvedOutline is supplied, it is the user's authoritative product scope. Preserve every explicit operation in its feature steps, even if the detailed design compresses it into a word such as manage. Adding, editing, checking and deleting are separate operations. A missing requested operation is blocking. Trace each required control through the actual navigation host, state owner and persistence layer; no-op callback defaults do not implement a feature. When a shared signature changes, update every caller and entry-point connection. Ensure a new workflow can start without accidentally editing the previous completed record. Use one vertical scrolling owner or explicitly bound nested scrolling containers; never put an unbounded LazyColumn inside a verticalScroll Column. Every saved list row must remain reachable through scrolling. If a lazy list is replaced by a plain Column, remove stale height caps that truncate its rows. Keep form fields and Save/Cancel controls reachable with the keyboard open and in landscape. For modal forms, apply keyboard avoidance at the dialog or editor root, not only the AlertDialog text slot while its title and buttons remain under the keyboard. When height is short, the entire form including heading and actions must remain reachable through scrolling or a compact full-screen editor; do not reserve a fixed heading/footer that leaves zero height for input. Programmatic focus must target an attached control in its actual dialog composition; do not request focus from an outer effect before dialog content mounts. Optional autofocus must never crash or clear input during rotation. ";
export function approvedOutlineForBuild(project: Pick<Project, "highLevelDesign">, revision: string) {
  const outline = project.highLevelDesign;
  if (!outline || outline.approvedRevision !== outline.revision || outline.developerRevision !== revision) return null;
  return { revision: outline.revision, document: outline.document };
}
const runtimeAcceptanceRequirements = "Primary visual features must be visibly implemented with suitable local Canvas/vector/icon artwork, not empty colored shapes or labels standing in for the promised object. Preserve terminal success/failure results long enough for the user to see them and start the next action. For timed workflows, distinguish activity recreation/rotation, internal navigation, screen sleep/lock, and deliberately leaving the app. Do not treat every onStop as abandonment. Use current device state rather than a stale lock flag, preserve durable timestamps, and reconcile elapsed time on return. Keep one active timer and use atomic, idempotent result persistence. Apply Scaffold/system/IME insets to the actual content; keep essential actions reachable on a small screen and in landscape. Account for keyboard space once across the Activity window policy, Scaffold and screen modifiers. Consume applied padding/insets consistently: ordinary Modifier.padding(innerPadding) does NOT consume Scaffold insets. When following it with imePadding(), use consumeWindowInsets(innerPadding) after padding(innerPadding), so the keyboard and bottom navigation padding are not added twice. Check that landscape with the keyboard open still has a nonzero, usable scroll viewport. Keep the focused field visible in the actual scroll viewport after the keyboard opens; a tiny viewport above a large empty gap is a blocking layout defect. Add meaningful tests for the relevant transitions. Tests must import and exercise production domain logic, using injected platform ports where needed. Disk-backed pixel ports and test adapters must transfer bounded rows or tiles in bulk; never perform a file read/write syscall per pixel. Keep high-resolution memory tests and correctness assertions while using efficient bounded test storage. Reimplementing an exporter or coordinator in test-only stand-in classes does not test the app and must be replaced. A concurrency regression test must deterministically overlap the contested operations at their read/write boundary; async calls with non-suspending fakes on one dispatcher only test sequential behavior. Where practical, verify the regression test distinguishes the old unsafe behavior from the fix. Static tests do not establish device behavior.";
const isHarnessFailure = (message: string) => /\n(?:TypeError|FileNotFoundError|ModuleNotFoundError|HarnessSelectorError|subprocess\.CalledProcessError):/.test(message) || message.startsWith("Native harness") || message.startsWith("Actual Android UI checks failed (null).");
export function implementationReviewPassed(review: { passed: boolean; issues: string[] }) {
  return review.passed && !review.issues.some(issue => /^\[blocking\]/i.test(issue));
}
export async function readRuntimeFeedback(root: string, startingId: string | undefined, expected: { projectId: string; revision: string; designHash: string }) {
  const seen = new Set<string>();
  let id = startingId;
  for (let depth = 0; id && depth < 8 && !seen.has(id); depth++) {
    if (!/^job-[a-f\d-]{36}$/.test(id)) break;
    seen.add(id);
    const directory = path.join(root, id), inputFile = path.join(directory, "input.json");
    if (!(await exists(inputFile))) break;
    const saved = await json(inputFile);
    if (saved.projectId !== expected.projectId || saved.revision !== expected.revision || saved.designHash !== expected.designHash) break;
    const feedback = path.join(directory, "runtime-findings.json");
    if (await exists(feedback)) {
      const findings = z.object({ apkSha256: z.string().regex(/^[a-f\d]{64}$/), issues: z.array(z.string().max(3000)).min(1).max(20) }).strict().parse(await json(feedback));
      const deliveredApk = path.join(directory, "artifacts/app.apk");
      const apk = await exists(deliveredApk) ? deliveredApk : path.join(directory, "source/app/build/outputs/apk/debug/app-debug.apk");
      if (!(await exists(apk)) || await fileSha(apk) !== findings.apkSha256) throw new WorkbenchError("stale_runtime_feedback", "Runtime findings do not match the tested APK. Test the current build before retrying.", 409);
      return { previousBuildId: id, ...findings };
    }
    // A successful delivery already incorporated its parent's findings. Only
    // unfinished retries need to follow their source back to the tested APK.
    if (await exists(path.join(directory, "artifacts.json"))) break;
    const retry = path.join(directory, "retry-source.json"), update = path.join(directory, "update-source.json");
    id = await exists(retry) ? (await json(retry)).previousBuildId : await exists(update) ? (await json(update)).previousBuildId : undefined;
  }
  return null;
}
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
    child.once("close", (code, signal) => { cleanup(); void write(path.join(directory, `native-smoke-${round}.log`), text).then(() => code === 0 ? resolve() : reject(code === null || isHarnessFailure(text) ? new WorkbenchError("native_harness", `Native harness ${signal ? `interrupted by ${signal}` : "failed"}. ${text.slice(-10000)}`, 500) : new Error(`Actual Android UI checks failed (${code}). ${text.slice(-10000)}`))); });
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
    const uiEntry = await uiValidationEntry(environment.uiValidationConfig, input.project.id, input.project.featurePreferences?.baseAppId);
    if (uiEntry) await uiObservationPreflight();
    const visualReference = uiEntry ? await uiReferenceContext(uiEntry) : null;
    let uiReport: Awaited<ReturnType<typeof validateBuiltUi>> | null = null;
    await fs.mkdir(source, { recursive: true }); await fs.cp(environment.templateDirectory, source, { recursive: true });
    await write(path.join(source, "settings.gradle.kts"), `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = "GeneratedApp"\ninclude(":app")\n`);
    await write(path.join(source, "build.gradle.kts"), 'plugins { id("com.android.application") version "8.10.1" apply false; id("org.jetbrains.kotlin.android") version "2.1.20" apply false; id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false; id("com.google.devtools.ksp") version "2.1.20-2.0.1" apply false }\n');
    await write(path.join(source, "gradle.properties"), "org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nkotlin.code.style=official\norg.gradle.workers.max=4\n");
    await write(path.join(source, "local.properties"), `sdk.dir=${environment.sdk.replace(/\\/g, "/")}\n`);
    await write(path.join(source, "app/build.gradle.kts"), `plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose"); id("com.google.devtools.ksp") }\nandroid { namespace = "generated"; compileSdk = 35; defaultConfig { applicationId = "${packageId}"; minSdk = 26; targetSdk = 35; versionCode = ${Math.max(1, Number(input.revision.match(/^v(\d+)/)?.[1]) || 1)}; versionName = "1.${Math.max(1, Number(input.revision.match(/^v(\d+)/)?.[1]) || 1)}" }; buildFeatures { compose = true }; compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }; kotlinOptions { jvmTarget = "17" }; packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }; lint { abortOnError = true } }\nksp { arg("room.schemaLocation", "$projectDir/schemas") }\ndependencies { implementation(platform("androidx.compose:compose-bom:2025.05.01")); implementation("androidx.activity:activity-compose:1.10.1"); implementation("androidx.compose.material3:material3"); implementation("androidx.compose.material:material-icons-extended"); implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0"); implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0"); implementation("androidx.room:room-runtime:2.7.1"); implementation("androidx.room:room-ktx:2.7.1"); ksp("androidx.room:room-compiler:2.7.1"); implementation("androidx.core:core-ktx:1.16.0"); implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2"); testImplementation("junit:junit:4.13.2"); testImplementation("org.json:json:20240303"); testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2") }\n`);
    const design = input.design as { developer_design: { title: string } };
    const mediaWorkload = /photo|image|camera|bitmap|video/i.test(JSON.stringify(input.project.brief));
    await write(path.join(source, "app/src/main/AndroidManifest.xml"), `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/><application android:label="${xml(input.project.brief.name || design.developer_design.title)}" android:allowBackup="false" android:largeHeap="${mediaWorkload ? "true" : "false"}" android:supportsRtl="true" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name="generated.MainActivity" android:exported="true" android:windowSoftInputMode="adjustResize"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity><provider android:name="androidx.core.content.FileProvider" android:authorities="${packageId}.files" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/meld_file_paths"/></provider></application></manifest>`);
    await write(path.join(source, "approved-design.json"), input.design);
    const instructions = "Implement the approved detailed design as a complete offline Android Kotlin/Jetpack Compose application. Generate actual feature logic, durable local persistence, navigation, only the required screen states and task behavior, accessibility and specified colors. Do not substitute a generic feature template, omit requested features, or add excluded features. Namespace/package is generated. Use appProfile.name as the user-facing app name; the developer document title may contain specification wording and is not UI copy. Provide generated.MainActivity and meaningful JUnit tests of pure app logic (state transitions/serialization/rules), not UI instrumentation. Gradle/manifest are supplied and may not be changed. The supplied launcher manifest uses windowSoftInputMode=adjustResize. Use Compose-managed edge-to-edge insets consistently, consume Scaffold padding before applying IME padding, and do not set adjustPan in generated code. The supplied manifest includes a FileProvider at authority applicationId + .files, exposing only cacheDir/shared_images/. Encode temporary shared JPEGs there, grant read access using ClipData and FLAG_GRANT_READ_URI_PERMISSION, and clean them after 24 hours. The manifest also declares WRITE_EXTERNAL_STORAGE only through API 28; request it at runtime before legacy saving on API 26–28, handle denial without losing edits, and use MediaStore pending publication on API 29+. Never substitute an always-throwing platform gateway. Available dependencies: Compose Material3, material-icons-extended, lifecycle 2.9.0, Room 2.7.1, JUnit4. Use stable Material3 APIs or explicit OptIn annotations. Test code must not require Android runtime. Return only .kt files under app/src/main/java/generated/ or app/src/test/java/generated/. Do not perform network or host-process operations. Implement the exact approved design and its domain rules, including save/resume and restart behavior when specified. Keep system bar icons readable against the actual screen background. If approvedDesign.brief.market_signals.foundation is present, retain that base app’s primary function and core loop. Integrate approved enhancements into that experience; do not add unrelated standalone game modes or copy reference branding.";
    const delivered = input.project.lastDeliveredBuild || (input.project.latestBuild?.status === "succeeded" ? input.project.latestBuild : undefined);
    const integration = { gradle: await fs.readFile(path.join(source, "app/build.gradle.kts"), "utf8"), plugins: await fs.readFile(path.join(source, "build.gradle.kts"), "utf8"), manifest: await fs.readFile(path.join(source, "app/src/main/AndroidManifest.xml"), "utf8"), fileProviderPaths: await fs.readFile(path.join(source, "app/src/main/res/xml/meld_file_paths.xml"), "utf8"), initialBuild: !delivered, instruction: "This is an initial app schema unless previous implementation is supplied. Do not invent legacy migrations for nonexistent schema versions; preserve versioned migration infrastructure. Compiler and lint checks independently validate integration." };
    let prior: unknown = null, issues: string[] = [], checkedSource = false;
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
        if (repair && !(repair.issues.length && repair.issues.every(isHarnessFailure)) && repair.round > Math.max(-1, ...savedRounds) && sha(JSON.stringify(repair.approvedDesign)) === sha(JSON.stringify(input.design)) && sha(JSON.stringify(repair.appProfile)) === sha(JSON.stringify(input.project.brief))) {
          prior = repair.prior; issues = repair.issues;
          await write(path.join(model, "repair-checkpoint-0.json"), { plan: repair.plan, files: repair.files });
          await write(path.join(input.directory, "recovered-prefix.json"), { previousBuildId: previousId, planResponse: repair.planResponse, planSha256: repair.planSha256, calls: repair.calls, recoveredFiles: repair.files.length, planRevalidationRequired: "planNeedsRepair" in repair && repair.planNeedsRepair, plannedFiles: repair.plan.files.length, recoveryOutputLimit: repair.recoveryOutputLimit });
          await write(path.join(input.directory, "retry-source.json"), { previousBuildId: previousId, revision: input.revision, designHash: input.designHash });
          break;
        }
        const checkpoint = path.join(modelDirectory, "generation-checkpoint.json");
        if (!(await exists(failure)) && await exists(checkpoint)) {
          await write(path.join(model, "generation-checkpoint.json"), JSON.parse(await fs.readFile(checkpoint, "utf8")));
          await write(path.join(input.directory, "retry-source.json"), { previousBuildId: previousId, revision: input.revision, designHash: input.designHash });
          break;
        }
        if (await exists(modelDirectory)) {
          const combined = (await fs.readdir(modelDirectory)).filter(name => /^implementation-\d+\.json$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
          if (combined.length) {
            prior = Files.parse(JSON.parse(await fs.readFile(path.join(modelDirectory, combined[0]), "utf8")));
            const failureData = await exists(failure) ? await json(failure) : { issues: [] };
            issues = z.array(z.string()).parse(failureData.issues);
            if (!(await exists(failure))) {
              checkedSource = true;
              await write(path.join(input.directory, "generated-source-recovery.json"), { previousBuildId: previousId, sourceSha256: sha(JSON.stringify(Files.parse(prior).files)), reason: "Resume the complete generated snapshot after a source-gate interruption. Source validation, compilation, review and configured runtime gates still run." });
            }
            const savedRound = Number(combined[0].match(/\d+/)![0]);
            const runtimeFindings = ["native", "visual"].includes(failureData.stage) || Boolean(failureData.uiReview) || issues.some(issue => /Actual Android UI checks failed|Native harness|screenshot review/i.test(issue));
            const checkedLog = path.join(previousDirectory, `gradle-${savedRound}.log`);
            if (!runtimeFindings && await exists(checkedLog) && /^BUILD SUCCESSFUL in /m.test(await fs.readFile(checkedLog, "utf8")) && !(await exists(path.join(previousDirectory, `review-${savedRound}.json`)))) {
              const files = Files.parse(prior).files;
              checkedSource = (await Promise.all(files.map(async file => await exists(path.join(previousDirectory, "source", file.path)) && await fs.readFile(path.join(previousDirectory, "source", file.path), "utf8") === file.content))).every(Boolean);
              if (checkedSource) {
                issues = [];
                await write(path.join(input.directory, "checked-source-recovery.json"), { previousBuildId: previousId, sourceSha256: sha(JSON.stringify(files)), gradleLogSha256: await fileSha(checkedLog), reason: "Resume an interrupted model review using the exact successfully compiled sources. Rebuild and review again; old compiler findings are stale." });
              }
            }
            const previousManifest = path.join(previousDirectory, "source/app/src/main/AndroidManifest.xml");
            if (!runtimeFindings && await exists(checkedLog) && /^BUILD SUCCESSFUL in /m.test(await fs.readFile(checkedLog, "utf8")) && await exists(previousManifest) && await fs.readFile(previousManifest, "utf8") !== integration.manifest) {
              checkedSource = true; issues = [];
              await write(path.join(input.directory, "platform-recheck.json"), { previousBuildId: previousId, previousManifestSha256: await fileSha(previousManifest), reason: "Rebuild and review the saved implementation against updated platform configuration before requesting more code changes." });
            }
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
            issues = await exists(failure) ? z.array(z.string()).parse((await json(failure)).issues) : [];
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
      if (delivered.revision === input.revision && delivered.designHash === input.designHash) {
        checkedSource = true; issues = [];
      } else {
        issues = ["Update the previously delivered app supplied in prior. Preserve its database name, existing records and IDs. Any schema change requires an explicit version increase and lossless Room migration from the previous schema. Retain all unchanged behavior while implementing this approved revision."];
      }
      await write(path.join(input.directory, "update-source.json"), { previousBuildId: delivered.id, previousRevision: delivered.revision, previousDesignHash: delivered.designHash });
    }
    const feedbackId = input.project.latestBuild?.id || delivered?.id;
    const feedback = prior ? await readRuntimeFeedback(path.dirname(input.directory), feedbackId, { projectId: input.project.id, revision: input.revision, designHash: input.designHash }) : null;
    if (feedback) {
      const sourceFile = await exists(path.join(input.directory, "retry-source.json")) ? "retry-source.json" : "update-source.json";
      const sourceId = await exists(path.join(input.directory, sourceFile)) ? (await json(path.join(input.directory, sourceFile))).previousBuildId : undefined;
      const receipt = typeof sourceId === "string" && /^job-[a-f\d-]{36}$/.test(sourceId) ? path.join(path.dirname(input.directory), sourceId, "runtime-feedback-source.json") : undefined;
      const replay = Boolean(receipt && await exists(receipt) && sha(JSON.stringify(await json(receipt))) === sha(JSON.stringify(feedback)));
      if (replay) await write(path.join(input.directory, "runtime-feedback-replay.json"), { sourceBuildId: sourceId, feedbackSha256: sha(JSON.stringify(feedback)), reason: "The recovered implementation or repair checkpoint already received this exact APK-bound feedback. Preserve its current findings and pending plan; compile, review and configured runtime gates still run." });
      const newFeedback = !replay && feedback.issues.some(issue => !issues.includes(issue));
      if (!replay) issues = [...new Set([...issues, ...feedback.issues])];
      // A restored partial repair plan predates the device findings. Keep its
      // completed modules, but plan again so the new findings cannot be skipped.
      const checkpoint = path.join(model, "repair-checkpoint-0.json");
      if (newFeedback && await exists(checkpoint)) {
        const restored = await json(checkpoint), merged = new Map(removeSourceFiles(Files.parse(prior).files, z.array(z.string()).parse(restored.plan.removePaths || [])).map(file => [file.path, file]));
        for (const file of z.array(SourceFiles.shape.files.element).parse(restored.files)) merged.set(file.path, file);
        prior = Files.parse({ files: [...merged.values()], explanation: "Preserved completed repair modules before adding device findings." });
        await fs.rm(checkpoint);
      }
      await write(path.join(input.directory, "runtime-feedback-source.json"), feedback);
    }
    const approvedOutline = approvedOutlineForBuild(input.project, input.revision);
    const rebuildOnly = Boolean(prior && (checkedSource && !issues.length || issues.length && issues.every(isHarnessFailure)));
    if (rebuildOnly) await write(path.join(input.directory, "harness-retry.json"), { previousBuildId: input.project.latestBuild?.id, reason: checkedSource && !issues.length ? "Recheck the recovered source for this approved revision and current platform configuration; compilation and review are still required." : "Rebuild the unchanged accepted source after a native harness error; do not repair application code for test-script exceptions." });
    let runtimeReport: any = null;
    for (let round = 0; round < 5; round++) {
      await input.progress(round ? "Correcting app implementation checks…" : "Implementing your approved app design…");
      const output = round === 0 && rebuildOnly ? Files.parse(prior) : await generateSources(model, round, instructions + runtimeAcceptanceRequirements + productRequirements + " Use visualReference.visualBrief and approvedDesign.brief.market_signals.reference_observations when supplied: implement their applicable visual hierarchy, spacing, typography, density and control grouping within the approved appearance. Keep the primary canvas/content prominent. Address screenshot review repair instructions concretely. Unavailable observations do not establish a reference UI. Never replace deliberate app layout with a generic card stack.", { appProfile: input.project.brief, approvedDesign: input.design, approvedOutline, visualReference, integration, packageId }, prior as any, issues, input.progress);
      if (round === 0 && rebuildOnly) await write(path.join(model, "implementation-0.json"), output);
      if (new Set(output.files.map(f => f.path)).size !== output.files.length || !output.files.some(f => f.path === "app/src/main/java/generated/MainActivity.kt") || !output.files.some(f => f.path.startsWith("app/src/test/java/generated/"))) throw new WorkbenchError("invalid_code", "Generated app files are incomplete.", 422);
      const mainFile = output.files.find(f => f.path === "app/src/main/java/generated/MainActivity.kt")!;
      if (!/\bpackage\s+generated\b/.test(mainFile.content) || !/\bclass\s+MainActivity\b/.test(mainFile.content)) throw new WorkbenchError("invalid_code", "The generated launcher class does not match the app manifest.", 422);
      for (const file of output.files) {
        if (!/^app\/src\/(main|test)\/java\/generated\/[A-Za-z0-9_/-]+\.kt$/.test(file.path) || file.path.includes("..") || hasForbiddenSourceOperation(file.content)) throw new WorkbenchError("invalid_code", "Generated files fall outside the Android app implementation contract.", 422);
      }
      await fs.rm(path.join(source, "app/src/main/java"), { recursive: true, force: true }); await fs.rm(path.join(source, "app/src/test/java"), { recursive: true, force: true });
      for (const file of output.files) await write(path.join(source, file.path), file.content);
      await input.progress("Building the APK and running tests…");
      try { await gradle(source, environment, path.join(input.directory, `gradle-${round}.log`)); }
      catch (error) { prior = output; issues = [(error as Error).message]; await write(path.join(input.directory, "failure.json"), { issues, stage: "compile", round }); continue; }
      await input.progress("Checking the implementation against your design…");
      const review = await modelJson(model, `review-${round}`, "Review the Android app against the user-facing approved high-level design and the detailed implementation contract. Prioritize usable primary workflows and combinations of features, data integrity, privacy and actual crashes. A missing or broken primary feature is blocking. Distinguish reproducible ordinary-use defects from visual polish, rare boundary cases, optional refinements and platform guarantees outside app control. Record the latter as explicit follow-ups, not release blockers for this MVP. Prefix each issue [blocking] or [follow-up]. passed=true requires every approved primary feature to be implemented and no blocking issue; follow-ups may remain and must be recorded. Do not raise speculative compiler errors when the supplied exact sources have already passed compilation. Review the actual implementation, not just test existence. Remain concise: at most ten important issues and concise acceptance checks, about 1200 output words. This is static model review, not runtime verification." + productRequirements + runtimeAcceptanceRequirements, { appProfile: input.project.brief, approvedDesign: input.design, approvedOutline, integration, files: output.files, completedChecks: { assembleDebug: true, testDebugUnitTest: true, lintDebug: true } }, Review, 24000, "medium", 600000);
      await write(path.join(input.directory, `review-${round}.json`), review);
      if (!implementationReviewPassed(review)) { prior = output; issues = review.issues.filter(issue => !issue.startsWith("[follow-up]")); if (!issues.length) issues = review.issues; await write(path.join(input.directory, "failure.json"), { issues, stage: "review", round }); continue; }
      runtimeReport = null;
      if (environment.nativeSmoke?.projectId === input.project.id) {
        await input.progress("Testing your app on Android…");
        try { runtimeReport = await nativeCheck(environment.nativeSmoke, path.join(source, "app/build/outputs/apk/debug/app-debug.apk"), packageId, input.directory, round); }
        catch (error) { prior = output; issues = [(error as Error).message]; await write(path.join(input.directory, "failure.json"), { issues, stage: "native", round }); if (error instanceof WorkbenchError && error.code === "native_harness") throw error; continue; }
      }
      uiReport = null;
      if (uiEntry) {
        await input.progress("Comparing your app screens with the original reference…");
        try {
          uiReport = await validateBuiltUi(uiEntry, path.join(source, "app/build/outputs/apk/debug/app-debug.apk"), packageId, path.join(input.directory, `ui-round-${round}`), input.design, visualReference!.manifestSha256);
        } catch (error) {
          if (!(error instanceof WorkbenchError) || error.code !== "ui_assertion") throw error;
          prior = output; issues = [error.message];
          await write(path.join(input.directory, "failure.json"), { issues, stage: "visual", round, captureDiagnostics: `ui-round-${round}/capture-diagnostics.json` });
          continue;
        }
        if (!uiReport.passed) {
          if (uiReport.review.verdict === "unknown") throw new WorkbenchError("ui_evidence_missing", "UI comparison needs complete matching original and candidate scenarios. Diagnostics are saved.", 422);
          prior = output;
          issues = [...uiReport.review.repairInstructions, ...uiReport.review.scenarios.flatMap(scenario => [...scenario.visualIssues, ...scenario.behaviorIssues])];
          if (!issues.length) issues = ["The screenshot review failed. Correct the visual hierarchy, layout and readability against the supplied visual reference and approved design."];
          await write(path.join(input.directory, "failure.json"), { issues, stage: "visual", round, uiReview: uiReport });
          continue;
        }
      }
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
      if (uiReport && uiReport.candidateApkSha256 !== await fileSha(apk)) throw new WorkbenchError("ui_apk_changed", "The APK changed after its UI review; create a new build.", 409);
      await checkApk(apk, path.join(input.directory, "apk-check.json"));
      const artifacts = path.join(input.directory, "artifacts"); await fs.mkdir(artifacts, { recursive: true });
      await fs.copyFile(apk, path.join(artifacts, "app.apk")); await write(path.join(artifacts, "approved-design.json"), input.design);
      await write(path.join(artifacts, "build-report.json"), { projectId: input.project.id, revision: input.revision, designHash: input.designHash, packageId, review, build: true, unitTests: true, lint: true, runtimeVerified: Boolean(runtimeReport), visualVerified: Boolean(uiReport?.passed) });
      if (uiReport) {
        await write(path.join(artifacts, "ui-validation.json"), uiReport);
        await fs.copyFile(path.join(input.directory, `ui-round-${round}`, "comparison/comparison.html"), path.join(artifacts, "ui-comparison.html"));
      }
      if (runtimeReport) await write(path.join(artifacts, "runtime-report.json"), runtimeReport);
      const metadata = await Promise.all(["app.apk", "approved-design.json", "build-report.json", ...(runtimeReport ? ["runtime-report.json"] : []), ...(uiReport ? ["ui-validation.json", "ui-comparison.html"] : [])].map(async name => ({ name, url: `/api/projects/${input.project.id}/builds/${path.basename(input.directory)}/artifacts/${name}`, sha256: await fileSha(path.join(artifacts, name)) })));
      await write(path.join(input.directory, "artifacts.json"), metadata);
      return { artifacts: metadata, validation: { build: true, unitTests: true, lint: true, runtimeVerified: Boolean(runtimeReport), visualVerified: Boolean(uiReport?.passed), limitations: [...(runtimeReport ? ["Native smoke interactions passed on the recorded Android emulator. Other devices and all failure paths are not covered."] : ["A complete native behavioral smoke suite has not been verified by this build worker."]), ...(uiReport ? [uiReport.scope] : ["Original/candidate screenshot comparison was not configured; visual quality is not verified."]), ...review.issues.filter(issue => issue.startsWith("[follow-up]"))] } };
    }
    await write(path.join(input.directory, "failure.json"), { issues });
    throw new WorkbenchError("build_failed", "The app did not pass implementation or build checks after four repairs. Your approved design is preserved; retry the build.", 422);
  };
}
