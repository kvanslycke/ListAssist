export interface RapidsEvent {
  hour: number;
  minute: number;
  label: string;
}

export interface RapidsSchedule {
  classNum: number;
  className: string;
  events: RapidsEvent[];
}

const TIME_LINE_RE =
  /^\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)?\s*[—\-–]\s*(.+?)\s*$/i;

export function parseRapidsSchedules(templateContent: string): Map<number, RapidsSchedule> {
  const out = new Map<number, RapidsSchedule>();
  const lines = templateContent.split(/\r?\n/);
  let current: RapidsSchedule | null = null;
  for (const line of lines) {
    const header = line.match(/^##\s+Class\s+(\d)(?:\s*[—\-–]\s*(.+?))?\s*$/i);
    if (header) {
      if (current && current.events.length > 0) out.set(current.classNum, current);
      const num = parseInt(header[1], 10);
      current = {
        classNum: num,
        className: (header[2] || `Class ${num}`).trim(),
        events: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("#")) {
      if (current.events.length > 0) out.set(current.classNum, current);
      current = null;
      continue;
    }
    const m = line.match(TIME_LINE_RE);
    if (!m) continue;
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const ap = m[3]?.toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    if (Number.isNaN(hour) || Number.isNaN(minute)) continue;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
    current.events.push({ hour, minute, label: m[4].trim() });
  }
  if (current && current.events.length > 0) out.set(current.classNum, current);
  return out;
}
