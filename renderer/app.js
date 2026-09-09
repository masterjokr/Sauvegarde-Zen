'use strict';

const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const SHORT_DAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const LOW_SPACE_WARNING_BYTES = 1024 ** 3;
const UPDATE_CHECKED_AT_KEY = 'sauvegarde-zen-update-checked-at';
const DISMISSED_VERSION_KEY = 'sauvegarde-zen-dismissed-version';

const elements = {
  views: document.querySelectorAll('.view'),
  navItems: document.querySelectorAll('.nav-item'),
  summary: document.querySelector('#summary'),
  jobsList: document.querySelector('#jobs-list'),
  historyList: document.querySelector('#history-list'),
  runningBanner: document.querySelector('#running-banner'),
  versionBanner: document.querySelector('#version-banner'),
  versionBannerText: document.querySelector('#version-banner-text'),
  dismissVersionBanner: document.querySelector('#dismiss-version-banner'),
  newJobButton: document.querySelector('#new-job-button'),
  dialog: document.querySelector('#job-dialog'),
  dialogTitle: document.querySelector('#dialog-title'),
  jobForm: document.querySelector('#job-form'),
  jobId: document.querySelector('#job-id'),
  jobName: document.querySelector('#job-name'),
  jobSource: document.querySelector('#job-source'),
  jobDestination: document.querySelector('#job-destination'),
  checkPaths: document.querySelector('#check-paths'),
  pathCheckResult: document.querySelector('#path-check-result'),
  jobEnabled: document.querySelector('#job-enabled'),
  schedulesEditor: document.querySelector('#schedules-editor'),
  jobExclusions: document.querySelector('#job-exclusions'),
  addSchedule: document.querySelector('#add-schedule'),
  reminderEnabled: document.querySelector('#reminder-enabled'),
  reminderOptions: document.querySelector('#reminder-options'),
  reminderFrequency: document.querySelector('#reminder-frequency'),
  reminderDayField: document.querySelector('#reminder-day-field'),
  reminderWeekday: document.querySelector('#reminder-weekday'),
  reminderTime: document.querySelector('#reminder-time'),
  settingsForm: document.querySelector('#settings-form'),
  startWithWindows: document.querySelector('#start-with-windows'),
  minimizeToTray: document.querySelector('#minimize-to-tray'),
  notifyOnCompletion: document.querySelector('#notify-on-completion'),
  updateStatus: document.querySelector('#update-status'),
  updateCheckedAt: document.querySelector('#update-checked-at'),
  checkUpdates: document.querySelector('#check-updates'),
  installUpdate: document.querySelector('#install-update'),
  versionsDialog: document.querySelector('#versions-dialog'),
  versionsDialogTitle: document.querySelector('#versions-dialog-title'),
  versionsBody: document.querySelector('#versions-body'),
  toastRegion: document.querySelector('#toast-region')
};

let state = { jobs: [], history: [], settings: {} };
let schedulesDraft = [];
const progressByJob = new Map();
const pathHealthByJob = new Map();
const expandedHistoryEntries = new Set();
let versionsJobId = null;
let currentAppVersion = null;

function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  });
  children.flat().filter((child) => child !== null && child !== undefined).forEach((child) => {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function formatDate(value, includeTime = true) {
  if (!value) return 'Jamais';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date inconnue';
  const options = includeTime
    ? { dateStyle: 'short', timeStyle: 'short' }
    : { dateStyle: 'short' };
  return new Intl.DateTimeFormat('fr-FR', options).format(date);
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'calcul en cours';
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded} s restantes`;
  const minutes = Math.floor(rounded / 60);
  const secondsLeft = rounded % 60;
  return secondsLeft ? `${minutes} min ${secondsLeft} s restantes` : `${minutes} min restantes`;
}

function formatRunDuration(startedAt, finishedAt) {
  const start = new Date(startedAt).getTime();
  const finish = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return 'Non disponible';
  const seconds = Math.max(0, Math.round((finish - start) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const secondsLeft = seconds % 60;
  return secondsLeft ? `${minutes} min ${secondsLeft} s` : `${minutes} min`;
}

function showToast(message, error = false) {
  const toast = h('div', { className: `toast${error ? ' error' : ''}`, text: message });
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4_500);
}

function scheduleLabel(schedule) {
  if (schedule.type === 'hourly') return schedule.everyHours === 1 ? 'Toutes les heures' : `Toutes les ${schedule.everyHours} h`;
  if (schedule.type === 'daily') return `Chaque jour à ${schedule.time}`;
  const days = schedule.weekdays.map((day) => DAYS[day].slice(0, 3)).join(', ');
  return `${days} à ${schedule.time}`;
}

function statusLabel(result) {
  if (!result) return { label: 'Aucune exécution', className: '' };
  if (result.status === 'success') return { label: 'Réussie', className: '' };
  if (result.status === 'partial') return { label: 'Avec alertes', className: 'partial' };
  return { label: 'Échec', className: 'failed' };
}

function renderPathHealth(job) {
  const health = pathHealthByJob.get(job.id);
  if (!health || health.status === 'checking') {
    return h('div', { className: 'path-health checking', text: '● Vérification des dossiers…' });
  }
  if (health.status === 'failed') {
    return h('div', { className: 'path-health failed', title: health.message, text: `● Dossier inaccessible · ${health.message}` });
  }
  if (health.status === 'warning') {
    return h('div', { className: 'path-health warning', text: `● Accès OK · seulement ${formatBytes(health.freeBytes)} libres` });
  }
  const freeSpace = health.freeBytes == null ? 'espace libre non disponible' : `${formatBytes(health.freeBytes)} libres`;
  return h('div', { className: 'path-health ok', text: `● Accès aux dossiers OK · ${freeSpace}` });
}

async function refreshPathHealth() {
  const jobIds = new Set(state.jobs.map((job) => job.id));
  for (const jobId of pathHealthByJob.keys()) {
    if (!jobIds.has(jobId)) pathHealthByJob.delete(jobId);
  }
  state.jobs.forEach((job) => pathHealthByJob.set(job.id, { status: 'checking' }));
  renderJobs();

  await Promise.allSettled(state.jobs.map(async (job) => {
    try {
      const info = await window.backupAPI.inspectPaths(job.source, job.destination);
      const warning = Number.isFinite(info.freeBytes) && info.freeBytes < LOW_SPACE_WARNING_BYTES;
      pathHealthByJob.set(job.id, {
        status: warning ? 'warning' : 'ok',
        freeBytes: info.freeBytes
      });
    } catch (error) {
      pathHealthByJob.set(job.id, { status: 'failed', message: error.message });
    }
    renderJobs();
  }));
}

function renderSummary() {
  const active = state.jobs.filter((job) => job.enabled).length;
  const running = state.jobs.filter((job) => job.running).length;
  const nextDates = state.jobs.map((job) => job.nextRunAt).filter(Boolean).sort();
  const cards = [
    { icon: '✓', value: active, label: 'sauvegarde(s) active(s)' },
    { icon: '↻', value: running, label: 'exécution(s) en cours' },
    { icon: '◷', value: nextDates[0] ? formatDate(nextDates[0]) : 'Non planifiée', label: 'prochaine exécution' }
  ];
  elements.summary.replaceChildren(...cards.map((card) => h('div', { className: 'summary-card' },
    h('div', { className: 'summary-icon', text: card.icon }),
    h('div', {}, h('strong', { text: card.value }), h('span', { text: card.label }))
  )));
}

function renderJobs() {
  if (!state.jobs.length) {
    elements.jobsList.replaceChildren(h('div', { className: 'empty-state' },
      h('div', { className: 'empty-icon', text: '⇄' }),
      h('h3', { text: 'Créez votre première sauvegarde' }),
      h('p', { text: 'Choisissez un dossier source, une destination et vos horaires.' }),
      h('button', { className: 'primary-button', type: 'button', onClick: () => openJobDialog(), text: '＋ Nouvelle sauvegarde' })
    ));
    return;
  }

  elements.jobsList.replaceChildren(...state.jobs.map((job) => {
    const badgeClass = job.running ? ' running' : job.enabled ? '' : ' off';
    const badgeText = job.running ? 'En cours' : job.enabled ? 'Active' : 'En pause';
    const chips = job.schedules.length
      ? job.schedules.map((schedule) => h('span', { className: 'schedule-chip', text: scheduleLabel(schedule) }))
      : [h('span', { className: 'schedule-chip', text: 'Manuelle uniquement' })];

    const runButton = h('button', {
      className: 'primary-button run-job',
      type: 'button',
      disabled: job.running ? 'disabled' : null,
      onClick: () => runJob(job.id),
      text: job.running ? 'Sauvegarde…' : '▶ Lancer la sauvegarde'
    });
    const editButton = h('button', { className: 'secondary-button', type: 'button', onClick: () => openJobDialog(job), text: 'Modifier' });
    const versionsButton = h('button', { className: 'secondary-button', type: 'button', onClick: () => openVersionsDialog(job), text: 'Anciens fichiers' });
    const openButton = h('button', { className: 'secondary-button', type: 'button', onClick: () => openDestination(job), text: 'Ouvrir' });
    const toggleButton = h('button', {
      className: 'secondary-button',
      type: 'button',
      onClick: () => toggleJob(job),
      text: job.enabled ? 'Mettre en pause' : 'Activer'
    });
    const deleteButton = h('button', { className: 'danger-button', type: 'button', onClick: () => deleteJob(job), text: 'Supprimer' });

    return h('article', { className: 'job-card' },
      h('div', { className: 'job-main' },
        h('div', {},
          h('div', { className: 'job-title-line' },
            h('h3', { text: job.name }),
            h('span', { className: `state-badge${badgeClass}`, text: badgeText })
          ),
          h('div', { className: 'paths' },
            h('div', { className: 'path-line' }, h('strong', { text: 'Source' }), h('code', { title: job.source, text: job.source })),
            h('div', { className: 'path-line' }, h('strong', { text: 'Destination' }), h('code', { title: job.destination, text: job.destination })),
            h('div', { className: 'path-line' }, h('strong', { text: 'Dernière' }), h('span', { text: formatDate(job.lastRunAt) }))
          ),
          renderPathHealth(job)
        ),
        h('div', { className: 'job-actions' }, runButton, versionsButton, openButton, editButton, toggleButton, deleteButton)
      ),
      h('div', { className: 'job-footer' },
        h('div', { className: 'schedule-list' }, ...chips),
        h('span', { className: 'next-run', text: job.nextRunAt ? `Prochaine : ${formatDate(job.nextRunAt)}` : 'Aucune exécution automatique' })
      )
    );
  }));
}

function renderHistory() {
  if (!state.history.length) {
    elements.historyList.replaceChildren(h('div', { className: 'empty-state' },
      h('div', { className: 'empty-icon', text: '↻' }),
      h('h3', { text: 'Aucune sauvegarde exécutée' }),
      h('p', { text: 'Les résultats apparaîtront ici après la première exécution.' })
    ));
    return;
  }
  elements.historyList.replaceChildren(...state.history.map((entry) => {
    const status = statusLabel(entry);
    const entryId = entry.id || `${entry.jobId}-${entry.finishedAt}`;
    const expanded = expandedHistoryEntries.has(entryId);
    const errors = Array.isArray(entry.errors) ? entry.errors : [];
    const totalFiles = Number(entry.totalFiles || 0);
    const details = h('div', { className: `history-details${expanded ? '' : ' hidden'}` },
      h('div', { className: 'history-details-grid' },
        h('div', { className: 'history-detail' }, h('span', { text: 'Durée' }), h('strong', { text: formatRunDuration(entry.startedAt, entry.finishedAt) })),
        h('div', { className: 'history-detail' }, h('span', { text: 'Fichiers analysés' }), h('strong', { text: totalFiles || (entry.copied || 0) + (entry.updated || 0) + (entry.skipped || 0) })),
        h('div', { className: 'history-detail' }, h('span', { text: 'Fichiers exclus' }), h('strong', { text: entry.excluded || 0 })),
        h('div', { className: 'history-detail' }, h('span', { text: 'Dossiers créés' }), h('strong', { text: entry.directoriesCreated || 0 })),
        h('div', { className: 'history-detail' }, h('span', { text: 'Espace avant' }), h('strong', { text: entry.freeBytesBefore == null ? 'Non disponible' : formatBytes(entry.freeBytesBefore) })),
        h('div', { className: 'history-detail' }, h('span', { text: 'Espace après' }), h('strong', { text: entry.freeBytesAfter == null ? 'Non disponible' : formatBytes(entry.freeBytesAfter) }))
      ),
      entry.message ? h('p', { className: 'history-message', text: entry.message }) : null,
      errors.length ? h('div', { className: 'history-errors' },
        h('strong', { text: `${errors.length} erreur(s) enregistrée(s)` }),
        h('ul', {}, ...errors.slice(0, 20).map((error) => h('li', {},
          h('code', { text: error.path || 'Élément inconnu' }),
          h('span', { text: error.message || 'Erreur inconnue' })
        ))),
        errors.length > 20 ? h('small', { text: `${errors.length - 20} autre(s) erreur(s) non affichée(s).` }) : null
      ) : h('p', { className: 'history-message success', text: 'Aucune erreur enregistrée pour cette exécution.' })
    );
    const toggleDetails = h('button', {
      className: 'secondary-button history-toggle',
      type: 'button',
      text: expanded ? 'Masquer' : 'Détails',
      onClick: () => {
        if (expanded) expandedHistoryEntries.delete(entryId);
        else expandedHistoryEntries.add(entryId);
        renderHistory();
      }
    });
    return h('article', { className: 'history-entry' },
      h('div', { className: 'history-overview' },
        h('div', {},
          h('strong', { text: entry.jobName }),
          h('small', { text: `${formatDate(entry.finishedAt)} · ${entry.trigger === 'scheduled' ? 'Automatique' : entry.trigger === 'restore' ? 'Restauration' : 'Manuelle'}` })
        ),
        h('div', { className: 'history-stats' },
          h('span', { text: `${entry.copied || 0} nouveau(x)` }),
          h('span', { text: `${entry.updated || 0} modifié(s)` }),
          h('span', { text: `${entry.archived || 0} archivé(s)` }),
          h('span', { text: `${entry.skipped || 0} inchangé(s)` }),
          h('span', { text: formatBytes(entry.bytesCopied) })
        ),
        h('div', { className: 'history-result' },
          h('span', { className: `result-badge ${status.className}`, title: entry.message || '', text: status.label }),
          toggleDetails
        )
      ),
      details
    );
  }));
}

function renderRunningBanner() {
  const runningJobs = state.jobs.filter((job) => job.running);
  if (!runningJobs.length) {
    elements.runningBanner.classList.add('hidden');
    return;
  }
  const parts = runningJobs.map((job) => {
    const progress = progressByJob.get(job.id);
    if (!progress) return `${job.name} est en cours…`;
    if (progress.phase === 'indexing') return `${job.name} : analyse des fichiers…`;
    const total = Number(progress.totalFiles || 0);
    const processed = Number(progress.processedFiles || 0);
    const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const eta = progress.etaSeconds ? ` · ${formatDuration(progress.etaSeconds)}` : '';
    return `${job.name} : ${percent}% · ${processed}/${total} fichier(s) · ${progress.copied} nouveau(x), ${progress.updated} modifié(s)${eta}`;
  });
  elements.runningBanner.textContent = parts.join(' · ');
  elements.runningBanner.classList.remove('hidden');
}

function renderSettings() {
  elements.startWithWindows.checked = Boolean(state.settings.startWithWindows);
  elements.minimizeToTray.checked = state.settings.minimizeToTray !== false;
  elements.notifyOnCompletion.checked = state.settings.notifyOnCompletion !== false;
}

function render() {
  renderSummary();
  renderJobs();
  renderHistory();
  renderRunningBanner();
  renderSettings();
}

function showView(viewName) {
  elements.navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
  elements.views.forEach((view) => view.classList.toggle('active', view.id === `${viewName}-view`));
}

function makeScheduleDraft(schedule = {}) {
  return {
    id: schedule.id || globalThis.crypto?.randomUUID?.() || `schedule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: schedule.type || 'hourly',
    enabled: schedule.enabled !== false,
    everyHours: schedule.everyHours || 1,
    time: schedule.time || '18:00',
    weekdays: Array.isArray(schedule.weekdays) && schedule.weekdays.length ? [...schedule.weekdays] : [6]
  };
}

function renderScheduleEditor() {
  if (!schedulesDraft.length) {
    elements.schedulesEditor.replaceChildren(h('div', { className: 'empty-state' },
      h('p', { text: 'Aucun horaire : cette sauvegarde restera disponible en mode manuel.' })
    ));
    return;
  }

  elements.schedulesEditor.replaceChildren(...schedulesDraft.map((schedule) => {
    const typeSelect = h('select', { 'data-field': 'type' },
      h('option', { value: 'hourly', text: 'Toutes les X heures' }),
      h('option', { value: 'daily', text: 'Tous les jours' }),
      h('option', { value: 'weekly', text: 'Chaque semaine' })
    );
    typeSelect.value = schedule.type;
    typeSelect.addEventListener('change', (event) => {
      schedule.type = event.target.value;
      renderScheduleEditor();
    });

    let fields;
    if (schedule.type === 'hourly') {
      const input = h('input', { type: 'number', min: '1', max: '168', value: schedule.everyHours });
      input.addEventListener('input', (event) => { schedule.everyHours = Number(event.target.value); });
      fields = h('div', { className: 'schedule-fields' },
        h('label', { className: 'field' }, h('span', { text: 'Intervalle (heures)' }), input)
      );
    } else if (schedule.type === 'daily') {
      const input = h('input', { type: 'time', value: schedule.time });
      input.addEventListener('input', (event) => { schedule.time = event.target.value; });
      fields = h('div', { className: 'schedule-fields' },
        h('label', { className: 'field' }, h('span', { text: 'Heure' }), input)
      );
    } else {
      const dayChecks = SHORT_DAYS.map((label, day) => {
        const checkbox = h('input', { type: 'checkbox', value: String(day) });
        checkbox.checked = schedule.weekdays.includes(day);
        checkbox.addEventListener('change', () => {
          schedule.weekdays = checkbox.checked
            ? [...new Set([...schedule.weekdays, day])].sort()
            : schedule.weekdays.filter((value) => value !== day);
        });
        return h('label', { className: 'day-check', title: DAYS[day] }, checkbox, h('span', { text: label }));
      });
      const input = h('input', { type: 'time', value: schedule.time });
      input.addEventListener('input', (event) => { schedule.time = event.target.value; });
      fields = h('div', { className: 'schedule-fields' },
        h('label', { className: 'field' }, h('span', { text: 'Jours' }), h('div', { className: 'weekdays' }, ...dayChecks)),
        h('label', { className: 'field' }, h('span', { text: 'Heure' }), input)
      );
    }

    return h('div', { className: 'schedule-row', 'data-id': schedule.id },
      h('label', { className: 'field' }, h('span', { text: 'Type' }), typeSelect),
      fields,
      h('button', {
        className: 'remove-schedule',
        type: 'button',
        title: 'Supprimer cet horaire',
        onClick: () => {
          schedulesDraft = schedulesDraft.filter((item) => item.id !== schedule.id);
          renderScheduleEditor();
        },
        text: '×'
      })
    );
  }));
}

function fillWeekdays() {
  elements.reminderWeekday.replaceChildren(...DAYS.map((day, index) => h('option', { value: index, text: day })));
}

function refreshReminderOptions() {
  elements.reminderOptions.classList.toggle('hidden', !elements.reminderEnabled.checked);
  elements.reminderDayField.classList.toggle('hidden', elements.reminderFrequency.value !== 'weekly');
}

function openJobDialog(job = null) {
  elements.jobForm.reset();
  elements.dialogTitle.textContent = job ? 'Modifier la sauvegarde' : 'Nouvelle sauvegarde';
  elements.jobId.value = job?.id || '';
  elements.jobName.value = job?.name || '';
  elements.jobSource.value = job?.source || '';
  elements.jobDestination.value = job?.destination || '';
  elements.jobExclusions.value = Array.isArray(job?.exclusions) ? job.exclusions.join('\n') : '';
  elements.jobEnabled.checked = job?.enabled !== false;
  schedulesDraft = job?.schedules?.map(makeScheduleDraft) || [makeScheduleDraft()];
  elements.reminderEnabled.checked = Boolean(job?.reminder?.enabled);
  elements.reminderFrequency.value = job?.reminder?.frequency || 'weekly';
  elements.reminderWeekday.value = String(job?.reminder?.weekday ?? 6);
  elements.reminderTime.value = job?.reminder?.time || '18:00';
  renderScheduleEditor();
  refreshReminderOptions();
  elements.pathCheckResult.textContent = '';
  elements.pathCheckResult.className = 'path-check-result';
  elements.dialog.showModal();
  elements.jobName.focus();
}

function closeJobDialog() {
  elements.dialog.close();
}

async function chooseFolder(targetId) {
  try {
    const result = await window.backupAPI.selectDirectory();
    if (!result.canceled && result.path) {
      document.querySelector(`#${targetId}`).value = result.path;
      elements.pathCheckResult.textContent = '';
      elements.pathCheckResult.className = 'path-check-result';
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

async function checkPaths() {
  const source = elements.jobSource.value.trim();
  const destination = elements.jobDestination.value.trim();
  if (!source || !destination) {
    elements.pathCheckResult.className = 'path-check-result error';
    elements.pathCheckResult.textContent = 'Choisissez d’abord les deux dossiers.';
    return;
  }
  elements.checkPaths.disabled = true;
  elements.pathCheckResult.className = 'path-check-result';
  elements.pathCheckResult.textContent = 'Vérification…';
  try {
    const info = await window.backupAPI.inspectPaths(source, destination);
    const drives = info.differentDrives
      ? `${info.sourceDrive} → ${info.destinationDrive}`
      : `Même disque (${info.destinationDrive})`;
    const freeSpace = info.freeBytes === null ? 'espace libre indisponible' : `${formatBytes(info.freeBytes)} libres`;
    elements.pathCheckResult.className = 'path-check-result ok';
    elements.pathCheckResult.textContent = `Accès OK · ${drives} · ${freeSpace}`;
  } catch (error) {
    elements.pathCheckResult.className = 'path-check-result error';
    elements.pathCheckResult.textContent = error.message;
  } finally {
    elements.checkPaths.disabled = false;
  }
}

function validateSchedules() {
  for (const schedule of schedulesDraft) {
    if (schedule.type === 'hourly' && (!Number.isInteger(schedule.everyHours) || schedule.everyHours < 1 || schedule.everyHours > 168)) {
      throw new Error('L’intervalle doit être compris entre 1 et 168 heures.');
    }
    if (schedule.type === 'weekly' && !schedule.weekdays.length) {
      throw new Error('Choisissez au moins un jour pour chaque horaire hebdomadaire.');
    }
  }
}

async function saveJob(event) {
  event.preventDefault();
  try {
    validateSchedules();
    const job = {
      id: elements.jobId.value || null,
      name: elements.jobName.value,
      source: elements.jobSource.value,
      destination: elements.jobDestination.value,
      enabled: elements.jobEnabled.checked,
      schedules: schedulesDraft,
      exclusions: elements.jobExclusions.value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
      reminder: {
        enabled: elements.reminderEnabled.checked,
        frequency: elements.reminderFrequency.value,
        weekday: Number(elements.reminderWeekday.value),
        time: elements.reminderTime.value
      }
    };
    await window.backupAPI.saveJob(job);
    closeJobDialog();
    await refreshState();
    await refreshPathHealth();
    showToast('Sauvegarde enregistrée.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function runJob(jobId) {
  try {
    progressByJob.delete(jobId);
    const localJob = state.jobs.find((job) => job.id === jobId);
    if (localJob) localJob.running = true;
    render();
    await window.backupAPI.runJob(jobId);
    showToast('Sauvegarde terminée.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    await refreshState();
    await refreshPathHealth();
  }
}

async function toggleJob(job) {
  try {
    await window.backupAPI.toggleJob(job.id, !job.enabled);
    await refreshState();
    showToast(job.enabled ? 'Sauvegarde mise en pause.' : 'Sauvegarde activée.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteJob(job) {
  if (!confirm(`Supprimer « ${job.name} » et son historique dans l’application ?\n\nLes fichiers déjà sauvegardés ne seront pas supprimés.`)) return;
  try {
    await window.backupAPI.deleteJob(job.id);
    await refreshState();
    showToast('Configuration supprimée. Les fichiers sauvegardés sont conservés.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    await window.backupAPI.saveSettings({
      startWithWindows: elements.startWithWindows.checked,
      minimizeToTray: elements.minimizeToTray.checked,
      notifyOnCompletion: elements.notifyOnCompletion.checked
    });
    await refreshState();
    showToast('Réglages enregistrés.');
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderVersions(job, data) {
  if (!data.runs.length) {
    elements.versionsBody.replaceChildren(
      h('p', { className: 'version-empty', text: 'Aucun fichier remplacé n’est conservé pour le moment.' })
    );
    return;
  }

  const intro = h('p', {
    className: 'versions-intro',
    text: `Ce ne sont pas des copies complètes du projet : seuls les fichiers remplacés sont archivés. La destination principale contient toujours la version actuelle complète. Les ${data.maxRuns} dernières séries de modifications sont conservées.`
  });
  const cards = data.runs.map((run) => {
    const files = run.files.length
      ? h('div', { className: 'version-files' }, ...run.files.map((file) => h('div', { className: 'version-file' },
        h('code', { title: file.path, text: file.path }),
        h('span', { className: 'version-file-meta' },
          h('span', { text: formatBytes(file.size) }),
          h('button', {
            className: 'secondary-button',
            type: 'button',
            onClick: () => restoreArchivedFile(job, run, file),
            text: 'Restaurer'
          })
        )
      )))
      : h('div', { className: 'version-empty', text: 'Cette version ne contient plus de fichier.' });
    return h('section', { className: 'version-card' },
      h('div', { className: 'version-header' },
        h('div', {},
          h('strong', { text: formatDate(run.createdAt) }),
          h('small', { text: `${run.fileCount} ancien(s) fichier(s) · ${formatBytes(run.bytes)}` })
        ),
        h('span', { className: 'schedule-chip', text: run.id })
      ),
      files
    );
  });
  elements.versionsBody.replaceChildren(intro, ...cards);
}

async function loadVersions(job) {
  elements.versionsDialogTitle.textContent = `Fichiers archivés · ${job.name}`;
  elements.versionsBody.replaceChildren(h('p', { className: 'versions-intro', text: 'Chargement…' }));
  try {
    const data = await window.backupAPI.getVersions(job.id);
    if (versionsJobId === job.id) renderVersions(job, data);
  } catch (error) {
    elements.versionsBody.replaceChildren(h('p', { className: 'version-empty', text: error.message }));
  }
}

function openVersionsDialog(job) {
  versionsJobId = job.id;
  elements.versionsDialogTitle.textContent = `Fichiers archivés · ${job.name}`;
  elements.versionsDialog.showModal();
  loadVersions(job);
}

async function restoreArchivedFile(job, run, file) {
  if (!confirm(`Restaurer « ${file.path} » dans le dossier de destination ?\n\nLa version actuelle sera conservée automatiquement dans une zone de sécurité.`)) return;
  try {
    await window.backupAPI.restoreFile(job.id, run.id, file.path);
    showToast(`Fichier restauré : ${file.path}`);
    await refreshState();
    const currentJob = state.jobs.find((item) => item.id === job.id);
    if (currentJob && elements.versionsDialog.open) await loadVersions(currentJob);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function openDestination(job) {
  try {
    const result = await window.backupAPI.openDestination(job.id);
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderUpdateCheckedAt(value = localStorage.getItem(UPDATE_CHECKED_AT_KEY)) {
  if (!elements.updateCheckedAt) return;
  elements.updateCheckedAt.textContent = value
    ? `Dernière vérification : ${formatDate(value)}`
    : 'Dernière vérification : jamais';
}

function markUpdateChecked() {
  const checkedAt = new Date().toISOString();
  localStorage.setItem(UPDATE_CHECKED_AT_KEY, checkedAt);
  renderUpdateCheckedAt(checkedAt);
}

function showVersionBanner(version) {
  if (!elements.versionBanner || localStorage.getItem(DISMISSED_VERSION_KEY) === version) return;
  elements.versionBannerText.textContent = `Mise à jour réussie : vous utilisez maintenant Sauvegarde Zen ${version}.`;
  elements.versionBanner.classList.remove('hidden');
  localStorage.setItem(DISMISSED_VERSION_KEY, version);
}

function renderUpdateStatus(payload) {
  const status = payload?.status;
  if (!elements.updateStatus) return;
  elements.installUpdate.classList.toggle('hidden', status !== 'downloaded');
  if (status === 'development') {
    elements.updateStatus.textContent = `Version installée : ${currentAppVersion || 'inconnue'} · mises à jour disponibles après installation.`;
  } else if (status === 'checking') {
    elements.updateStatus.textContent = `Version installée : ${currentAppVersion || 'inconnue'} · recherche sur GitHub…`;
  } else if (status === 'available') {
    elements.updateStatus.textContent = `Installée : ${currentAppVersion || 'inconnue'} · disponible : ${payload.version} · téléchargement…`;
    markUpdateChecked();
  } else if (status === 'downloading') {
    elements.updateStatus.textContent = `Installée : ${currentAppVersion || 'inconnue'} · téléchargement de ${payload.version || 'la mise à jour'} : ${payload.percent || 0} %`;
  } else if (status === 'downloaded') {
    elements.updateStatus.textContent = `Installée : ${currentAppVersion || 'inconnue'} · version ${payload.version} prête à être installée.`;
    markUpdateChecked();
  } else if (status === 'not-available') {
    elements.updateStatus.textContent = `Version installée : ${currentAppVersion || payload.version || 'inconnue'} · vous êtes à jour.`;
    markUpdateChecked();
  } else if (status === 'error') {
    elements.updateStatus.textContent = `Version installée : ${currentAppVersion || 'inconnue'} · vérification impossible : ${payload.message}`;
    markUpdateChecked();
  } else {
    elements.updateStatus.textContent = `Version installée : ${currentAppVersion || 'inconnue'} · mises à jour automatiques actives.`;
  }
}

async function checkForUpdates() {
  elements.checkUpdates.disabled = true;
  renderUpdateStatus({ status: 'checking' });
  try {
    const result = await window.backupAPI.checkForUpdates();
    if (result?.status === 'development') renderUpdateStatus(result);
  } catch (error) {
    renderUpdateStatus({ status: 'error', message: error.message });
  } finally {
    elements.checkUpdates.disabled = false;
  }
}

async function installUpdate() {
  try {
    await window.backupAPI.installUpdate();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function refreshState() {
  state = await window.backupAPI.getState();
  render();
}

function bindEvents() {
  elements.navItems.forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
  elements.newJobButton.addEventListener('click', () => openJobDialog());
  document.querySelector('#close-dialog').addEventListener('click', closeJobDialog);
  document.querySelector('#cancel-dialog').addEventListener('click', closeJobDialog);
  document.querySelectorAll('.choose-folder').forEach((button) => button.addEventListener('click', () => chooseFolder(button.dataset.target)));
  elements.addSchedule.addEventListener('click', () => {
    if (schedulesDraft.length >= 10) return showToast('Maximum 10 horaires par sauvegarde.', true);
    schedulesDraft.push(makeScheduleDraft());
    renderScheduleEditor();
  });
  elements.checkPaths.addEventListener('click', checkPaths);
  elements.reminderEnabled.addEventListener('change', refreshReminderOptions);
  elements.reminderFrequency.addEventListener('change', refreshReminderOptions);
  elements.jobForm.addEventListener('submit', saveJob);
  elements.settingsForm.addEventListener('submit', saveSettings);
  elements.checkUpdates.addEventListener('click', checkForUpdates);
  elements.installUpdate.addEventListener('click', installUpdate);
  elements.dismissVersionBanner.addEventListener('click', () => elements.versionBanner.classList.add('hidden'));
  elements.dialog.addEventListener('click', (event) => {
    if (event.target === elements.dialog) closeJobDialog();
  });
  document.querySelector('#close-versions-dialog').addEventListener('click', () => elements.versionsDialog.close());
  document.querySelector('#cancel-versions-dialog').addEventListener('click', () => elements.versionsDialog.close());
  elements.versionsDialog.addEventListener('click', (event) => {
    if (event.target === elements.versionsDialog) elements.versionsDialog.close();
  });
  window.backupAPI.onEvent((event) => {
    if (event.type === 'backup-progress') {
      progressByJob.set(event.payload.jobId, event.payload);
      renderRunningBanner();
    } else if (event.type === 'update-status') {
      renderUpdateStatus(event.payload);
    } else if (event.type === 'backup-started') {
      const job = state.jobs.find((item) => item.id === event.payload.jobId);
      if (job) job.running = true;
      render();
    } else if (event.type === 'backup-finished' || event.type === 'backup-failed' || event.type === 'state' || event.type === 'state-changed') {
      refreshState()
        .then(() => refreshPathHealth())
        .catch((error) => showToast(error.message, true));
    }
  });
}

async function init() {
  fillWeekdays();
  bindEvents();
  try {
    const version = await window.backupAPI.getAppVersion();
    currentAppVersion = version;
    const versionElement = document.querySelector('#app-version');
    if (versionElement) versionElement.textContent = `Version ${version}`;
    renderUpdateStatus({ status: 'idle' });
    renderUpdateCheckedAt();
    showVersionBanner(version);
    await refreshState();
    await refreshPathHealth();
    setInterval(() => refreshPathHealth().catch(() => {}), 5 * 60 * 1000);
  } catch (error) {
    showToast(`Impossible de charger l’application : ${error.message}`, true);
  }
}

init();
