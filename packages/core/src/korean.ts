/** 을/를 and 은/는 follow whether the label's last Hangul syllable ends in a consonant. */
export function particle(label: string, withFinal: string, withoutFinal: string): string {
  for (let index = label.length - 1; index >= 0; index -= 1) {
    const code = label.charCodeAt(index) - 0xac00;
    if (code >= 0 && code <= 11171) return code % 28 === 0 ? withoutFinal : withFinal;
  }
  return withFinal;
}
