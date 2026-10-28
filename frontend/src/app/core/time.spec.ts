import { formatClock, formatDuration, formatHms, isFullClock, parseClock, parseHms, stepClock } from './time';

const t = parseHms;

describe('parseHms and formatHms', () => {
  it('convert between text and seconds', () => {
    expect(parseHms('08:01:30')).toBe(28890);
    expect(formatHms(28890)).toBe('08:01:30');
  });

  it('allow hours past 24 for flagged arrivals', () => {
    expect(formatHms(86400 + 220)).toBe('24:03:40');
    expect(parseHms('24:03:40')).toBe(86620);
  });
});

describe('parseClock', () => {
  it('reads a typed 24-hour time, with or without seconds', () => {
    expect(parseClock('13:05:30')).toBe(parseHms('13:05:30'));
    expect(parseClock('13:05')).toBe(parseHms('13:05:00'));
    expect(parseClock(' 8:05 ')).toBe(parseHms('08:05:00'));
    expect(parseClock('00:00:00')).toBe(0);
    expect(parseClock('23:59:59')).toBe(86399);
  });

  it('rejects anything that is not a time of day', () => {
    for (const text of ['24:00:00', '12:60:00', '12:00:60', '1:5', '1pm', '12:00 PM', '', '08:00:00:00']) {
      expect(parseClock(text)).toBeNull();
    }
  });
});

describe('isFullClock', () => {
  it('accepts only a time typed in full', () => {
    expect(isFullClock('08:05:00')).toBe(true);
    expect(isFullClock('08:05')).toBe(false);
    expect(isFullClock('08:05:0')).toBe(false);
    expect(isFullClock('25:00:00')).toBe(false);
  });
});

describe('stepClock', () => {
  const step = (text: string, caret: number, delta: 1 | -1) => stepClock(text, caret, delta, t('08:00:00'));

  it('changes the part the cursor is in', () => {
    expect(step('08:30:15', 1, 1)).toEqual({ seconds: t('09:30:15'), text: '09:30:15', selection: [0, 2] });
    expect(step('08:30:15', 4, -1)).toEqual({ seconds: t('08:29:15'), text: '08:29:15', selection: [3, 5] });
    expect(step('08:30:15', 8, 1)).toEqual({ seconds: t('08:30:16'), text: '08:30:16', selection: [6, 8] });
  });

  it('carries into the next part', () => {
    expect(step('08:59:59', 7, 1)?.text).toBe('09:00:00');
    expect(step('09:00:00', 4, -1)?.text).toBe('08:59:00');
  });

  it('stays within one day, 24-hour', () => {
    expect(step('23:30:00', 0, 1)?.text).toBe('23:59:59');
    expect(step('00:00:30', 4, -1)?.text).toBe('00:00:00');
    expect(step('12:00:00', 0, 1)?.text).toBe('13:00:00');
  });

  it('reads a short time the same way', () => {
    expect(step('8:05', 3, 1)).toEqual({ seconds: t('08:06:00'), text: '08:06:00', selection: [3, 5] });
  });

  it('fills an empty box, and leaves text that is not a time alone', () => {
    expect(step('', 0, 1)).toEqual({ seconds: t('08:00:00'), text: '08:00:00', selection: [0, 2] });
    expect(step('2:05 PM', 1, 1)).toBeNull();
  });
});

// The time range for generating is typed to the minute.
describe('parseClock, formatClock, isFullClock and stepClock with HH:MM', () => {
  it('read and write HH:MM', () => {
    expect(parseClock('8:05', 2)).toBe(t('08:05:00'));
    expect(parseClock('08:05:00', 2)).toBeNull();
    expect(formatClock(t('08:05:00'), 2)).toBe('08:05');
    expect(isFullClock('08:05', 2)).toBe(true);
    expect(isFullClock('8:05', 2)).toBe(false);
  });

  it('step the hour or minute, up to 23:59', () => {
    expect(stepClock('08:59', 4, 1, 0, 2)).toEqual({ seconds: t('09:00:00'), text: '09:00', selection: [3, 5] });
    expect(stepClock('23:30', 1, 1, 0, 2)?.text).toBe('23:59');
    expect(stepClock('', 0, 1, t('08:00:00'), 2)?.text).toBe('08:00');
  });
});

describe('formatDuration', () => {
  it('writes durations in minutes and seconds', () => {
    expect(formatDuration(300)).toBe('5 min');
    expect(formatDuration(135)).toBe('2 min 15 s');
    expect(formatDuration(40)).toBe('40 s');
    // Arrives 24:01:00, should leave 23:56:30.
    expect(formatDuration(-270)).toBe('-4 min 30 s');
    expect(formatDuration(-30)).toBe('-30 s');
  });
});
