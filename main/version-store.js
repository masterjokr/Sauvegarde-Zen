'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const INTERNAL_DIRECTORY = '.sauvegarde-zen';
const MAX_VERSION_RUNS = 3;

function safePathSegment(value) {
  const safe = String(value || 'job').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return safe || 'job';
}

function versionsJobRoot(destination, jobId) {
  return path.join(destination, INTERNAL_DIRECTORY, 'versions', safePathSegment(jobId));
}

function resolveSafeChild(basePath, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Chemin de fichier invalide.');
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Chemin absolu interdit.');
  }
  const resolved = path.resolve(basePath, normalized);
  const relative = path.relative(path.resolve(basePath), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Chemin en dehors du dossier autorisé.');
  }
  return resolved;
}

async function lstatOrNull(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function collectFiles(rootPath, relativeDirectory = '', output = []) {
  const currentPath = path.join(rootPath, relativeDirectory);
  let directory;
  try {
    directory = await fsp.opendir(currentPath);
  } catch (error) {
    if (error.code === 'ENOENT') return output;
    throw error;
  }

  for await (const entry of directory) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(rootPath, relativePath);
    const stat = await fsp.lstat(absolutePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await collectFiles(rootPath, relativePath, output);
    } else if (stat.isFile()) {
      output.push({
        path: relativePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }
  return output;
}

async function listVersionRuns({ destination, jobId, limit = MAX_VERSION_RUNS }) {
  // Nettoie aussi les versions héritées d’une installation précédente dès
  // leur consultation, afin de garantir la limite même avant la prochaine copie.
  await pruneVersionRuns({ destination, jobId, keep: MAX_VERSION_RUNS });
  const root = versionsJobRoot(destination, jobId);
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { jobId, runs: [], maxRuns: MAX_VERSION_RUNS };
    throw error;
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, Math.max(1, Math.min(Number(limit) || MAX_VERSION_RUNS, 20)));

  const runs = [];
  for (const entry of directories) {
    const runPath = path.join(root, entry.name);
    const stat = await fsp.stat(runPath);
    const files = await collectFiles(runPath);
    runs.push({
      id: entry.name,
      createdAt: stat.mtime.toISOString(),
      files,
      fileCount: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0)
    });
  }
  return { jobId, runs, maxRuns: MAX_VERSION_RUNS };
}

async function pruneVersionRuns({ destination, jobId, keep = MAX_VERSION_RUNS }) {
  const root = versionsJobRoot(destination, jobId);
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: [], kept: [] };
    throw error;
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name));
  const keepCount = Math.max(0, Number(keep) || MAX_VERSION_RUNS);
  const kept = directories.slice(0, keepCount).map((entry) => entry.name);
  const toDelete = directories.slice(keepCount);
  for (const entry of toDelete) {
    await fsp.rm(path.join(root, entry.name), { recursive: true, force: true });
  }
  if (!kept.length) {
    await fsp.rmdir(root).catch(() => {});
  }
  return { deleted: toDelete.map((entry) => entry.name), kept };
}

async function pruneRestoreSafety(destination, keep = MAX_VERSION_RUNS) {
  const root = path.join(destination, INTERNAL_DIRECTORY, 'restore-safety');
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: [], kept: [] };
    throw error;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name));
  const keepCount = Math.max(0, Number(keep) || MAX_VERSION_RUNS);
  const kept = directories.slice(0, keepCount).map((entry) => entry.name);
  const toDelete = directories.slice(keepCount);
  for (const entry of toDelete) {
    await fsp.rm(path.join(root, entry.name), { recursive: true, force: true });
  }
  if (!kept.length) await fsp.rmdir(root).catch(() => {});
  return { deleted: toDelete.map((entry) => entry.name), kept };
}

async function restoreVersionFile({ destination, jobId, runId, relativePath }) {
  if (typeof runId !== 'string' || runId !== path.basename(runId) || runId.includes('..')) {
    throw new Error('Version de sauvegarde invalide.');
  }
  if (typeof relativePath !== 'string') throw new Error('Chemin de fichier invalide.');
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  const internalPath = INTERNAL_DIRECTORY.toLowerCase();
  if (normalizedRelativePath.toLowerCase().startsWith(`${internalPath}/`) || normalizedRelativePath.toLowerCase() === internalPath) {
    throw new Error('Ce fichier interne ne peut pas être restauré.');
  }

  const runRoot = resolveSafeChild(versionsJobRoot(destination, jobId), runId);
  const archivedPath = resolveSafeChild(runRoot, relativePath);
  const archivedStat = await lstatOrNull(archivedPath);
  if (!archivedStat || !archivedStat.isFile()) throw new Error('Cette version de fichier n’existe plus.');

  const targetPath = resolveSafeChild(destination, relativePath);
  const safetyRoot = path.join(destination, INTERNAL_DIRECTORY, 'restore-safety', `${Date.now()}-${randomUUID().slice(0, 8)}`);
  const safetyPath = resolveSafeChild(safetyRoot, relativePath);
  let savedCurrentPath = null;
  const temporaryPath = `${targetPath}.sauvegarde-zen-restore-${randomUUID()}.tmp`;

  try {
    const currentStat = await lstatOrNull(targetPath);
    if (currentStat) {
      await fsp.mkdir(path.dirname(safetyPath), { recursive: true });
      await fsp.rename(targetPath, safetyPath);
      savedCurrentPath = safetyPath;
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(archivedPath, temporaryPath);
    await fsp.utimes(temporaryPath, archivedStat.atime, archivedStat.mtime);
    await fsp.rename(temporaryPath, targetPath);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    if (savedCurrentPath && !(await lstatOrNull(targetPath))) {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.rename(savedCurrentPath, targetPath).catch(() => {});
    }
    throw error;
  }

  const safetyRetention = await pruneRestoreSafety(destination);

  return {
    restoredPath: relativePath,
    savedCurrentPath,
    runId,
    safetyDeleted: safetyRetention.deleted.length
  };
}

module.exports = {
  INTERNAL_DIRECTORY,
  MAX_VERSION_RUNS,
  safePathSegment,
  versionsJobRoot,
  listVersionRuns,
  pruneVersionRuns,
  pruneRestoreSafety,
  restoreVersionFile,
  resolveSafeChild
};
