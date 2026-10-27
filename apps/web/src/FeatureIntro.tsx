import { useId } from 'react';
import { Icon, type IconName } from './icons';

interface FeatureIntroProps {
  feature: 'calculator' | 'news';
  onStart: () => void;
  onGuide: () => void;
}

const calculatorSteps: { title: string; description: string; icon: IconName }[] = [
  { title: '현재와 매월의 자금', description: '지금 가진 시드머니와 매달 저축·투자할 금액을 입력하세요. 0원부터 시작하는 계획도 괜찮아요.', icon: 'wallet' },
  { title: '나의 수익률과 시간', description: '예상 수익률과 목표 기간을 바꿔 보세요. 입력을 바꾸는 즉시 차트와 결과가 함께 달라집니다.', icon: 'chart' },
  { title: '목표까지 남은 거리', description: '예상 자산을 납입 원금과 수익으로 나누고, 목표와의 차이를 확인하세요. 월별 추이와 가정별 비교도 살펴볼 수 있어요.', icon: 'target' },
];

const newsSteps: { title: string; description: string; icon: IconName }[] = [
  { title: '출처에서 확인해요', description: '회사명·종목 코드·거래소로 대상을 구분하고, 기사 제목과 매체, 게시 시각, 원문 링크를 함께 살펴보세요.', icon: 'external' },
  { title: '분류의 이유를 읽어요', description: '긍정·부정·중립 분류와 짧은 근거를 확인하세요. 기사 분위기는 주가 방향을 증명하는 답이 아닙니다.', icon: 'news' },
  { title: '불확실성도 함께 봐요', description: '기사 수와 최신성, 상충하는 내용을 확인합니다. 근거가 부족하면 방향을 정하지 않고 판단을 유보해요.', icon: 'shield' },
];

export function FeatureIntro({ feature, onStart, onGuide }: FeatureIntroProps) {
  const calculator = feature === 'calculator';
  const titleId = useId();
  const steps = calculator ? calculatorSteps : newsSteps;

  return <div className={`feature-intro feature-intro--${feature}`}>
    <section className="fi-hero" aria-labelledby={titleId}>
      <div className="fi-hero-copy">
        <span className="fi-feature-label"><Icon name={calculator ? 'chart' : 'news'} size={20}/>{calculator ? '목표 자금 계산기' : '뉴스 인사이트'}</span>
        <h2 id={titleId}>{calculator ? <>막연했던 목표를,<br/><em>나의 숫자로.</em></> : <>소식 너머의 근거,<br/><em>차분하게 읽어요.</em></>}</h2>
        <p>{calculator
          ? '내 집, 자동차, 여행. 내가 원하는 미래까지 얼마나 남았을까요? 지금의 자금과 매달의 노력을 연결해, 나에게 맞는 계획을 그려보세요.'
          : '관심 있는 회사의 뉴스에서 긍정 요인과 부정 요인을 함께 살펴보세요. 확실한 예측을 약속하기보다, 판단에 필요한 근거와 한계를 보여드립니다.'}</p>
        <button className="fi-start-button" onClick={onStart}><span>{calculator ? '목표 자금 계산 시작하기' : '회사 뉴스 살펴보기'}</span><Icon name="arrow" size={20}/></button>
        <span className="fi-hero-note"><Icon name={calculator ? 'check' : 'info'} size={17}/>{calculator ? '로그인 없이 · 내 기기에서 바로 계산' : '출처 · 게시 시각 · 분류 근거 함께 확인'}</span>
      </div>
      {calculator ? <CalculatorPreview/> : <NewsPreview/>}
    </section>

    <section className="fi-how" aria-label={calculator ? '목표 자금 계산기 이용 방법' : '뉴스 인사이트 이용 방법'}>
      <div className="fi-section-heading"><span>{calculator ? '나의 계획을 구체적으로' : '판단하기 전에 확인할 것'}</span><h2>{calculator ? '작은 입력에서, 선명한 계획으로.' : '뉴스를 읽는 세 가지 기준.'}</h2></div>
      <div className="fi-step-grid">{steps.map((step, index) => <article className="fi-step" key={step.title}>
        <div className="fi-step-top"><span className="fi-step-icon"><Icon name={step.icon} size={23}/></span><span className="fi-step-number">0{index + 1}</span></div>
        <h3>{step.title}</h3><p>{step.description}</p>
      </article>)}</div>
    </section>

    <div className="fi-transparency"><span className="fi-transparency-icon"><Icon name={calculator ? 'info' : 'shield'} size={24}/></span><div>
      <h3>{calculator ? '계산의 가정도, 처음부터 투명하게.' : '근거가 없을 때는, 없다고 말합니다.'}</h3>
      <p>{calculator
        ? '월말 납입과 월 복리를 적용하며, 세금·수수료·물가상승률은 반영하지 않습니다. 수익률은 사용자가 입력한 가정이고, 실제 수익을 보장하지 않아요.'
        : '제공자가 연결되기 전에는 실제 기사나 분석 결과를 만들지 않습니다. 연결 후에도 오래되거나 상충하는 뉴스는 판단 유보로 표시하며, 매수·매도를 지시하지 않아요.'}</p>
    </div></div>
    <div className="fi-guide-row"><p>{calculator ? '숫자가 만들어지는 방식을 알고 싶다면' : '뉴스 출처와 근거 수준을 더 알고 싶다면'}</p><button onClick={onGuide}>계산 및 데이터 안내<Icon name="arrow" size={18}/></button></div>
  </div>;
}

function CalculatorPreview() {
  return <div className="fi-preview fi-calculator-preview">
    <div className="fi-preview-heading"><span className="fi-preview-dot"/><span>입력 가정 예시</span><Icon name="chart" size={19}/></div>
    <div className="fi-preview-title"><span>나의 미래 자산</span><strong>입력한 계획이, 한눈에.</strong></div>
    <div className="fi-preview-plot"><svg className="fi-preview-chart" viewBox="0 0 400 190" role="img" aria-label="납입 원금과 예상 자산, 목표 기준선의 관계를 설명하는 모형 차트. 실제 계산 결과가 아닙니다.">
      {[45, 90, 135, 175].map(y => <line key={y} x1="10" x2="390" y1={y} y2={y} stroke="#e7eee7" strokeDasharray="4 6"/>)}
      <path d="M10 165 C95 152 155 137 205 116 S315 58 390 14 L390 175 L10 175Z" fill="#d8ecdc"/>
      <path d="M10 165 L390 85 L390 175 L10 175Z" fill="#e8eeea"/>
      <path d="M10 165 L390 85" fill="none" stroke="#a2b5aa" strokeWidth="2"/>
      <line x1="10" x2="390" y1="62" y2="62" stroke="#b88b55" strokeWidth="1.7" strokeDasharray="6 5"/>
      <path d="M10 165 C95 152 155 137 205 116 S315 58 390 14" fill="none" stroke="#398660" strokeWidth="3.5" strokeLinecap="round"/>
      <circle cx="390" cy="14" r="5" fill="#398660" stroke="white" strokeWidth="2"/>
    </svg><span className="fi-preview-goal-label">목표 기준선</span></div>
    <div className="fi-preview-legend"><span><i/>예상 자산</span><span><i/>납입 원금</span></div>
    <div className="fi-preview-inputs"><span><Icon name="wallet" size={18}/>시드머니</span><span><Icon name="trend" size={18}/>월 납입액</span><span><Icon name="target" size={18}/>목표 기간</span></div>
    <p className="fi-preview-caption">기능 설명용 모형입니다. 실제 결과는 입력한 가정에 따라 달라집니다.</p>
  </div>;
}

function NewsPreview() {
  return <div className="fi-preview fi-news-preview">
    <div className="fi-preview-heading"><span className="fi-preview-dot"/><span>연동 후 화면 구성 안내</span><Icon name="news" size={19}/></div>
    <div className="fi-preview-title"><span>기사에서 근거까지</span><strong>하나의 방향보다,<br/>다양한 요인을 함께.</strong></div>
    <div className="fi-evidence-row"><span className="fi-evidence-icon"><Icon name="external" size={22}/></span><div><strong>기사의 출처와 게시 시각</strong><span>원문으로 이어지는 확인 가능한 근거</span></div><Icon name="check" size={20}/></div>
    <div className="fi-sentiment-row" aria-label="뉴스 분류 유형"><span>긍정 요인</span><span>부정 요인</span><span>중립</span></div>
    <div className="fi-uncertainty"><Icon name="shield" size={22}/><p>기사 수 · 최신성 · 상충 여부<br/><strong>불확실성까지 함께 확인</strong></p></div>
    <div className="fi-pending-state"><span/><strong>기능 설명용 화면 · 실제 기사 아님</strong></div>
    <p className="fi-preview-caption">화면 구성을 설명하는 모형이며, 실제 뉴스나 투자 전망이 아닙니다.</p>
  </div>;
}
