import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonStore } from '../electron/store';

describe('JsonStore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msfx-store-'));
  it('writes atomically and reloads', () => {
    const file = path.join(dir, 'a.json');
    const s = new JsonStore(file, { n: 1, list: [] as number[] });
    s.set({ n: 2, list: [1, 2] });
    s.flush();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(new JsonStore(file, { n: 0, list: [] as number[] }).get()).toEqual({ n: 2, list: [1, 2] });
  });
  it('quarantines a corrupt file and starts from defaults', () => {
    const file = path.join(dir, 'b.json');
    fs.writeFileSync(file, '{ not json');
    const errors: unknown[] = [];
    const s = new JsonStore(file, { ok: true }, (e) => errors.push(e));
    expect(s.get()).toEqual({ ok: true });
    expect(errors).toHaveLength(1);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('b.json.corrupt-'))).toBe(true);
  });
});
