# MoneyCast 공용 브랜드 자산

## 회사 썸네일

웹의 `apps/web/public/company-icons/`와 앱의 `apps/mobile/assets/company-icons/`에는 동일한 PNG 파일을 포함합니다. ICO의 가장 큰 프레임을 원래 색상과 투명도 그대로 PNG로 변환했으며, 임의로 그린 로고나 문자 이미지를 사용하지 않습니다. 실행 중 외부 파비콘 서비스에 요청하지 않습니다.

원본 주소·다운로드 경로·크기·SHA-256은 [company-icon-sources.json](company-icon-sources.json)에 기록되어 있습니다. 확인 날짜는 2026-10-28(한국 시간)입니다.

| 회사 | 원본 |
| --- | --- |
| 삼성전자 | [삼성닷컴 파비콘](https://www.samsung.com/sec/static/_images/favicon.ico) |
| SK하이닉스 | [공식 홈페이지에서 지정한 CDN 파비콘](https://mis-prod-koce-skhynixhomepage-cdn-01-ep.azureedge.net/img/favicon.ico) |
| NAVER | [공식 기업 사이트 파비콘](https://www.navercorp.com/img/favicon.ico) |
| 현대자동차 | [공식 홈페이지 파비콘](https://www.hyundai.com/etc/designs/hyundai/ww/favicon.ico) |
| Apple | [공식 홈페이지 파비콘](https://www.apple.com/favicon.ico) |
| NVIDIA | [공식 홈페이지 파비콘](https://www.nvidia.com/favicon.ico) |
| Microsoft | [공식 홈페이지 파비콘](https://www.microsoft.com/favicon.ico?v2) |
| Tesla | [공식 도메인의 파비콘 캐시](https://www.google.com/s2/favicons?domain=tesla.com&sz=128) — 원본 사이트의 자동 요청 제한으로 캐시를 한 번 내려받아 포함 |

회사 로고와 상표의 권리는 각 권리자에게 있습니다. 이 파일들은 회사를 식별하기 위한 자산이며 프로젝트 소스의 MIT 라이선스와 구분됩니다.

## 글꼴

앱은 [Google Fonts 공식 저장소의 IBM Plex Sans KR](https://github.com/google/fonts/tree/main/ofl/ibmplexsanskr) 100~700 굵기 TTF를 `fonts/`에서 로드합니다. 웹은 같은 TTF를 FontTools로 WOFF2 압축한 파일을 `apps/web/public/fonts/`에 포함합니다. 글리프·글꼴 이름·디자인은 바꾸지 않았습니다. 웹과 앱 모두 외부 글꼴 요청 없이 로드하며 기존 글자 크기와 굵기 지정은 유지합니다.

폰트에는 [SIL Open Font License](fonts/OFL.txt)가 적용됩니다. 각 파일의 원본 URL·해시는 [fonts/sources.json](fonts/sources.json)에 기록합니다.
