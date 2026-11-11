/**
 * Для личного использования не поднимаем полноценный OAuth-флоу —
 * токен вставляется вручную (см. ConnectModal). Получить его можно
 * через Spotify Developer Dashboard → Web API console либо сторонний
 * генератор токена для тестирования Web API.
 *
 * Важно: access token Spotify живёт около часа. Для по-настоящему
 * долгоживущего личного использования в какой-то момент придётся
 * либо вручную обновлять токен, либо всё же реализовать refresh_token
 * через полноценный OAuth Authorization Code + PKCE.
 */
export async function getPlaylists(accessToken: string) {
  const resp = await fetch("https://api.spotify.com/v1/me/playlists", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return resp.ok ? resp.json() : [];
}

export async function getCurrentTrack(accessToken: string) {
  const resp = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return resp.ok ? resp.json() : null;
}
