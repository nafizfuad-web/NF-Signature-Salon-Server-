// SalonBook — booking window and availability helpers.
//
// All appointment times are handled as minutes from midnight so overlap checks
// are simple integers. The API exposes human-readable labels ("10:00 AM").

export const BOOKING_WINDOW = {
    openMinutes: 10 * 60,
    closeMinutes: 19 * 60,
    slotMinutes: 30,
} as const;

export const MAX_ADVANCE_DAYS = 120;

/** A new booking must start at least this many minutes from now today. */
export const SLOT_LEAD_MINUTES = 30;

export interface BusyInterval {
    startMinutes: number;
    endMinutes: number;
}

export interface AvailableSlot {
    startMinutes: number;
    endMinutes: number;
    label: string;
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

export function formatTimeLabel(totalMinutes: number): string {
    const normalized = ((totalMinutes % 1440) + 1440) % 1440;
    const hours24 = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    const suffix = hours24 >= 12 ? "PM" : "AM";
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    return `${hours12}:${pad2(minutes)} ${suffix}`;
}

export function parseTimeLabel(label: string): number | null {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
    if (!match) return null;

    const hoursPart = match[1];
    const minutesPart = match[2];
    const meridianPart = match[3];
    if (!hoursPart || !minutesPart || !meridianPart) return null;

    let hours = Number(hoursPart);
    const minutes = Number(minutesPart);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;

    const meridian = meridianPart.toUpperCase();
    if (meridian === "PM" && hours !== 12) hours += 12;
    if (meridian === "AM" && hours === 12) hours = 0;

    return hours * 60 + minutes;
}

export function localDateString(date: Date = new Date()): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function isValidDateOnly(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return false;
    return localDateString(parsed) === value;
}

export function currentMinutes(date: Date = new Date()): number {
    return date.getHours() * 60 + date.getMinutes();
}

export function daysFromToday(date: string, now: Date = new Date()): number {
    const todayStart = new Date(`${localDateString(now)}T00:00:00`).getTime();
    const target = new Date(`${date}T00:00:00`).getTime();
    return Math.round((target - todayStart) / 86_400_000);
}

/** Extracts the leading number of minutes from a stored duration such as "45 min". */
export function parseDurationMinutes(duration?: string): number {
    if (!duration) return 60;
    const match = /(\d+)/.exec(duration);
    if (!match) return 60;
    const minutesPart = match[1];
    if (!minutesPart) return 60;
    const minutes = Number(minutesPart);
    if (!Number.isFinite(minutes)) return 60;
    return Math.min(Math.max(Math.round(minutes), 15), 480);
}

/**
 * Computes the bookable start times for a service on a date.
 *
 * Rules enforced here (and re-checked before every insert):
 * - the date is today or within the advance window;
 * - the service fits inside the salon opening hours;
 * - today's slots keep a short lead time;
 * - a slot never overlaps an existing pending/confirmed appointment.
 */
export function buildAvailableSlots(options: {
    durationMinutes: number;
    date: string;
    busy: BusyInterval[];
    now?: Date;
}): AvailableSlot[] {
    const now = options.now ?? new Date();
    const today = localDateString(now);
    const daysAhead = daysFromToday(options.date, now);

    if (daysAhead < 0 || daysAhead > MAX_ADVANCE_DAYS) return [];

    const minimumStart =
        options.date === today ? currentMinutes(now) + SLOT_LEAD_MINUTES : -1;

    const slots: AvailableSlot[] = [];
    for (
        let start = BOOKING_WINDOW.openMinutes;
        start + options.durationMinutes <= BOOKING_WINDOW.closeMinutes;
        start += BOOKING_WINDOW.slotMinutes
    ) {
        const end = start + options.durationMinutes;
        if (start < minimumStart) continue;
        const overlaps = options.busy.some(
            (interval) => start < interval.endMinutes && end > interval.startMinutes,
        );
        if (overlaps) continue;
        slots.push({
            startMinutes: start,
            endMinutes: end,
            label: formatTimeLabel(start),
        });
    }
    return slots;
}

/** True when an appointment's start is clearly in the past (used for cancellation). */
export function hasStarted(date: string, startMinutes: number, now: Date = new Date()): boolean {
    const today = localDateString(now);
    if (date < today) return true;
    if (date > today) return false;
    return startMinutes <= currentMinutes(now);
}
