const { readFileSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { createHash } = require('node:crypto');

const owners = {
  'ai-settings': 'operations', audit: 'operations', auth: 'operations', faqs: 'operations',
  health: 'operations', observability: 'operations', customers: 'customer', members: 'customer',
  organizations: 'customer', pins: 'customer', orders: 'order', payments: 'order',
  consultations: 'consultation', 'call-insights': 'consultation', dashboard: 'consultation',
  'unanswered-questions': 'consultation', webhooks: 'consultation',
};

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

function inventory(root = join(__dirname, '../..')) {
  const source = files(join(root, 'backend/src'));
  const routes = source.filter(path => path.endsWith('.controller.ts')).flatMap(path => {
    const text = readFileSync(path, 'utf8');
    const controller = /@Controller\((?:'([^']*)')?\)/.exec(text);
    if (!controller) throw new Error(`Unsupported controller: ${path}`);
    const file = relative(root, path).replaceAll('\\', '/');
    const service = owners[file.split('/')[2]];
    if (!service) throw new Error(`Missing service owner: ${file}`);
    return [...text.matchAll(/@(Get|Post|Patch|Put|Delete|Sse)\((?:'([^']*)')?\)/g)].map(match => {
      let route = [controller[1], match[2]].filter(Boolean).join('/');
      if (!['health', 'internal/metrics', 'webhooks/pbx/call-ended'].some(p => route === p || (p === 'health' && route === 'health/ready')))
        route = `api/${route}`;
      return { method: match[1] === 'Sse' ? 'GET' : match[1].toUpperCase(), path: `/${route}`,
        service, stream: match[1] === 'Sse', file };
    });
  });
  const migrations = files(join(root, 'backend/migrations')).filter(path => path.endsWith('.sql'))
    .map(path => ({ file: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex') }));
  return { routes, migrations,
    workers: source.filter(path => path.endsWith('.worker.ts') || path.endsWith('/active-call-count.service.ts') || path.endsWith('\\active-call-count.service.ts'))
      .map(path => relative(root, path).replaceAll('\\', '/')) };
}

module.exports = { inventory };
if (require.main === module) process.stdout.write(JSON.stringify(inventory(process.argv[2]), null, 2) + '\n');
