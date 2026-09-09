'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runIncrementalBackup } = require('../main/backup-engine');
const { listVersionRuns, restoreVersionFile } = require('../main/version-store');

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sauvegarde-zen-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fsp.mkdir(source);
  await fsp.mkdir(destination);
  return { root, source, destination };
}

test('copie les nouveaux fichiers et ignore les fichiers inchangés', async (t) => {
  const { root, source, destination } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(source, 'photos'));
  await fsp.writeFile(path.join(source, 'photos', 'vacances.txt'), 'souvenir');
  const job = { id: 'job-test', source, destination };

  const first = await runIncrementalBackup({ job, now: new Date('2026-09-03T10:00:00.000Z') });
  assert.equal(first.copied, 1);
  assert.equal(first.updated, 0);
  assert.equal(await fsp.readFile(path.join(destination, 'photos', 'vacances.txt'), 'utf8'), 'souvenir');

  const second = await runIncrementalBackup({ job, now: new Date('2026-09-03T11:00:00.000Z') });
  assert.equal(second.copied, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 1);
});

test('archive une ancienne version avant de remplacer un fichier modifié', async (t) => {
  const { root, source, destination } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(source, 'document.txt');
  await fsp.writeFile(sourceFile, 'version 1');
  const job = { id: 'job-versions', source, destination };
  await runIncrementalBackup({ job, now: new Date('2026-09-03T10:00:00.000Z') });

  await new Promise((resolve) => setTimeout(resolve, 10));
  await fsp.writeFile(sourceFile, 'version 2 plus longue');
  const second = await runIncrementalBackup({ job, now: new Date('2026-09-03T11:00:00.000Z') });
  assert.equal(second.updated, 1);
  assert.equal(second.archived, 1);
  assert.equal(await fsp.readFile(path.join(destination, 'document.txt'), 'utf8'), 'version 2 plus longue');
  assert.ok(second.versionDirectory);
  assert.equal(await fsp.readFile(path.join(second.versionDirectory, 'document.txt'), 'utf8'), 'version 1');
});

test('ne supprime pas de la destination un fichier retiré de la source', async (t) => {
  const { root, source, destination } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(source, 'a-conserver.txt');
  await fsp.writeFile(sourceFile, 'contenu');
  const job = { id: 'job-additif', source, destination };
  await runIncrementalBackup({ job, now: new Date('2026-09-03T10:00:00.000Z') });
  await fsp.rm(sourceFile);

  await runIncrementalBackup({ job, now: new Date('2026-09-03T11:00:00.000Z') });
  assert.equal(await fsp.readFile(path.join(destination, 'a-conserver.txt'), 'utf8'), 'contenu');
});

test('conserve exactement les trois versions les plus récentes', async (t) => {
  const { root, source, destination } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(source, 'rapport.txt');
  const job = { id: 'job-retention', source, destination };

  await fsp.writeFile(sourceFile, 'version 1');
  await runIncrementalBackup({ job, now: new Date('2026-09-03T10:00:00.000Z') });
  for (let version = 2; version <= 5; version += 1) {
    const content = `version ${version} ${'x'.repeat(version)}`;
    await fsp.writeFile(sourceFile, content);
    const result = await runIncrementalBackup({
      job,
      now: new Date(`2026-09-03T${String(8 + version).padStart(2, '0')}:00:00.000Z`)
    });
    if (version === 5) assert.equal(result.oldVersionsDeleted, 1);
  }

  const versions = await listVersionRuns({ destination, jobId: job.id });
  assert.equal(versions.runs.length, 3);
  assert.equal(versions.runs.every((run) => run.fileCount === 1), true);
  assert.equal(await fsp.readFile(sourceFile, 'utf8'), `version 5 ${'x'.repeat(5)}`);
  assert.equal(await fsp.readFile(path.join(destination, 'rapport.txt'), 'utf8'), `version 5 ${'x'.repeat(5)}`);
});

test('restaure un fichier depuis une version et protège la copie actuelle', async (t) => {
  const { root, source, destination } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(source, 'document.txt');
  const job = { id: 'job-restore', source, destination };

  await fsp.writeFile(sourceFile, 'ancienne version');
  await runIncrementalBackup({ job, now: new Date('2026-09-03T10:00:00.000Z') });
  await fsp.writeFile(sourceFile, 'version actuelle');
  await runIncrementalBackup({ job, now: new Date('2026-09-03T11:00:00.000Z') });

  const versions = await listVersionRuns({ destination, jobId: job.id });
  const archivedFile = versions.runs[0].files.find((file) => file.path === 'document.txt');
  assert.ok(archivedFile);
  const restored = await restoreVersionFile({
    destination,
    jobId: job.id,
    runId: versions.runs[0].id,
    relativePath: archivedFile.path
  });

  assert.equal(restored.restoredPath, 'document.txt');
  assert.ok(restored.savedCurrentPath);
  assert.equal(await fsp.readFile(path.join(destination, 'document.txt'), 'utf8'), 'ancienne version');
  assert.equal(await fsp.readFile(restored.savedCurrentPath, 'utf8'), 'version actuelle');
});

test('ignore les motifs d’exclusion configurés', async (t) => {
  const { root, source, destination } = await fixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(source, 'node_modules'), { recursive: true });
  await fsp.writeFile(path.join(source, 'node_modules', 'dependance.txt'), 'à ignorer');
  await fsp.writeFile(path.join(source, 'brouillon.tmp'), 'à ignorer');
  await fsp.writeFile(path.join(source, 'a-garder.txt'), 'à garder');
  const result = await runIncrementalBackup({
    job: { id: 'job-exclusions', source, destination, exclusions: ['node_modules', '*.tmp'] },
    now: new Date('2026-09-03T10:00:00.000Z')
  });

  assert.equal(result.copied, 1);
  assert.equal(result.excluded, 2);
  assert.equal(await fsp.readFile(path.join(destination, 'a-garder.txt'), 'utf8'), 'à garder');
  await assert.rejects(() => fsp.stat(path.join(destination, 'node_modules', 'dependance.txt')));
  await assert.rejects(() => fsp.stat(path.join(destination, 'brouillon.tmp')));
});
