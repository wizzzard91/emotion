// Drive errors: code → HTTP status and user-facing text.
// The same codes travel in ?err= after a redirect, so arbitrary text from the request is never rendered.
const ERRORS = {
  not_found: [404, 'Файл или папка не найдены'],
  bad_request: [400, 'Некорректный запрос'],
  bad_name: [400, 'Недопустимое имя: от 1 до 255 символов, без «/», «\\» и управляющих символов'],
  name_taken: [409, 'Файл или папка с таким именем здесь уже есть'],
  forbidden: [403, 'Переименовывать и удалять может только владелец или администратор'],
  not_owner: [403, 'Менять приватность папки может только её владелец'],
  not_folder: [400, 'Приватными бывают только папки'],
  has_hidden: [409, 'Внутри есть чужие приватные папки, поэтому удалить папку целиком нельзя'],
  no_files: [400, 'Файлы не выбраны'],
  too_big: [413, 'Файл больше допустимого размера'],
  too_many: [400, 'Слишком много файлов за один раз'],
  upload_failed: [500, 'Не удалось сохранить файл, попробуйте ещё раз'],
} as const;

export type ErrorCode = keyof typeof ERRORS;

export class DriveError extends Error {
  code: ErrorCode;
  status: number;
  constructor(code: ErrorCode) {
    super(ERRORS[code][1]);
    this.name = 'DriveError';
    this.code = code;
    this.status = ERRORS[code][0];
  }
}

export function errorText(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(ERRORS, code) ? ERRORS[code as ErrorCode][1] : null;
}

export function errorStatus(code: ErrorCode): number {
  return ERRORS[code][0];
}

const MESSAGES: Record<string, string> = {
  created: 'Папка создана',
  uploaded: 'Файлы загружены',
  renamed: 'Переименовано',
  deleted: 'Удалено',
  private_on: 'Папка стала приватной — теперь её видите только вы',
  private_off: 'Папка снова доступна всей команде',
};

export type MessageCode = 'created' | 'uploaded' | 'renamed' | 'deleted' | 'private_on' | 'private_off';

export function messageText(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : null;
}
