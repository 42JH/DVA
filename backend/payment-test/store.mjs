import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PaymentError } from './errors.mjs';

// A single process owns this dedicated demo file. Docker runs it under flock --no-fork.
// No application DB connection, order mutation, or provider response bodies are stored.
export class PaymentStore {
  #tail = Promise.resolve();
  #records = {};
  constructor(directory, { beforeWrite = async () => {} } = {}) {
    this.directory = directory;
    this.file = join(directory, 'requests.json');
    this.beforeWrite = beforeWrite;
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('Invalid store');
      this.#records = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Payment store is unreadable');
    }
    await this.change((records) => {
      for (const record of Object.values(records)) {
        if (record.status === 'CONFIRMING') record.status = 'REVIEW_REQUIRED';
        if (record.notificationStatus === 'SENDING') record.notificationStatus = 'UNKNOWN';
      }
    });
  }
  async change(operation) {
    const run = this.#tail.then(async () => {
      const next = structuredClone(this.#records);
      const result = operation(next);
      await this.beforeWrite(next);
      const temporary = join(this.directory, `${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      this.#records = next;
      // Persist the rename too, so a crash never turns an in-flight approval into PENDING.
      if (process.platform !== 'win32') {
        const dir = await open(this.directory, 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      return structuredClone(result);
    });
    this.#tail = run.catch(() => {});
    return run;
  }
  async find(token) {
    await this.#tail;
    const value = this.#records[token];
    if (!value) throw new PaymentError(404, 'NOT_FOUND');
    return structuredClone(value);
  }
}
