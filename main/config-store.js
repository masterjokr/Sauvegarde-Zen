'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_STATE = Object.freeze({
  version: 1,
  settings: {
    startWithWindows: false,
    minimizeToTray: true,
    notifyOnCompletion: true
  },
  jobs: [],
  history: []
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLoadedJob(job) {
  if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id) return null;
  return {
    id: job.id,
    name: typeof job.name === 'string' && job.name.trim() ? job.name.slice(0, 80) : 'Sauvegarde sans nom',
    source: typeof job.source === 'string' ? job.source : '',
    destination: typeof job.destination === 'string' ? job.destination : '',
    enabled: job.enabled !== false,
    schedules: Array.isArray(job.schedules) ? job.schedules : [],
    exclusions: Array.isArray(job.exclusions) ? job.exclusions.slice(0, 100) : [],
    reminder: job.reminder && typeof job.reminder === 'object'
      ? job.reminder
      : { enabled: false, frequency: 'daily', time: '18:00', lastNotifiedAt: null },
    createdAt: job.createdAt || new Date(0).toISOString(),
    updatedAt: job.updatedAt || new Date(0).toISOString(),
    lastRunAt: job.lastRunAt || null,
    lastResult: job.lastResult || null
  };
}

class ConfigStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'configuration.json');
    this.state = clone(DEFAULT_STATE);
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        version: 1,
        settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(normalizeLoadedJob).filter(Boolean) : [],
        history: Array.isArray(parsed.history) ? parsed.history.slice(0, 200) : []
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const brokenPath = `${this.filePath}.illisible-${Date.now()}`;
        try {
          fs.renameSync(this.filePath, brokenPath);
        } catch {
          // Le fichier sera simplement remplacé par une configuration saine.
        }
      }
      this.state = clone(DEFAULT_STATE);
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  snapshot() {
    return clone(this.state);
  }

  findJob(id) {
    return this.state.jobs.find((job) => job.id === id) || null;
  }

  upsertJob(job) {
    const index = this.state.jobs.findIndex((item) => item.id === job.id);
    if (index === -1) {
      this.state.jobs.push(job);
    } else {
      this.state.jobs[index] = job;
    }
    this.save();
    return clone(job);
  }

  updateJob(id, updater) {
    const index = this.state.jobs.findIndex((job) => job.id === id);
    if (index === -1) return null;
    const current = this.state.jobs[index];
    const updated = updater(clone(current));
    this.state.jobs[index] = updated;
    this.save();
    return clone(updated);
  }

  deleteJob(id) {
    const before = this.state.jobs.length;
    this.state.jobs = this.state.jobs.filter((job) => job.id !== id);
    this.state.history = this.state.history.filter((entry) => entry.jobId !== id);
    if (this.state.jobs.length !== before) this.save();
    return this.state.jobs.length !== before;
  }

  addHistory(entry) {
    this.state.history.unshift({ id: randomUUID(), ...entry });
    this.state.history = this.state.history.slice(0, 200);
    this.save();
  }

  updateSettings(settings) {
    this.state.settings = { ...this.state.settings, ...settings };
    this.save();
    return clone(this.state.settings);
  }
}

module.exports = { ConfigStore, DEFAULT_STATE };
