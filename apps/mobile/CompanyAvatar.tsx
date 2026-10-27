import React, { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Text } from './Typography';
import type { Company } from '@moneycast/core';
import { COMPANY_ICONS } from './company-icons';

export function CompanyAvatar({ company }: { company: Company }) {
  const [failedId, setFailedId] = useState<string | null>(null);
  const source = COMPANY_ICONS[company.id];
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.avatar}>
    {source && failedId !== company.id
      ? <Image accessible={false} source={source} resizeMode="contain" style={styles.image} onError={() => setFailedId(company.id)} />
      : <Text style={styles.initial}>{company.name.slice(0, 1)}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  avatar: { width: 44, height: 44, padding: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e2e8e1' },
  image: { width: 32, height: 32 },
  initial: { color: '#406148', fontWeight: '700', fontSize: 16 },
});
