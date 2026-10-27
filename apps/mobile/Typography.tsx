import React, { createContext, forwardRef, useContext } from 'react';
import {
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  type TextProps,
  type TextInputProps,
  type TextStyle,
} from 'react-native';

const FontReady = createContext(false);
const TextWeight = createContext<TextStyle['fontWeight']>('400');

/** Bundled static faces preserve the existing numeric weight and font sizes. */
function fontFamily(weight: TextStyle['fontWeight']): string {
  const numeric = weight === 'bold' ? 700 : weight === 'normal' || !weight ? 400 : Number(weight);
  if (numeric <= 100) return 'IBMPlexSansKR-Thin';
  if (numeric <= 200) return 'IBMPlexSansKR-ExtraLight';
  if (numeric <= 300) return 'IBMPlexSansKR-Light';
  if (numeric <= 400) return 'IBMPlexSansKR-Regular';
  if (numeric <= 500) return 'IBMPlexSansKR-Medium';
  if (numeric <= 600) return 'IBMPlexSansKR-SemiBold';
  return 'IBMPlexSansKR-Bold';
}

export function PlexFontProvider({ loaded, children }: { loaded: boolean; children: React.ReactNode }) {
  return <FontReady.Provider value={loaded}>{children}</FontReady.Provider>;
}

export const Text = forwardRef<NativeText, TextProps>(function PlexText({ style, children, ...props }, ref) {
  const loaded = useContext(FontReady);
  const inheritedWeight = useContext(TextWeight);
  const weight = StyleSheet.flatten(style)?.fontWeight ?? inheritedWeight;
  return <TextWeight.Provider value={weight}>
    <NativeText {...props} ref={ref} style={[loaded && { fontFamily: fontFamily(weight) }, style]}>{children}</NativeText>
  </TextWeight.Provider>;
});

export const TextInput = forwardRef<NativeTextInput, TextInputProps>(function PlexTextInput({ style, ...props }, ref) {
  const loaded = useContext(FontReady);
  const inheritedWeight = useContext(TextWeight);
  const weight = StyleSheet.flatten(style)?.fontWeight ?? inheritedWeight;
  return <NativeTextInput {...props} ref={ref} style={[loaded && { fontFamily: fontFamily(weight) }, style]} />;
});
