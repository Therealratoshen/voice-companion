/**
 * Reminder / Scheduler Tool
 * Schedules reminders with in-memory store.
 * For production: replace with Redis + job queue.
 *
 * Supports:
 * - "Ingatkan saya jam 3 sore untuk..."
 * - "Bangunin saya jam 7 pagi"
 * - "Remind me in 30 minutes to call mom"
 */

const { setTimeout } = require("timers/promises");

// In-memory reminder store: id → { userId, text, time, createdAt, fired }
const reminders = new Map();
const callbackRegistry = new Map(); // userId → [callback functions]

let cleanupTimer = null;

// ── Parse natural language time ───────────────────────────────────────────
function parseTime(input) {
  const now = new Date();
  const inputLower = input.toLowerCase();

  // "jam X" or "pukul X" (24h Indonesian)
  const jamMatch = inputLower.match(/jam\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:pagi|siang|sore|malam)?/);
  if (jamMatch) {
    let hours = parseInt(jamMatch[1]);
    const mins = jamMatch[2] ? parseInt(jamMatch[2]) : 0;
    const period = inputLower.includes("pagi") ? "pagi" :
                  inputLower.includes("sore") ? "sore" :
                  inputLower.includes("malam") ? "malam" :
                  inputLower.includes("siang") ? "siang" : null;
    if (period === "pagi" && hours < 12) hours = hours;
    if (period === "sore" && hours < 12) hours += 12;
    if (period === "malam" && hours < 12) hours += 12;
    const time = new Date(now);
    time.setHours(hours, mins, 0, 0);
    if (time < now) time.setDate(time.getDate() + 1);
    return time;
  }

  // "in X minutes/hours" (English)
  const minsMatch = inputLower.match(/in\s*(\d+)\s*(minutes?|mins?|menit)/i);
  if (minsMatch) {
    return new Date(now.getTime() + parseInt(minsMatch[1]) * 60 * 1000);
  }

  const hoursMatch = inputLower.match(/in\s*(\d+)\s*(hours?|jam)/i);
  if (hoursMatch) {
    return new Date(now.getTime() + parseInt(hoursMatch[1]) * 60 * 60 * 1000);
  }

  // "besok jam X"
  if (inputLower.includes("besok")) {
    const jamMatch2 = inputLower.match(/jam\s*(\d{1,2})(?:[:.](\d{2}))?/);
    if (jamMatch2) {
      const time = new Date(now);
      time.setDate(time.getDate() + 1);
      time.setHours(parseInt(jamMatch2[1]), jamMatch2[2] ? parseInt(jamMatch2[2]) : 0, 0, 0);
      return time;
    }
  }

  return null;
}

/**
 * Extract reminder text from input.
 * Input: "Ingatkan saya jam 3 sore untuk meeting dengan Budi"
 * Output: { time: Date, reminderText: "meeting dengan Budi" }
 */
function extractReminderParts(input) {
  const timePatterns = [
    /jam\s*\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|siang|sore|malam)?/i,
    /pukul\s*\d{1,2}(?:[:.]\d{2})?/i,
    /in\s*\d+\s*(minutes?|mins?|hours?|jam|menit)/i,
    /besok/i,
  ];

  let timeStr = "";
  let reminderText = input;

  for (const pattern of timePatterns) {
    const match = input.match(pattern);
    if (match) {
      timeStr = match[0];
      reminderText = input.replace(pattern, "").replace(/untuk\s+/i, "").replace(/supaya\s+/i, "").trim();
      break;
    }
  }

  const time = parseTime(timeStr || input);
  return { time, reminderText: reminderText || input };
}

// ── Create reminder ───────────────────────────────────────────────────────
function createReminder(userId, text) {
  const { time, reminderText } = extractReminderParts(text);

  if (!time) {
    return { success: false, error: "Tidak bisa memahami waktu. Coba: 'Ingatkan saya jam 3 sore untuk...'" };
  }

  const id = `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const reminder = {
    id,
    userId,
    text: reminderText,
    time,
    createdAt: new Date(),
    fired: false,
  };

  reminders.set(id, reminder);
  scheduleReminder(reminder);

  const timeStr = formatTime(time);
  return {
    success: true,
    reminder: {
      id,
      text: reminderText,
      time: timeStr,
      in: formatTimeUntil(time),
    },
  };
}

function scheduleReminder(reminder) {
  const delay = reminder.time.getTime() - Date.now();
  if (delay < 0) return;

  setTimeout(delay, null, { ref: false }).then(() => {
    const r = reminders.get(reminder.id);
    if (r && !r.fired) {
      r.fired = true;
      fireReminder(r);
    }
  }).catch(console.error);
}

function fireReminder(reminder) {
  const cbs = callbackRegistry.get(reminder.userId) || [];
  for (const cb of cbs) {
    try { cb(reminder); } catch (err) { console.error("[Reminder] callback error:", err); }
  }
  console.log(`[Reminder] Fired for ${reminder.userId}: "${reminder.text}"`);
}

// ── List reminders ─────────────────────────────────────────────────────────
function listReminders(userId) {
  const userReminders = [];
  for (const [, r] of reminders) {
    if (r.userId === userId && !r.fired) {
      userReminders.push({
        id: r.id,
        text: r.text,
        time: formatTime(r.time),
        in: formatTimeUntil(r.time),
      });
    }
  }
  return userReminders.sort((a, b) => new Date(a.time) - new Date(b.time));
}

// ── Cancel reminder ───────────────────────────────────────────────────────
function cancelReminder(userId, id) {
  const r = reminders.get(id);
  if (!r) return { success: false, error: "Reminder tidak ditemukan" };
  if (r.userId !== userId) return { success: false, error: "Tidak berhak membatalkan reminder ini" };
  r.fired = true;
  return { success: true };
}

// ── Register callback ──────────────────────────────────────────────────────
function onReminderFire(userId, callback) {
  if (!callbackRegistry.has(userId)) callbackRegistry.set(userId, []);
  callbackRegistry.get(userId).push(callback);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function formatTime(date) {
  return date.toLocaleString("id-ID", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function formatTimeUntil(date) {
  const diff = date.getTime() - Date.now();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} hari lagi`;
  if (hours > 0) return `${hours} jam lagi`;
  return `${mins} menit lagi`;
}

// Cleanup old reminders every hour
function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h old
    for (const [id, r] of reminders) {
      if (r.fired && r.createdAt < cutoff) reminders.delete(id);
    }
  }, 60 * 60 * 1000);
}

module.exports = {
  createReminder,
  listReminders,
  cancelReminder,
  onReminderFire,
  parseTime,
  extractReminderParts,
  startCleanup,
};
