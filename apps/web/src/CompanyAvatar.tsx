import { useState } from 'react';
import type { Company } from '@moneycast/core';

const companyIcons: Readonly<Record<string, string>> = {
  'krx:005930': '/company-icons/samsung.png',
  'krx:000660': '/company-icons/sk-hynix.png',
  'krx:035420': '/company-icons/naver.png',
  'krx:005380': '/company-icons/hyundai.png',
  'nasdaq:AAPL': '/company-icons/apple.png',
  'nasdaq:NVDA': '/company-icons/nvidia.png',
  'nasdaq:MSFT': '/company-icons/microsoft.png',
  'nasdaq:TSLA': '/company-icons/tesla.png',
};

/** Official site icons are bundled locally; company text supplies the accessible name. */
export function CompanyAvatar({ company }: { company: Company }) {
  const source = companyIcons[company.id];
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return <span className="company-logo company-logo-image" aria-hidden="true">
    {source && failedSource !== source
      ? <img src={source} alt="" width={28} height={28} loading="lazy" decoding="async" onError={() => setFailedSource(source)}/>
      : <span>{company.name.slice(0, 1)}</span>}
  </span>;
}
