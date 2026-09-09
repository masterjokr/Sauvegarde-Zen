'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizedForComparison(inputPath) {
  const normalized = path.resolve(inputPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(first, second) {
  const a = normalizedForComparison(first);
  const b = normalizedForComparison(second);
  if (a === b) return true;
  const aToB = path.relative(a, b);
  const bToA = path.relative(b, a);
  const inside = (relative) => relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return inside(aToB) || inside(bToA);
}

function assertDirectory(directoryPath, label) {
  if (!directoryPath || !path.isAbsolute(directoryPath)) {
    throw new Error(`${label} doit être un chemin absolu.`);
  }
  let stat;
  try {
    stat = fs.statSync(directoryPath);
  } catch {
    throw new Error(`${label} n'est pas accessible.`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} doit être un dossier.`);
}

function sanitizeSchedule(raw, existingSchedule) {
  const type = ['hourly', 'daily', 'weekly'].includes(raw?.type) ? raw.type : 'hourly';
  const schedule = {
    id: cleanString(raw?.id, 80) || randomUUID(),
    type,
    enabled: raw?.enabled !== false,
    createdAt: existingSchedule?.createdAt || new Date().toISOString(),
    lastTriggeredAt: existingSchedule?.lastTriggeredAt || null
  };

  if (type === 'hourly') {
    const everyHours = Number(raw?.everyHours);
    schedule.everyHours = Number.isInteger(everyHours) && everyHours >= 1 && everyHours <= 168
      ? everyHours
      : 1;
  } else {
    schedule.time = TIME_PATTERN.test(raw?.time) ? raw.time : '18:00';
  }

  if (type === 'weekly') {
    const weekdays = Array.isArray(raw?.weekdays)
      ? [...new Set(raw.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [];
    schedule.weekdays = weekdays.length ? weekdays.sort() : [6];
  }

  return schedule;
}

function sanitizeReminder(raw, existingReminder) {
  const frequency = raw?.frequency === 'weekly' ? 'weekly' : 'daily';
  const reminder = {
    enabled: Boolean(raw?.enabled),
    frequency,
    time: TIME_PATTERN.test(raw?.time) ? raw.time : '18:00',
    lastNotifiedAt: existingReminder?.lastNotifiedAt || null
  };
  if (frequency === 'weekly') {
    const weekday = Number(raw?.weekday);
    reminder.weekday = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : 6;
  }
  return reminder;
}

function sanitizeExclusions(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .map((pattern) => cleanString(pattern, 200).replace(/\\/g, '/'))
    .filter(Boolean))].slice(0, 100);
}

function sanitizeJob(raw, existingJob = null) {
  const name = cleanString(raw?.name, 80);
  const source = cleanString(raw?.source, 1024);
  const destination = cleanString(raw?.destination, 1024);
  if (!name) throw new Error('Donnez un nom à la sauvegarde.');
  if (!source || !destination) throw new Error('Choisissez un dossier source et un dossier de destination.');
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  assertDirectory(resolvedSource, 'Le dossier source');
  assertDirectory(resolvedDestination, 'Le dossier de destination');
  // Vérifie aussi les jonctions/raccourcis de dossiers afin d’éviter qu’une
  // destination réelle se retrouve à l’intérieur de la source (ou inversement).
  let sourceForOverlap = resolvedSource;
  let destinationForOverlap = resolvedDestination;
  try {
    sourceForOverlap = fs.realpathSync(resolvedSource);
    destinationForOverlap = fs.realpathSync(resolvedDestination);
  } catch {
    // assertDirectory a déjà vérifié l’existence ; on conserve le chemin résolu
    // si le système de fichiers refuse realpath.
  }
  if (pathsOverlap(sourceForOverlap, destinationForOverlap)) {
    throw new Error('Les dossiers source et destination ne doivent pas être identiques ni imbriqués.');
  }

  const rawSchedules = Array.isArray(raw?.schedules) ? raw.schedules.slice(0, 10) : [];
  const schedules = rawSchedules.map((schedule) => {
    const existing = existingJob?.schedules?.find((item) => item.id === schedule.id);
    return sanitizeSchedule(schedule, existing);
  });

  const now = new Date().toISOString();
  return {
    id: existingJob?.id || randomUUID(),
    name,
    source: resolvedSource,
    destination: resolvedDestination,
    enabled: raw?.enabled !== false,
    schedules,
    exclusions: sanitizeExclusions(raw?.exclusions),
    reminder: sanitizeReminder(raw?.reminder, existingJob?.reminder),
    createdAt: existingJob?.createdAt || now,
    updatedAt: now,
    lastRunAt: existingJob?.lastRunAt || null,
    lastResult: existingJob?.lastResult || null
  };
}

function sanitizeSettings(raw) {
  return {
    startWithWindows: Boolean(raw?.startWithWindows),
    minimizeToTray: raw?.minimizeToTray !== false,
    notifyOnCompletion: raw?.notifyOnCompletion !== false
  };
}

module.exports = {
  sanitizeJob,
  sanitizeSettings,
  sanitizeSchedule,
  sanitizeExclusions,
  pathsOverlap,
  TIME_PATTERN
};
