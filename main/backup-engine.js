'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  INTERNAL_DIRECTORY,
  MAX_VERSION_RUNS,
  safePathSegment,
  pruneVersionRuns
} = require('./version-store');
const { getFreeSpace } = require('./storage');

const MIN_FREE_SPACE = 10 * 1024 * 1024;

async function lstatOrNull(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function patternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`, 'i');
}

function isExcluded(relativePath, patterns = []) {
  const normalizedPath = normalizeRelativePath(relativePath);
  return patterns.some((rawPattern) => {
    const pattern = normalizeRelativePath(String(rawPattern || '').trim()).replace(/^\/|\/$/g, '');
    if (!pattern) return false;
    if (pattern.endsWith('/**')) {
      const base = pattern.slice(0, -3).replace(/\/$/, '');
      return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
    }
    const matcher = patternToRegExp(pattern);
    return matcher.test(normalizedPath) || normalizedPath.split('/').some((part) => matcher.test(part));
  });
}

function isInternalPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  const internal = INTERNAL_DIRECTORY.toLowerCase();
  return normalized === internal || normalized.startsWith(`${internal}/`);
}

async function scanSource(rootPath, patterns) {
  const result = { files: 0, bytes: 0 };

  async function visit(relativeDirectory = '') {
    let directory;
    try {
      directory = await fsp.opendir(path.join(rootPath, relativeDirectory));
    } catch {
      return;
    }
    for await (const entry of directory) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (isInternalPath(relativePath) || isExcluded(relativePath, patterns)) continue;
      try {
        const stat = await fsp.lstat(path.join(rootPath, relativePath));
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) await visit(relativePath);
        else if (stat.isFile()) {
          result.files += 1;
          result.bytes += stat.size;
        }
      } catch {
        // Le parcours réel enregistrera l’erreur avec le chemin concerné.
      }
    }
  }

  await visit();
  return result;
}

async function moveToHistory(targetPath, relativePath, versionRoot) {
  const historyPath = path.join(versionRoot, relativePath);
  await fsp.mkdir(path.dirname(historyPath), { recursive: true });
  let finalHistoryPath = historyPath;
  if (await lstatOrNull(finalHistoryPath)) {
    finalHistoryPath = `${historyPath}.${randomUUID().slice(0, 8)}`;
  }
  await fsp.rename(targetPath, finalHistoryPath);
  return finalHistoryPath;
}

async function restoreFromHistory(historyPath, targetPath) {
  if (!historyPath) return;
  if (await lstatOrNull(targetPath)) return;
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.rename(historyPath, targetPath);
}

function sameFileMetadata(sourceStat, destinationStat) {
  return destinationStat.isFile()
    && sourceStat.size === destinationStat.size
    && Math.abs(sourceStat.mtimeMs - destinationStat.mtimeMs) < 2;
}

async function copyFileAtomically(sourcePath, targetPath, sourceStat, relativePath, versionRoot) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.sauvegarde-zen-${randomUUID()}.tmp`;
  let archivedPath = null;

  try {
    const existing = await lstatOrNull(targetPath);
    if (existing) archivedPath = await moveToHistory(targetPath, relativePath, versionRoot);
    await fsp.copyFile(sourcePath, temporaryPath);
    await fsp.utimes(temporaryPath, sourceStat.atime, sourceStat.mtime);
    await fsp.rename(temporaryPath, targetPath);
    return archivedPath;
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    await restoreFromHistory(archivedPath, targetPath).catch(() => {});
    throw error;
  }
}

async function prepareDirectory(targetPath, relativePath, versionRoot) {
  const existing = await lstatOrNull(targetPath);
  if (!existing) {
    await fsp.mkdir(targetPath, { recursive: true });
    return { created: true, archived: false };
  }
  if (existing.isDirectory()) return { created: false, archived: false };
  const archivedPath = await moveToHistory(targetPath, relativePath, versionRoot);
  try {
    await fsp.mkdir(targetPath, { recursive: true });
    return { created: true, archived: Boolean(archivedPath) };
  } catch (error) {
    await restoreFromHistory(archivedPath, targetPath).catch(() => {});
    throw error;
  }
}

async function removeEmptyParents(directoryPath, stopAt) {
  let current = directoryPath;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      await fsp.rmdir(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

async function runIncrementalBackup({ job, onProgress = () => {}, now = new Date() }) {
  const startedAt = now.toISOString();
  const startedClock = Date.now();
  const runId = `${timestampForPath(now)}-${randomUUID().slice(0, 8)}`;
  const metadataRoot = path.join(job.destination, INTERNAL_DIRECTORY);
  const versionRoot = path.join(metadataRoot, 'versions', safePathSegment(job.id), runId);
  const patterns = Array.isArray(job.exclusions) ? job.exclusions : [];
  const result = {
    jobId: job.id,
    startedAt,
    finishedAt: null,
    status: 'success',
    copied: 0,
    updated: 0,
    skipped: 0,
    excluded: 0,
    directoriesCreated: 0,
    linksSkipped: 0,
    errors: [],
    errorCount: 0,
    bytesCopied: 0,
    archived: 0,
    processedFiles: 0,
    totalFiles: 0,
    totalBytes: 0,
    freeBytesBefore: null,
    freeBytesAfter: null,
    oldVersionsDeleted: 0,
    versionsKept: 0,
    versionDirectory: null
  };

  const sourceRootStat = await fsp.stat(job.source);
  if (!sourceRootStat.isDirectory()) throw new Error('Le dossier source n’est plus un dossier.');
  const destinationRootStat = await fsp.stat(job.destination);
  if (!destinationRootStat.isDirectory()) throw new Error('Le dossier de destination n’est plus un dossier.');

  const sourceSummary = await scanSource(job.source, patterns);
  result.totalFiles = sourceSummary.files;
  result.totalBytes = sourceSummary.bytes;
  const progress = (currentPath, force = false, phase = 'copying') => {
    const currentTime = Date.now();
    if (!force && currentTime - progress.lastProgressAt <= 120) return;
    progress.lastProgressAt = currentTime;
    const elapsedMs = Math.max(1, currentTime - startedClock);
    const rate = result.processedFiles / (elapsedMs / 1000);
    const remaining = Math.max(0, result.totalFiles - result.processedFiles);
    const etaSeconds = rate > 0 ? Math.ceil(remaining / rate) : null;
    try {
      onProgress({
        jobId: job.id,
        phase,
        currentPath,
        copied: result.copied,
        updated: result.updated,
        skipped: result.skipped,
        excluded: result.excluded,
        errors: result.errorCount,
        bytesCopied: result.bytesCopied,
        processedFiles: result.processedFiles,
        totalFiles: result.totalFiles,
        totalBytes: result.totalBytes,
        elapsedMs,
        etaSeconds
      });
    } catch {
      // La fenêtre peut être fermée pendant une sauvegarde ; la copie continue.
    }
  };
  progress.lastProgressAt = 0;
  progress('', true, 'indexing');

  result.freeBytesBefore = await getFreeSpace(job.destination);
  if (result.freeBytesBefore !== null && result.freeBytesBefore < MIN_FREE_SPACE) {
    throw new Error(`Espace libre insuffisant sur la destination (${Math.round(result.freeBytesBefore / 1024 / 1024)} Mo).`);
  }

  await fsp.mkdir(versionRoot, { recursive: true });
  const recordError = (relativePath, error) => {
    result.errorCount += 1;
    if (result.errors.length < 100) {
      result.errors.push({
        path: relativePath || '.',
        message: error?.message || String(error)
      });
    }
    progress(relativePath, true);
  };

  async function visitDirectory(relativeDirectory = '') {
    const sourceDirectory = path.join(job.source, relativeDirectory);
    let directory;
    try {
      directory = await fsp.opendir(sourceDirectory);
    } catch (error) {
      recordError(relativeDirectory, error);
      return;
    }

    for await (const entry of directory) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const sourcePath = path.join(job.source, relativePath);
      const targetPath = path.join(job.destination, relativePath);
      progress(relativePath);

      if (isInternalPath(relativePath) || isExcluded(relativePath, patterns)) {
        result.excluded += 1;
        continue;
      }

      try {
        const sourceStat = await fsp.lstat(sourcePath);
        if (sourceStat.isSymbolicLink()) {
          result.linksSkipped += 1;
          continue;
        }
        if (sourceStat.isDirectory()) {
          const directoryResult = await prepareDirectory(targetPath, relativePath, versionRoot);
          if (directoryResult.created) result.directoriesCreated += 1;
          if (directoryResult.archived) result.archived += 1;
          await visitDirectory(relativePath);
          continue;
        }
        if (!sourceStat.isFile()) {
          result.linksSkipped += 1;
          continue;
        }

        result.processedFiles += 1;
        const destinationStat = await lstatOrNull(targetPath);
        if (destinationStat && sameFileMetadata(sourceStat, destinationStat)) {
          result.skipped += 1;
          continue;
        }

        const wasExisting = Boolean(destinationStat);
        const archivedPath = await copyFileAtomically(sourcePath, targetPath, sourceStat, relativePath, versionRoot);
        if (archivedPath) result.archived += 1;
        result.bytesCopied += sourceStat.size;
        if (wasExisting) result.updated += 1;
        else result.copied += 1;
      } catch (error) {
        recordError(relativePath, error);
      }
    }
  }

  await visitDirectory();
  if (result.archived === 0) await removeEmptyParents(versionRoot, metadataRoot);
  try {
    const retention = await pruneVersionRuns({
      destination: job.destination,
      jobId: job.id,
      keep: MAX_VERSION_RUNS
    });
    result.oldVersionsDeleted = retention.deleted.length;
    result.versionsKept = retention.kept.length;
  } catch (error) {
    recordError(`${INTERNAL_DIRECTORY}/versions`, error);
  }
  result.freeBytesAfter = await getFreeSpace(job.destination);
  result.finishedAt = new Date().toISOString();
  result.status = result.errorCount ? 'partial' : 'success';
  if (result.archived > 0) result.versionDirectory = versionRoot;
  progress('', true);
  return result;
}

module.exports = {
  runIncrementalBackup,
  sameFileMetadata,
  timestampForPath,
  isExcluded,
  scanSource,
  INTERNAL_DIRECTORY,
  MAX_VERSION_RUNS
};
