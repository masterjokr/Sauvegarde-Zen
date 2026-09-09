'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isScheduleDue, nextScheduleOccurrence, isReminderDue } = require('../main/scheduler');

function localDate(day, hour, minute = 0) {
  return new Date(2026, 8, day, hour, minute, 0, 0);
}

test('déclenche un horaire toutes les heures après son intervalle', () => {
  const schedule = {
    type: 'hourly',
    enabled: true,
    everyHours: 2,
    createdAt: '2026-09-03T08:00:00.000Z',
    lastTriggeredAt: null
  };
  assert.equal(isScheduleDue(schedule, new Date('2026-09-03T09:59:59.000Z')), false);
  assert.equal(isScheduleDue(schedule, new Date('2026-09-03T10:00:00.000Z')), true);
});

test('un horaire quotidien ne se déclenche qu’une fois par occurrence', () => {
  const schedule = {
    type: 'daily',
    enabled: true,
    time: '18:00',
    createdAt: localDate(2, 8).toISOString(),
    lastTriggeredAt: localDate(3, 18, 1).toISOString()
  };
  assert.equal(isScheduleDue(schedule, localDate(3, 22)), false);
  assert.equal(isScheduleDue(schedule, localDate(4, 18)), true);
});

test('calcule la prochaine occurrence hebdomadaire', () => {
  const schedule = {
    type: 'weekly',
    enabled: true,
    weekdays: [1, 5],
    time: '09:30',
    createdAt: '2026-09-01T08:00:00.000Z',
    lastTriggeredAt: null
  };
  const next = nextScheduleOccurrence(schedule, new Date('2026-09-03T12:00:00.000Z'));
  assert.equal(next.getDay(), 5);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
});

test('gère un rappel hebdomadaire', () => {
  const job = {
    createdAt: '2026-09-01T08:00:00.000Z',
    reminder: { enabled: true, frequency: 'weekly', weekday: 4, time: '19:00', lastNotifiedAt: null }
  };
  assert.equal(isReminderDue(job, new Date('2026-09-03T19:00:00.000Z')), true);
});
