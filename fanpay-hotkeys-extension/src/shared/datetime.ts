/**
 * DateTime & Timezone Utility Module
 * Handles FunPay server timezone (MSK / UTC+3) string parsing
 * and translates periods into the user's local timezone.
 */

const RU_MONTHS: Record<string, number> = {
  'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
  'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
  'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'май': 4, 'июн': 5,
  'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11,
  'січня': 0, 'лютого': 1, 'березня': 2, 'квітня': 3, 'травня': 4, 'червня': 5,
  'липня': 6, 'серпня': 7, 'вересня': 8, 'жовтня': 9, 'листопада': 10, 'грудня': 11,
  'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5,
  'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11,
  'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'jun': 5,
  'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
};

// FunPay displays time in Moscow Time (UTC+3)
const FUNPAY_TZ_OFFSET_HOURS = 3;

/**
 * Parses FunPay date string into Unix epoch timestamp in milliseconds (UTC).
 * Examples:
 * - "сегодня, 15:42"
 * - "вчера, 23:10"
 * - "28 сен 2025, 12:00"
 * - "5 мая, 19:30"
 */
export function parseFunPayDateTimeToTimestamp(dateStr: string, referenceTimeUtc: number = Date.now()): number {
  if (!dateStr || !dateStr.trim()) return referenceTimeUtc;

  const text = dateStr.trim().toLowerCase();
  // Get current date/time in FunPay server timezone (UTC+3)
  const nowServer = new Date(referenceTimeUtc + FUNPAY_TZ_OFFSET_HOURS * 3600 * 1000);
  const nowServerYear = nowServer.getUTCFullYear();
  const nowServerMonth = nowServer.getUTCMonth();
  const nowServerDay = nowServer.getUTCDate();

  try {
    // 1. "сегодня, HH:mm" / "сьогодні, HH:mm" / "today, HH:mm"
    if (text.includes('сегодня') || text.includes('сьогодні') || text.includes('today')) {
      const timePart = text.split(',')[1]?.trim();
      if (timePart) {
        const [h, m] = timePart.split(':').map(Number);
        // Build timestamp in UTC by subtracting the 3 hours offset
        const serverDate = Date.UTC(nowServerYear, nowServerMonth, nowServerDay, h || 0, m || 0);
        return serverDate - FUNPAY_TZ_OFFSET_HOURS * 3600 * 1000;
      }
      return referenceTimeUtc;
    }

    // 2. "вчера, HH:mm" / "вчора, HH:mm" / "yesterday, HH:mm"
    if (text.includes('вчера') || text.includes('вчора') || text.includes('yesterday')) {
      const timePart = text.split(',')[1]?.trim();
      if (timePart) {
        const [h, m] = timePart.split(':').map(Number);
        const yesterdayServer = new Date(Date.UTC(nowServerYear, nowServerMonth, nowServerDay - 1, h || 0, m || 0));
        return yesterdayServer.getTime() - FUNPAY_TZ_OFFSET_HOURS * 3600 * 1000;
      }
      return referenceTimeUtc - 24 * 3600 * 1000;
    }

    // 3. Specific date: "5 мая, 14:00" or "5 мая 2024, 14:00"
    const commaParts = text.split(',');
    const dateSection = commaParts[0]?.trim();
    const timeSection = commaParts[1]?.trim();

    let [h, m] = [0, 0];
    if (timeSection) {
      [h, m] = timeSection.split(':').map(Number);
    }

    if (dateSection) {
      const tokens = dateSection.split(/\s+/);
      const day = parseInt(tokens[0], 10);
      const monthToken = tokens[1]?.toLowerCase().replace(/\./g, '');
      const month = monthToken ? RU_MONTHS[monthToken] : undefined;
      let year = tokens[2] ? parseInt(tokens[2], 10) : nowServerYear;
      // Handle year wrap-around if year is omitted (e.g. order in Dec parsed in Jan)
      if (!tokens[2] && month !== undefined && month > nowServerMonth) {
        year = nowServerYear - 1;
      }

      if (!isNaN(day) && month !== undefined) {
        const utcCandidate = Date.UTC(year, month, day, h || 0, m || 0);
        return utcCandidate - FUNPAY_TZ_OFFSET_HOURS * 3600 * 1000;
      }
    }
  } catch {
    // fallback on error
  }

  return referenceTimeUtc;
}

/**
 * Returns boundaries of user's local day (00:00:00 to 23:59:59)
 */
export function getUserStartOfToday(referenceTime: number = Date.now()): number {
  const d = new Date(referenceTime);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Returns boundary for N days ago in user's local timezone (e.g. 7, 30, 90 days)
 */
export function getUserStartOfDaysAgo(days: number, referenceTime: number = Date.now()): number {
  const d = new Date(referenceTime);
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Format timestamp into user's local localized date & time string
 */
export function formatUserLocalDateTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Format timestamp into short local date "DD.MM"
 */
export function formatShortLocalDate(timestamp: number): string {
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

/**
 * Format milliseconds into HH:MM:SS duration string
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Format timestamp into local HH:MM:SS time string
 */
export function formatTimeOnly(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
