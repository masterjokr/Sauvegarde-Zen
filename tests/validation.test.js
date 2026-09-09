'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathsOverlap, sanitizeJob } = require('../main/validation');

test('refuse les dossiers source et destination imbriqués', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sauvegarde-zen-validation-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(source, 'copie');
  await fsp.mkdir(destination, { recursive: true });
  assert.equal(pathsOverlap(source, destination), true);
  assert.throws(() => sanitizeJob({ name: 'Test', source, destination, schedules: [] }), /imbriqués/);
});

test('accepte deux dossiers indépendants et normalise un horaire', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sauvegarde-zen-validation-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fsp.mkdir(source);
  await fsp.mkdir(destination);
  const job = sanitizeJob({
    name: 'Documents',
    source,
    destination,
    schedules: [{ type: 'hourly', everyHours: 4 }],
    reminder: { enabled: true, frequency: 'daily', time: '20:00' }
  });
  assert.equal(job.schedules[0].everyHours, 4);
  assert.equal(job.reminder.time, '20:00');
});
