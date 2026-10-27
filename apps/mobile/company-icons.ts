import type { ImageSourcePropType } from 'react-native';

// Static requires let Metro bundle the official source assets for offline use.
export const COMPANY_ICONS: Readonly<Record<string, ImageSourcePropType>> = {
  'krx:005930': require('./assets/company-icons/samsung.png'),
  'krx:000660': require('./assets/company-icons/sk-hynix.png'),
  'krx:035420': require('./assets/company-icons/naver.png'),
  'krx:005380': require('./assets/company-icons/hyundai.png'),
  'nasdaq:AAPL': require('./assets/company-icons/apple.png'),
  'nasdaq:NVDA': require('./assets/company-icons/nvidia.png'),
  'nasdaq:MSFT': require('./assets/company-icons/microsoft.png'),
  'nasdaq:TSLA': require('./assets/company-icons/tesla.png'),
};
