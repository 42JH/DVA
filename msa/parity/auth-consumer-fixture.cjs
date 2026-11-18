// Source auth tests inspect actual customer controller metadata across the MSA boundary.
const fs = require('node:fs');
for (const name of ['customers', 'organizations', 'members']) {
  const source = '/app/service/test/customer-runtime/' + name;
  const target = '/app/service/dist/' + name;
  if (!fs.existsSync(source)) throw Error('Missing compiled consumer: ' + name);
  if (!fs.existsSync(target)) fs.symlinkSync(source, target, 'dir');
  if (fs.realpathSync(target) !== source) throw Error('Unexpected consumer fixture: ' + name);
}
