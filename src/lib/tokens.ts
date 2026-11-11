const PREFIX = "music_hub_token_";

/**
 * Приводит токен к чистому виду: люди вставляют его вместе с префиксом
 * «OAuth », «Bearer », в кавычках и с переносами строк — из-за этого
 * сервис отвечал 401, хотя токен был верный.
 */
export function normalizeToken(raw: string): string {
  let value = raw.trim().replace(/^["'`]|["'`]$/g, "").trim();
  for (const prefix of ["OAuth ", "oauth ", "Bearer ", "bearer "]) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }
  // Иногда копируют целую строку заголовка
  const header = value.match(/^Authorization:\s*(?:OAuth|Bearer)\s+(.+)$/i);
  if (header) value = header[1].trim();
  return value.replace(/\s+/g, "");
}

export function saveToken(service: string, token: string) {
  localStorage.setItem(PREFIX + service, normalizeToken(token));
}

export function getToken(service: string): string | null {
  const value = localStorage.getItem(PREFIX + service);
  return value ? value : null;
}

export function clearToken(service: string) {
  localStorage.removeItem(PREFIX + service);
}
