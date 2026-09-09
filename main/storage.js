'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');

function driveLabel(directoryPath) {
  const normalized = path.resolve(directoryPath);
  const windowsDrive = normalized.match(/^([A-Za-z]):[\\/]/);
  if (windowsDrive) return `${windowsDrive[1].toUpperCase()}:`;
  if (normalized.startsWith('\\\\')) {
    const parts = normalized.split(/[\\/]+/).filter(Boolean);
    return parts.length >= 2 ? `\\\\${parts[0]}\\${parts[1]}` : normalized;
  }
  return path.parse(normalized).root || normalized;
}

async function getFreeSpace(directoryPath) {
  if (typeof fsp.statfs !== 'function') return null;
  try {
    const stats = await fsp.statfs(directoryPath);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function inspectPaths(source, destination) {
  const sourceStat = await fsp.stat(source);
  const destinationStat = await fsp.stat(destination);
  if (!sourceStat.isDirectory()) throw new Error('Le dossier source n’est pas un dossier.');
  if (!destinationStat.isDirectory()) throw new Error('Le dossier de destination n’est pas un dossier.');
  const freeBytes = await getFreeSpace(destination);
  return {
    source: path.resolve(source),
    destination: path.resolve(destination),
    sourceDrive: driveLabel(source),
    destinationDrive: driveLabel(destination),
    differentDrives: driveLabel(source).toLowerCase() !== driveLabel(destination).toLowerCase(),
    freeBytes
  };
}

module.exports = { driveLabel, getFreeSpace, inspectPaths };
