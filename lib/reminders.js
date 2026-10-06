const { isReminderDue } = require("./time");

function selectDueReminders(database, now, leadHours) {
  const rows = database.prepare(`
    SELECT r.id, r.student_name, r.email, r.reminder_email_status,
           s.date, s.start_time, c.name AS course_name
    FROM registrations r
    JOIN slots s ON s.id = r.slot_id
    JOIN courses c ON c.id = s.course_id
    WHERE r.status = 'confirmed'
      AND r.payment_status IN ('received', 'paid')
      AND r.reminder_sent_at IS NULL
  `).all();
  return rows.filter((row) => isReminderDue({
    date: row.date,
    startTime: row.start_time,
    now,
    leadHours,
  }));
}

module.exports = { selectDueReminders };
