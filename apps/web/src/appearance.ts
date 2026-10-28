export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'moneycast.theme';

export function getTheme(): Theme {
  try { return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#192d2e' : '#f5f7f5');
}

export function saveTheme(theme: Theme) {
  try { window.localStorage.setItem(THEME_STORAGE_KEY, theme); }
  catch { /* Switching themes still works when browser storage is blocked. */ }
}
