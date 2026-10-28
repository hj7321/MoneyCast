/** Article text is external: no control or direction-override characters reach the terminal. */
export function terminalText(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('')}…`;
}
