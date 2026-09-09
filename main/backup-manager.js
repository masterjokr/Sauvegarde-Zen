'use strict';

const { runIncrementalBackup } = require('./backup-engine');

class BackupManager {
  constructor({ store, emit, notify, getSettings }) {
    this.store = store;
    this.emit = emit;
    this.notify = notify;
    this.getSettings = getSettings;
    this.running = new Map();
  }

  isRunning(jobId) {
    return this.running.has(jobId);
  }

  run(jobId, trigger = 'manual') {
    if (this.running.has(jobId)) return this.running.get(jobId);
    const promise = this.execute(jobId, trigger).finally(() => {
      this.running.delete(jobId);
      this.emit('state-changed');
    });
    this.running.set(jobId, promise);
    return promise;
  }

  async execute(jobId, trigger) {
    const job = this.store.findJob(jobId);
    if (!job) throw new Error('Cette sauvegarde n’existe plus.');
    this.emit('backup-started', { jobId, trigger });

    try {
      const result = await runIncrementalBackup({
        job,
        onProgress: (progress) => this.emit('backup-progress', progress)
      });
      const summary = {
        status: result.status,
        copied: result.copied,
        updated: result.updated,
        skipped: result.skipped,
        excluded: result.excluded,
        archived: result.archived,
        totalFiles: result.totalFiles,
        totalBytes: result.totalBytes,
        bytesCopied: result.bytesCopied,
        oldVersionsDeleted: result.oldVersionsDeleted,
        versionsKept: result.versionsKept,
        errors: result.errorCount,
        errorCount: result.errorCount,
        freeBytesBefore: result.freeBytesBefore,
        freeBytesAfter: result.freeBytesAfter,
        finishedAt: result.finishedAt
      };
      this.store.updateJob(jobId, (current) => ({
        ...current,
        lastRunAt: result.finishedAt,
        lastResult: summary
      }));
      this.store.addHistory({
        jobId,
        jobName: job.name,
        trigger,
        ...result
      });
      this.emit('backup-finished', { jobId, result: summary });
      if (this.getSettings().notifyOnCompletion) {
        const title = result.status === 'success' ? 'Sauvegarde terminée' : 'Sauvegarde terminée avec alertes';
        this.notify(title, `${job.name} : ${result.copied} nouveau(x), ${result.updated} mis à jour.`);
      }
      return summary;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const summary = {
        status: 'failed',
        copied: 0,
        updated: 0,
        skipped: 0,
        excluded: 0,
        archived: 0,
        totalFiles: 0,
        totalBytes: 0,
        oldVersionsDeleted: 0,
        versionsKept: 0,
        errors: 1,
        bytesCopied: 0,
        finishedAt,
        message: error.message
      };
      this.store.updateJob(jobId, (current) => ({
        ...current,
        lastRunAt: finishedAt,
        lastResult: summary
      }));
      this.store.addHistory({
        jobId,
        jobName: job.name,
        trigger,
        startedAt: finishedAt,
        finishedAt,
        ...summary,
        errors: [{ path: '.', message: error.message }]
      });
      this.emit('backup-failed', { jobId, error: error.message });
      this.notify('Échec de la sauvegarde', `${job.name} : ${error.message}`);
      throw error;
    }
  }
}

module.exports = { BackupManager };
