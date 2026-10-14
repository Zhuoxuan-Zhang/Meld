import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { Claude } from '../claude.js';
import { exists, json, write } from '../storage.js';
import { withLock } from './store.js';

export interface DesignModel {
  ask<T>(label: string, prompt: string, context: any, schema: z.ZodType<T>, validate?: (value: T) => string[]): Promise<T>;
}
export class LiveDesignModel implements DesignModel {
  constructor(private project: string, private workspace: string, private config: any) {}
  async ask<T>(label: string, prompt: string, context: any, schema: z.ZodType<T>, validate?: (value: T) => string[]): Promise<T> {
    const dir = path.join(this.workspace, 'model');
    await fs.mkdir(dir, { recursive: true });
    return withLock(path.join(dir, 'model.lock'), async () => {
      const statePath = path.join(dir, 'run.json');
      const state = await exists(statePath) ? await json(statePath) : { id: 'design-workbench', config: this.config, calls: [], created_at: new Date().toISOString() };
      if (state.config.provider !== this.config.provider || state.config.model !== this.config.model) throw new Error('Keep the model configuration stable within a design workspace');
      await write(statePath, state);
      return new Claude(this.project, dir, state).ask(label, prompt, context, schema, validate);
    }, 1000);
  }
}
