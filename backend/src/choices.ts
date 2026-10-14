import { z } from "../../pipeline/dist/src/integration.js";
import { modelJson } from "./model";
import type { ProjectOptions } from "./projects";

export const explainConflicts: NonNullable<ProjectOptions["explainConflicts"]> = async (conflicts, brief, directory) => {
  const output = await modelJson(directory, "readable-choices", "Explain these saved product choices in concise English for a non-technical app creator. Preserve every option's meaning, tradeoffs and IDs. Mark a choice advanced only when it concerns implementation details such as storage technology, rather than user-visible behavior. Do not invent or merge choices. The source IDs and dependency constraints remain authoritative.", { brief, conflicts }, z.object({ choices: z.array(z.object({ id: z.string(), question: z.string().min(1).max(600), advanced: z.boolean(), options: z.array(z.object({ id: z.string(), behavior: z.string().min(1).max(600), benefits: z.array(z.string().max(600)).max(5), costs: z.array(z.string().max(600)).max(5) }).strict()).min(2).max(3) }).strict()).max(30) }).strict());
  if (output.choices.length !== conflicts.length || new Set(output.choices.map(choice => choice.id)).size !== conflicts.length) throw new Error("Incomplete readable choices");
  return conflicts.map(conflict => {
    const translated = output.choices.find(choice => choice.id === conflict.id);
    if (!translated || translated.options.length !== conflict.options.length || new Set(translated.options.map(option => option.id)).size !== conflict.options.length || translated.options.some(option => !conflict.options.some(source => source.id === option.id))) throw new Error("Changed choice IDs");
    return { ...conflict, question: translated.question, advanced: translated.advanced, options: conflict.options.map(option => ({ ...option, ...translated.options.find(o => o.id === option.id)! })) };
  });
};
