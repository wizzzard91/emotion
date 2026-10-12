import { DriveError } from './errors.ts';
import { contentDisposition, formatDate, formatSize, inlineType } from './format.ts';
import { compareNames, nameKey, sanitizeFileName, uniqueName, validateName } from './names.ts';

describe('validateName', () => {
  it('trims whitespace and normalises Unicode', () => {
    expect(validateName('  Отчёт.pdf ')).toBe('Отчёт.pdf');
    expect(validateName('й')).toBe('й');
  });

  it.each([
    ['пустое', ''],
    ['пробелы', '   '],
    ['точка', '.'],
    ['две точки', '..'],
    ['слэш', 'a/b'],
    ['обратный слэш', 'a\\b'],
    ['перевод строки', 'a\nb'],
    ['нулевой байт', 'a\0b'],
    ['DEL', 'a\x7fb'],
    ['bidi-переключатель', 'photo‮gnp.exe'],
    ['слишком длинное', 'я'.repeat(256)],
    ['не строка', undefined],
    ['массив', ['a']],
  ])('отклоняет: %s', (_label, value) => {
    expect(() => validateName(value)).toThrow(DriveError);
  });

  it('accepts 255 characters and names with dots', () => {
    expect(validateName('я'.repeat(255))).toHaveLength(255);
    expect(validateName('.env')).toBe('.env');
    expect(validateName('...')).toBe('...');
  });
});

describe('sanitizeFileName', () => {
  it('replaces forbidden characters and never leaves an empty name', () => {
    expect(sanitizeFileName('a/b\\c\n.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('  ')).toBe('файл');
    expect(sanitizeFileName('..')).toBe('файл');
  });

  it('shortens a long name while keeping the extension', () => {
    const name = sanitizeFileName('д'.repeat(300) + '.pdf');
    expect([...name]).toHaveLength(255);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('uniqueName', () => {
  const taken = (...names: string[]) => new Set(names.map(nameKey));

  it('leaves a free name untouched', () => {
    expect(uniqueName('отчёт.pdf', taken('другой.pdf'))).toBe('отчёт.pdf');
  });

  it('adds the suffix before the extension and picks the next number', () => {
    expect(uniqueName('отчёт.pdf', taken('отчёт.pdf'))).toBe('отчёт (2).pdf');
    expect(uniqueName('отчёт.pdf', taken('отчёт.pdf', 'отчёт (2).pdf'))).toBe('отчёт (3).pdf');
    expect(uniqueName('Makefile', taken('makefile'))).toBe('Makefile (2)');
    expect(uniqueName('.env', taken('.env'))).toBe('.env (2)');
  });

  it('compares case-insensitively, Cyrillic included', () => {
    expect(uniqueName('ОТЧЁТ.PDF', taken('отчёт.pdf'))).toBe('ОТЧЁТ (2).PDF');
  });

  it('stays within 255 characters', () => {
    const long = 'я'.repeat(251) + '.pdf';
    const result = uniqueName(long, taken(long));
    expect([...result]).toHaveLength(255);
    expect(result.endsWith(' (2).pdf')).toBe(true);
  });
});

describe('compareNames', () => {
  it('sorts naturally and case-insensitively', () => {
    const names = ['файл 10', 'Файл 2', 'яблоко', 'Арбуз', 'файл 1'];
    expect(names.sort(compareNames)).toEqual(['Арбуз', 'файл 1', 'Файл 2', 'файл 10', 'яблоко']);
  });
});

describe('format', () => {
  it('formatSize uses Russian units', () => {
    expect(formatSize(0)).toBe('0 Б');
    expect(formatSize(1023)).toBe('1023 Б');
    expect(formatSize(1024)).toBe('1 КБ');
    expect(formatSize(1536)).toBe('1,5 КБ');
    expect(formatSize(5 * 1024 * 1024)).toBe('5 МБ');
    expect(formatSize(2.5 * 1024 ** 3)).toBe('2,5 ГБ');
    expect(formatSize(5000 * 1024 ** 3)).toBe('5000 ГБ');
  });

  it('formatDate', () => {
    expect(formatDate(new Date('2026-10-12T09:05:00Z'), 'UTC')).toBe('12.10.2026 09:05');
    expect(formatDate(new Date('2026-10-12T22:30:00Z'), 'Europe/Moscow')).toBe('13.10.2026 01:30');
  });

  it('inlineType: safe types only', () => {
    expect(inlineType('фото.JPG')).toBe('image/jpeg');
    expect(inlineType('doc.pdf')).toBe('application/pdf');
    expect(inlineType('notes.txt')).toBe('text/plain; charset=utf-8');
    for (const name of ['x.html', 'x.htm', 'x.svg', 'x.js', 'x.xml', 'x.xhtml', 'x', 'x.', 'constructor', 'x.constructor']) {
      expect(inlineType(name)).toBeNull();
    }
  });

  it('contentDisposition: ASCII fallback and RFC 5987', () => {
    expect(contentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(contentDisposition('отчёт (1).pdf', true)).toBe(
      `inline; filename="_____ (1).pdf"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%281%29.pdf`,
    );
    expect(contentDisposition(`a"b'c*.txt`)).toBe(`attachment; filename="a_b'c*.txt"; filename*=UTF-8''a%22b%27c%2A.txt`);
  });
});
