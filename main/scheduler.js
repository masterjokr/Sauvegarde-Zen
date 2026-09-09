'use strict';

function parseTime(time) {
  const [hours, minutes] = String(time || '00:00').split(':').map(Number);
  return { hours, minutes };
}

function occurrenceOnDate(referenceDate, time) {
  const { hours, minutes } = parseTime(time);
  const date = new Date(referenceDate);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function mostRecentOccurrence(schedule, now) {
  if (schedule.type === 'hourly') {
    const baseline = new Date(schedule.lastTriggeredAt || schedule.createdAt).getTime();
    const period = schedule.everyHours * 60 * 60 * 1000;
    return new Date(baseline + period);
  }

  if (schedule.type === 'daily') {
    return occurrenceOnDate(now, schedule.time);
  }

  if (schedule.type === 'weekly') {
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() - offset);
      const occurrence = occurrenceOnDate(candidate, schedule.time);
      if (schedule.weekdays.includes(occurrence.getDay()) && occurrence <= now) return occurrence;
    }
  }
  return null;
}

function isScheduleDue(schedule, now = new Date()) {
  if (!schedule.enabled) return false;
  const occurrence = mostRecentOccurrence(schedule, now);
  if (!occurrence || occurrence > now) return false;
  const last = schedule.lastTriggeredAt ? new Date(schedule.lastTriggeredAt) : null;
  return !last || last < occurrence;
}

function nextScheduleOccurrence(schedule, now = new Date()) {
  if (!schedule.enabled) return null;
  if (schedule.type === 'hourly') {
    const baseline = new Date(schedule.lastTriggeredAt || schedule.createdAt).getTime();
    const period = schedule.everyHours * 60 * 60 * 1000;
    let next = baseline + period;
    if (next <= now.getTime()) next = now.getTime();
    return new Date(next);
  }

  if (schedule.type === 'daily') {
    const candidate = occurrenceOnDate(now, schedule.time);
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  if (schedule.type === 'weekly') {
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + offset);
      const occurrence = occurrenceOnDate(candidate, schedule.time);
      if (schedule.weekdays.includes(occurrence.getDay()) && occurrence > now) return occurrence;
    }
  }
  return null;
}

function reminderAsSchedule(reminder, createdAt) {
  if (!reminder) return null;
  return {
    type: reminder.frequency === 'weekly' ? 'weekly' : 'daily',
    enabled: reminder.enabled,
    time: reminder.time,
    weekdays: reminder.frequency === 'weekly' ? [reminder.weekday] : undefined,
    createdAt,
    lastTriggeredAt: reminder.lastNotifiedAt
  };
}

function isReminderDue(job, now = new Date()) {
  const schedule = reminderAsSchedule(job.reminder, job.createdAt);
  return schedule ? isScheduleDue(schedule, now) : false;
}

function nextJobOccurrence(job, now = new Date()) {
  const dates = (job.schedules || [])
    .map((schedule) => nextScheduleOccurrence(schedule, now))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return dates[0] || null;
}

class Scheduler {
  constructor({ store, backupManager, notify, onStateChanged }) {
    this.store = store;
    this.backupManager = backupManager;
    this.notify = notify;
    this.onStateChanged = onStateChanged;
    this.timer = null;
    this.checking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), 30_000);
    setTimeout(() => this.check(), 1_500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(now = new Date()) {
    if (this.checking) return;
    this.checking = true;
    try {
      const snapshot = this.store.snapshot();
      for (const job of snapshot.jobs) {
        if (isReminderDue(job, now)) {
          this.store.updateJob(job.id, (current) => ({
            ...current,
            reminder: { ...current.reminder, lastNotifiedAt: now.toISOString() }
          }));
          this.notify('Rappel de sauvegarde', `Pensez à sauvegarder « ${job.name} ».`);
          this.onStateChanged();
        }

        if (!job.enabled) continue;
        const dueIds = (job.schedules || [])
          .filter((schedule) => isScheduleDue(schedule, now))
          .map((schedule) => schedule.id);
        if (!dueIds.length) continue;

        this.store.updateJob(job.id, (current) => ({
          ...current,
          schedules: current.schedules.map((schedule) => dueIds.includes(schedule.id)
            ? { ...schedule, lastTriggeredAt: now.toISOString() }
            : schedule)
        }));
        this.onStateChanged();
        try {
          await this.backupManager.run(job.id, 'scheduled');
        } catch {
          // Le gestionnaire a déjà enregistré et notifié l’erreur. Une erreur
          // sur un profil ne doit pas arrêter la vérification des suivants.
        }
      }
    } finally {
      this.checking = false;
    }
  }
}

module.exports = {
  Scheduler,
  isScheduleDue,
  nextScheduleOccurrence,
  nextJobOccurrence,
  isReminderDue,
  occurrenceOnDate
};
