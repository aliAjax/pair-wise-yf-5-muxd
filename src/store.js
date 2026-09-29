import fs from 'node:fs';
import path from 'node:path';

export class MemoryStore {
  constructor(initial = {}) {
    this.data = structuredClone(initial);
  }

  read() {
    return structuredClone(this.data);
  }

  write(data) {
    this.data = structuredClone(data);
  }
}

export class JsonStore extends MemoryStore {
  constructor(filePath) {
    super(fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {});
    this.filePath = filePath;
  }

  write(data) {
    super.write(data);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    fs.renameSync(tmp, this.filePath);
  }
}
