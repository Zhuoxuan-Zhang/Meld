import { expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { z } from 'zod';
import { claudeJsonSchema, parseClaudeCli } from '../src/claude-cli.js';

it('generates Draft 7 including tuple constraints and keeps runtime validation', () => {
  const schema = z.strictObject({ pair: z.tuple([z.string().min(1), z.number().int()]), choices: z.array(z.enum(['a', 'b'])).max(2) });
  const json = claudeJsonSchema(schema);
  expect(json.$schema).toBe('http://json-schema.org/draft-07/schema#');
  const validate = new Ajv({ strict: false }).compile(json);
  expect(validate({ pair: ['ok', 2], choices: ['a'] })).toBe(true);
  expect(validate({ pair: ['ok', 'wrong'], choices: ['a'] })).toBe(false);
  expect(validate({ pair: ['ok', 2, 3], choices: ['a'] })).toBe(false);
  const response = { execution: { code: 0 }, turn_completed: true, errors: [], tool_activity: false, final_text: JSON.stringify({ pair: ['ok', 2], choices: ['b'] }) };
  expect(parseClaudeCli(response, schema, 100)).toEqual({ pair: ['ok', 2], choices: ['b'] });
  expect(() => parseClaudeCli({ ...response, final_text: '{"pair":["ok",2],"choices":["invalid"]}' }, schema, 100)).toThrow();
  expect(() => parseClaudeCli({ ...response, usage: { output_tokens: 101 } }, schema, 100)).toThrow('token limit');
});
