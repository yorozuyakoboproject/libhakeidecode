import { getLocale, resolveLocale, setLocale, translateDOM, type Locale } from './i18n.js';
import { resolveTheme, validTheme, type ThemeMode } from './theme.js';
export const THEME_KEY = 'hakei.theme';
export const LOCALE_KEY = 'hakei.locale';
function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function save(key: string, value: string): void { try { localStorage.setItem(key, value); } catch {   } }
const media = matchMedia('(prefers-color-scheme: dark)');
let mode: ThemeMode = validTheme(read(THEME_KEY));
setLocale(resolveLocale(read(LOCALE_KEY), navigator.languages));
function apply(): void {
  const root = document.documentElement, previous = root.dataset.theme;
  root.dataset.themeMode = mode; root.dataset.theme = resolveTheme(mode, media.matches); root.lang = getLocale();
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
  translateDOM();
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-theme-select]')) select.value = mode;
  for (const select of document.querySelectorAll<HTMLSelectElement>('[data-locale-select]')) select.value = getLocale();
  if (previous !== root.dataset.theme) window.dispatchEvent(new Event('hakei:themechange'));
}
export function changeTheme(value: ThemeMode): void { mode = validTheme(value); save(THEME_KEY, mode); apply(); }
export function changeLocale(value: Locale): void { setLocale(value); save(LOCALE_KEY, value); apply(); window.dispatchEvent(new Event('hakei:localechange')); }
media.addEventListener('change', () => { if (mode === 'system') apply(); });
window.addEventListener('storage', event => {
  if (event.key !== null && event.key !== THEME_KEY && event.key !== LOCALE_KEY) return;
  const previous = getLocale(); mode = validTheme(read(THEME_KEY)); setLocale(resolveLocale(read(LOCALE_KEY), navigator.languages)); apply();
  if (previous !== getLocale()) window.dispatchEvent(new Event('hakei:localechange'));
});
for (const select of document.querySelectorAll<HTMLSelectElement>('[data-theme-select]')) select.addEventListener('change', () => changeTheme(select.value as ThemeMode));
for (const select of document.querySelectorAll<HTMLSelectElement>('[data-locale-select]')) select.addEventListener('change', () => changeLocale(select.value as Locale));
apply();
