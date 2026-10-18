// Temporary one-off driver: bridges a raw `pipeline/src/cli.ts run` output
// (which has no project/research/base-app layer) into the workbench
// DesignService + Android build machinery, without going through the
// project API. Not a permanent CLI tool; delete after use.
import path from "node:path";
import { promises as fs } from "node:fs";
import { DesignService, pipelineRoot, json, semanticHash } from "../../pipeline/dist/src/integration.js";
import { androidBuildRunner } from "./build";

const RUN = process.argv[2];
const ID = process.argv[3] || "minefield-plus";
if (!RUN) throw new Error("Usage: tsx src/manual-build.ts /path/to/pipeline/run [design-id]");

async function main() {
  const root = path.resolve("../frontend/.meld-cache/designs");
  const service = new DesignService(pipelineRoot, root);
  const config = await json(path.join(pipelineRoot, "config/runtime.workbench.json"));
  console.log("Importing pipeline run into DesignService…");
  const imported = await service.initialize(ID, path.resolve(RUN), config);
  console.log("Imported design:", imported.id, imported.revision);

  const revision = await service.store.revision(ID, imported.revision);
  const developer_design = revision.data.design;
  const brief = revision.data.brief;
  const decisions = revision.data.decisions;
  const designHash = semanticHash(developer_design);

  const project = { id: `manual-${ID}`, brief, latestBuild: null, lastDeliveredBuild: null } as any;
  const directory = path.resolve(`./.manual-builds/${ID}-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });

  const build = androidBuildRunner({
    sdk: path.resolve("../pipeline/tools/android-sdk"),
    javaHome: "/usr/lib/jvm/java-21-openjdk-amd64",
    templateDirectory: path.resolve("./templates/android"),
  });

  console.log("Starting codegen + Gradle build (this will take a while)…");
  const output = await build({
    project,
    revision: revision.record.id,
    design: { developer_design, brief, decisions },
    designHash,
    directory,
    progress: async (phase: string) => console.log("[progress]", phase),
  });

  console.log("BUILD SUCCEEDED");
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error("BUILD FAILED:", error);
  process.exit(1);
});
