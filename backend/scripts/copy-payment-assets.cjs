const { cpSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
mkdirSync(join(root, 'dist/payments/assets'), { recursive: true });
cpSync(join(root, 'src/payments/assets'), join(root, 'dist/payments/assets'), { recursive: true });
