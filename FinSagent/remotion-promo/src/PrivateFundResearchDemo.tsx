import type {CSSProperties, ReactNode} from 'react';
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const fontStack =
  'Inter, "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif';

const colors = {
  page: '#eef2f6',
  ink: '#111827',
  text: '#182230',
  muted: '#667085',
  faint: '#98a2b3',
  panel: '#ffffff',
  border: '#d9e2ec',
  sidebar: '#f7f9fb',
  green: '#119c78',
  blue: '#2563eb',
  amber: '#d18a00',
  red: '#c4423b',
  purple: '#7657d6',
  slate: '#344054',
  highlight: '#ffe7a3',
  dark: '#111827',
};

const scenes = {
  opening: 180,
  input: 240,
  steps: 240,
  answer: 420,
  citation: 330,
  source: 390,
  followup: 300,
  memoRequest: 390,
  memoPreview: 360,
  closing: 240,
};

const sceneStarts = {
  opening: 0,
  input: scenes.opening,
  steps: scenes.opening + scenes.input,
  answer: scenes.opening + scenes.input + scenes.steps,
  citation: scenes.opening + scenes.input + scenes.steps + scenes.answer,
  source:
    scenes.opening +
    scenes.input +
    scenes.steps +
    scenes.answer +
    scenes.citation,
  followup:
    scenes.opening +
    scenes.input +
    scenes.steps +
    scenes.answer +
    scenes.citation +
    scenes.source,
  memoRequest:
    scenes.opening +
    scenes.input +
    scenes.steps +
    scenes.answer +
    scenes.citation +
    scenes.source +
    scenes.followup,
  memoPreview:
    scenes.opening +
    scenes.input +
    scenes.steps +
    scenes.answer +
    scenes.citation +
    scenes.source +
    scenes.followup +
    scenes.memoRequest,
  closing:
    scenes.opening +
    scenes.input +
    scenes.steps +
    scenes.answer +
    scenes.citation +
    scenes.source +
    scenes.followup +
    scenes.memoRequest +
    scenes.memoPreview,
};

export const privateFundResearchDemoFrames = Object.values(scenes).reduce(
  (sum, value) => sum + value,
  0,
);

const ease = Easing.bezier(0.16, 1, 0.3, 1);

const clamp = (
  frame: number,
  input: [number, number],
  output: [number, number] = [0, 1],
) =>
  interpolate(frame, input, output, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });

const fadeOut = (frame: number, duration: number) =>
  interpolate(frame, [duration - 28, duration], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });

const enter = (frame: number, start: number, distance = 24): CSSProperties => ({
  opacity: clamp(frame, [start, start + 24]),
  translate: `0px ${interpolate(frame, [start, start + 28], [distance, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  })}px`,
});

const typeText = (text: string, frame: number, start: number, duration: number) => {
  const count = Math.floor(clamp(frame, [start, start + duration], [0, text.length]));
  return text.slice(0, count);
};

const appShell: CSSProperties = {
  fontFamily: fontStack,
  color: colors.text,
  background:
    'linear-gradient(180deg, #f7fafc 0%, #edf2f7 52%, #e7edf5 100%)',
  overflow: 'hidden',
};

export const PrivateFundResearchDemo = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  return (
    <AbsoluteFill style={appShell}>
      <Background />
      <Sequence from={sceneStarts.opening} durationInFrames={scenes.opening}>
        <OpeningScene />
      </Sequence>
      <Sequence from={sceneStarts.input} durationInFrames={scenes.input}>
        <InputScene />
      </Sequence>
      <Sequence from={sceneStarts.steps} durationInFrames={scenes.steps}>
        <StepsScene />
      </Sequence>
      <Sequence from={sceneStarts.answer} durationInFrames={scenes.answer}>
        <AnswerScene />
      </Sequence>
      <Sequence from={sceneStarts.citation} durationInFrames={scenes.citation}>
        <CitationScene />
      </Sequence>
      <Sequence from={sceneStarts.source} durationInFrames={scenes.source}>
        <SourceScene />
      </Sequence>
      <Sequence from={sceneStarts.followup} durationInFrames={scenes.followup}>
        <FollowupScene />
      </Sequence>
      <Sequence from={sceneStarts.memoRequest} durationInFrames={scenes.memoRequest}>
        <MemoRequestScene />
      </Sequence>
      <Sequence from={sceneStarts.memoPreview} durationInFrames={scenes.memoPreview}>
        <MemoPreviewScene />
      </Sequence>
      <Sequence from={sceneStarts.closing} durationInFrames={scenes.closing}>
        <ClosingScene />
      </Sequence>
      <Progress progress={frame / durationInFrames} />
    </AbsoluteFill>
  );
};

const Background = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame % 600, [0, 600], [0, 60]);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(17,24,39,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(17,24,39,0.032) 1px, transparent 1px)',
          backgroundSize: '76px 76px',
          translate: `${drift * -0.2}px ${drift * -0.12}px`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(circle at 18% 20%, rgba(37,99,235,0.13), transparent 32%), radial-gradient(circle at 84% 76%, rgba(17,156,120,0.16), transparent 34%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.58), rgba(255,255,255,0.14))',
        }}
      />
    </AbsoluteFill>
  );
};

const Progress = ({progress}: {progress: number}) => (
  <div
    style={{
      position: 'absolute',
      left: 92,
      right: 92,
      bottom: 42,
      height: 5,
      borderRadius: 99,
      background: 'rgba(52, 64, 84, 0.12)',
      overflow: 'hidden',
      zIndex: 50,
    }}
  >
    <div
      style={{
        width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
        height: '100%',
        background: `linear-gradient(90deg, ${colors.blue}, ${colors.green})`,
      }}
    />
  </div>
);

const Stage = ({
  eyebrow,
  title,
  subtitle,
  children,
  frame,
  duration,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  frame: number;
  duration: number;
  compact?: boolean;
}) => (
  <AbsoluteFill style={{opacity: fadeOut(frame, duration)}}>
    <div
      style={{
        position: 'absolute',
        left: 86,
        top: compact ? 56 : 70,
        right: 86,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 44,
        zIndex: 20,
      }}
    >
      <div style={enter(frame, 6, 18)}>
        <div
          style={{
            color: colors.green,
            fontSize: 25,
            fontWeight: 760,
            letterSpacing: 0,
            marginBottom: 16,
          }}
        >
          {eyebrow}
        </div>
        <div
          style={{
            fontSize: compact ? 54 : 70,
            lineHeight: 1.07,
            fontWeight: 820,
            color: colors.ink,
            letterSpacing: 0,
          }}
        >
          {title}
        </div>
      </div>
      <div
        style={{
          ...enter(frame, 20, 18),
          width: 570,
          paddingTop: 20,
          color: colors.muted,
          fontSize: 30,
          lineHeight: 1.34,
          fontWeight: 520,
        }}
      >
        {subtitle}
      </div>
    </div>
    {children}
  </AbsoluteFill>
);

const OpeningScene = () => {
  const frame = useCurrentFrame();

  return (
    <Stage
      frame={frame}
      duration={scenes.opening}
      eyebrow="私募研究 Demo"
      title="从本地 PDF 到可信 memo"
      subtitle="一个聊天框完成问答、溯源复核和投资备忘录生成。"
    >
      <div
        style={{
          position: 'absolute',
          left: 140,
          right: 140,
          top: 300,
          opacity: clamp(frame, [34, 58]),
          scale: interpolate(frame, [34, 70], [0.97, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: ease,
          }),
        }}
      >
        <ProductWindow variant="empty" frame={frame} />
      </div>
      <ValueStrip frame={frame} start={86} />
    </Stage>
  );
};

const InputScene = () => {
  const frame = useCurrentFrame();
  const prompt = '基于本地 Tesla PDF，概括 Tesla 当前的核心投资逻辑';

  return (
    <Stage
      frame={frame}
      duration={scenes.input}
      eyebrow="主要入口"
      title="从一个聊天框开始"
      subtitle="研究员只需要提出问题，系统围绕本地文件完成第一轮研究。"
    >
      <div style={{position: 'absolute', left: 120, right: 120, top: 310}}>
        <ProductWindow
          variant="typing"
          frame={frame}
          inputText={typeText(prompt, frame, 64, 116)}
          cursor
        />
      </div>
    </Stage>
  );
};

const StepsScene = () => {
  const frame = useCurrentFrame();

  return (
    <Stage
      frame={frame}
      duration={scenes.steps}
      eyebrow="系统步骤"
      title="资料、回答、来源一起组织"
      subtitle="视频里只展示用户可感知的步骤，不暴露底层实现。"
      compact
    >
      <div style={{position: 'absolute', left: 120, right: 120, top: 300}}>
        <ProductWindow variant="steps" frame={frame}>
          <StepCards frame={frame} />
        </ProductWindow>
      </div>
    </Stage>
  );
};

const AnswerScene = () => {
  const frame = useCurrentFrame();

  return (
    <Stage
      frame={frame}
      duration={scenes.answer}
      eyebrow="QA 效果"
      title="先给结论，再给依据"
      subtitle="回答压缩成研究员能快速阅读的结构，并在关键判断后保留页码来源。"
      compact
    >
      <div style={{position: 'absolute', left: 120, right: 120, top: 280}}>
        <ProductWindow variant="answer" frame={frame} />
      </div>
    </Stage>
  );
};

const CitationScene = () => {
  const frame = useCurrentFrame();
  const cursorX = interpolate(frame, [68, 158], [1120, 1024], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });
  const cursorY = interpolate(frame, [68, 158], [720, 618], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });

  return (
    <Stage
      frame={frame}
      duration={scenes.citation}
      eyebrow="可信来源"
      title="来源可以直接点击"
      subtitle="不只展示页码，还能把回答和原始 PDF 页面连接起来。"
      compact
    >
      <div style={{position: 'absolute', left: 120, right: 120, top: 280}}>
        <ProductWindow variant="answer" frame={frame} citationPulse={frame > 130} />
      </div>
      <Cursor x={cursorX} y={cursorY} frame={frame} clickAt={170} />
    </Stage>
  );
};

const SourceScene = () => {
  const frame = useCurrentFrame();

  return (
    <Stage
      frame={frame}
      duration={scenes.source}
      eyebrow="溯源复核"
      title="右侧直接打开 PDF 原文"
      subtitle="页面渲染和区域高亮放在同一屏，方便研究员确认判断是否可靠。"
      compact
    >
      <div style={{position: 'absolute', left: 80, right: 80, top: 274}}>
        <ProductWindow variant="source" frame={frame} />
      </div>
    </Stage>
  );
};

const FollowupScene = () => {
  const frame = useCurrentFrame();

  return (
    <Stage
      frame={frame}
      duration={scenes.followup}
      eyebrow="连续研究"
      title="围绕同一资料继续追问"
      subtitle="收入结构、能源业务、风险因素，可以在同一个上下文中继续推进。"
      compact
    >
      <div style={{position: 'absolute', left: 120, right: 120, top: 280}}>
        <ProductWindow variant="followup" frame={frame} />
      </div>
    </Stage>
  );
};

const MemoRequestScene = () => {
  const frame = useCurrentFrame();

  return (
    <Stage
      frame={frame}
      duration={scenes.memoRequest}
      eyebrow="Memo 生成"
      title="结论成型后，直接生成 memo"
      subtitle="问答、资料和引用会被整理成可以交付的投资备忘录。"
      compact
    >
      <div style={{position: 'absolute', left: 120, right: 120, top: 280}}>
        <ProductWindow variant="memoRequest" frame={frame} />
      </div>
    </Stage>
  );
};

const MemoPreviewScene = () => {
  const frame = useCurrentFrame();

  return (
    <Stage
      frame={frame}
      duration={scenes.memoPreview}
      eyebrow="交付形态"
      title="Memo PDF 可预览、可复核"
      subtitle="最后交付的是结构化投资 memo，而不是一段无法审阅的聊天记录。"
      compact
    >
      <div style={{position: 'absolute', left: 80, right: 80, top: 274}}>
        <ProductWindow variant="memoPreview" frame={frame} />
      </div>
    </Stage>
  );
};

const ClosingScene = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{opacity: fadeOut(frame, scenes.closing)}}>
      <div
        style={{
          position: 'absolute',
          left: 180,
          right: 180,
          top: 160,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            ...enter(frame, 8, 20),
            color: colors.green,
            fontSize: 30,
            fontWeight: 780,
          }}
        >
          私募研究专用工作流
        </div>
        <div
          style={{
            ...enter(frame, 24, 24),
            marginTop: 24,
            color: colors.ink,
            fontSize: 78,
            fontWeight: 840,
            lineHeight: 1.08,
          }}
        >
          问答、溯源、Memo
          <br />
          放进同一个界面
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 220,
          right: 220,
          top: 540,
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 28,
        }}
      >
        {[
          ['QA', '本地 PDF 问答', colors.blue],
          ['Source', '点击回到原文', colors.green],
          ['Memo', '生成交付 PDF', colors.amber],
        ].map(([label, body, color], index) => (
          <div
            key={label}
            style={{
              ...cardBase,
              ...enter(frame, 62 + index * 18, 26),
              padding: 34,
              minHeight: 196,
              borderTop: `6px solid ${color}`,
            }}
          >
            <div style={{fontSize: 36, fontWeight: 820, color}}>{label}</div>
            <div
              style={{
                marginTop: 26,
                color: colors.ink,
                fontSize: 40,
                fontWeight: 760,
              }}
            >
              {body}
            </div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const cardBase: CSSProperties = {
  background: 'rgba(255,255,255,0.86)',
  border: `1px solid ${colors.border}`,
  borderRadius: 16,
  boxShadow: '0 26px 80px rgba(16, 24, 40, 0.14)',
};

type ProductVariant =
  | 'empty'
  | 'typing'
  | 'steps'
  | 'answer'
  | 'source'
  | 'followup'
  | 'memoRequest'
  | 'memoPreview';

const ProductWindow = ({
  variant,
  frame,
  children,
  inputText = '',
  cursor = false,
  citationPulse = false,
}: {
  variant: ProductVariant;
  frame: number;
  children?: ReactNode;
  inputText?: string;
  cursor?: boolean;
  citationPulse?: boolean;
}) => {
  const rightPanel = variant === 'source' || variant === 'memoPreview';
  const memoPanel = variant === 'memoPreview';

  return (
    <div
      style={{
        ...cardBase,
        height: 700,
        display: 'grid',
        gridTemplateColumns: rightPanel ? '248px 1fr 505px' : '248px 1fr',
        overflow: 'hidden',
        background: colors.panel,
      }}
    >
      <Sidebar />
      <div
        style={{
          position: 'relative',
          borderLeft: `1px solid ${colors.border}`,
          background: '#fbfcfd',
          minWidth: 0,
        }}
      >
        <TopBar />
        <ChatArea
          variant={variant}
          frame={frame}
          inputText={inputText}
          cursor={cursor}
          citationPulse={citationPulse}
        >
          {children}
        </ChatArea>
      </div>
      {rightPanel ? (
        <div
          style={{
            borderLeft: `1px solid ${colors.border}`,
            background: memoPanel ? '#f7f8fb' : '#f7f8fb',
            position: 'relative',
            opacity: clamp(frame, [28, 62]),
            translate: `${interpolate(frame, [28, 62], [38, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: ease,
            })}px 0px`,
          }}
        >
          {memoPanel ? <MemoPanel frame={frame} /> : <SourcePanel frame={frame} />}
        </div>
      ) : null}
    </div>
  );
};

const Sidebar = () => (
  <div
    style={{
      background: colors.sidebar,
      padding: '22px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 18,
    }}
  >
    <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: `linear-gradient(135deg, ${colors.blue}, ${colors.green})`,
        }}
      />
      <div>
        <div style={{fontSize: 19, fontWeight: 800, color: colors.ink}}>Omnigent</div>
        <div style={{fontSize: 12, color: colors.muted, marginTop: 3}}>Private Research</div>
      </div>
    </div>
    <div
      style={{
        height: 38,
        borderRadius: 10,
        background: '#eef2f7',
        color: colors.muted,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        fontSize: 14,
      }}
    >
      Search conversations
    </div>
    <div style={{display: 'grid', gap: 10}}>
      {[
        ['Tesla PDF 研究', true],
        ['NVIDIA memo', false],
        ['能源业务追踪', false],
        ['风险复核', false],
      ].map(([label, active]) => (
        <div
          key={String(label)}
          style={{
            padding: '13px 12px',
            borderRadius: 10,
            background: active ? '#e8f3ff' : 'transparent',
            border: active ? '1px solid #c9ddff' : '1px solid transparent',
            color: active ? colors.blue : colors.slate,
            fontSize: 16,
            fontWeight: active ? 720 : 520,
          }}
        >
          {label}
        </div>
      ))}
    </div>
    <div style={{marginTop: 'auto', fontSize: 13, color: colors.faint}}>
      Local files connected
    </div>
  </div>
);

const TopBar = () => (
  <div
    style={{
      height: 62,
      borderBottom: `1px solid ${colors.border}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      background: '#fff',
    }}
  >
    <div>
      <div style={{fontSize: 20, fontWeight: 760, color: colors.ink}}>Tesla 本地 PDF 研究</div>
      <div style={{fontSize: 13, color: colors.muted, marginTop: 3}}>
        10-K, quarterly update, memo draft
      </div>
    </div>
    <div style={{display: 'flex', gap: 8}}>
      <MiniPill color={colors.green}>PDF</MiniPill>
      <MiniPill color={colors.blue}>Source</MiniPill>
      <MiniPill color={colors.amber}>Memo</MiniPill>
    </div>
  </div>
);

const ChatArea = ({
  variant,
  frame,
  children,
  inputText,
  cursor,
  citationPulse,
}: {
  variant: ProductVariant;
  frame: number;
  children?: ReactNode;
  inputText: string;
  cursor: boolean;
  citationPulse: boolean;
}) => {
  const showAnswer =
    variant === 'answer' ||
    variant === 'source' ||
    variant === 'followup' ||
    variant === 'memoRequest' ||
    variant === 'memoPreview';
  const showFollowup =
    variant === 'followup' || variant === 'memoRequest' || variant === 'memoPreview';
  const showMemoRequest = variant === 'memoRequest' || variant === 'memoPreview';

  return (
    <div style={{position: 'absolute', inset: '62px 0 0', display: 'flex', flexDirection: 'column'}}>
      <div style={{flex: 1, padding: '26px 32px', overflow: 'hidden'}}>
        {variant === 'empty' ? <EmptyChat frame={frame} /> : null}
        {variant === 'typing' ? (
          <UserPrompt frame={frame} text="基于本地 Tesla PDF，概括 Tesla 当前的核心投资逻辑" />
        ) : null}
        {variant === 'steps' ? children : null}
        {showAnswer ? <AnswerMessages frame={frame} citationPulse={citationPulse} /> : null}
        {showFollowup ? <FollowupMessages frame={frame} /> : null}
        {showMemoRequest ? <MemoRequestMessages frame={frame} /> : null}
      </div>
      <Composer text={inputText} cursor={cursor} frame={frame} variant={variant} />
    </div>
  );
};

const EmptyChat = ({frame}: {frame: number}) => (
  <div
    style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      opacity: clamp(frame, [48, 76]),
    }}
  >
    <div>
      <div style={{fontSize: 42, fontWeight: 800, color: colors.ink}}>私募研究专用工作台</div>
      <div style={{fontSize: 24, color: colors.muted, marginTop: 18}}>
        本地资料问答、溯源复核、memo 生成
      </div>
    </div>
  </div>
);

const UserPrompt = ({frame, text}: {frame: number; text: string}) => (
  <div style={{display: 'flex', justifyContent: 'flex-end', opacity: clamp(frame, [20, 42])}}>
    <div
      style={{
        maxWidth: 680,
        background: colors.blue,
        color: '#fff',
        padding: '18px 22px',
        borderRadius: '20px 20px 6px 20px',
        fontSize: 22,
        lineHeight: 1.4,
        fontWeight: 560,
        boxShadow: '0 14px 28px rgba(37, 99, 235, 0.22)',
      }}
    >
      {text}
    </div>
  </div>
);

const AnswerMessages = ({
  frame,
  citationPulse = false,
}: {
  frame: number;
  citationPulse?: boolean;
}) => (
  <div style={{display: 'grid', gap: 18}}>
    <UserPrompt frame={frame} text="基于本地 Tesla PDF，概括 Tesla 当前的核心投资逻辑" />
    <AssistantCard frame={frame} start={54}>
      <div style={{fontSize: 23, fontWeight: 780, color: colors.ink}}>
        Tesla 当前更适合被理解为：
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: 28,
          fontWeight: 820,
          color: colors.ink,
          lineHeight: 1.24,
        }}
      >
        汽车现金流 + 能源增长 + AI / Robotaxi 期权
      </div>
      <div style={{marginTop: 20, display: 'grid', gap: 13}}>
        <Bullet
          frame={frame}
          start={96}
          text="汽车销售仍是收入核心，但能源与服务板块增长更快"
          citation="[p.113]"
          pulse={citationPulse}
        />
        <Bullet
          frame={frame}
          start={132}
          text="软件、FSD 与 Robotaxi 是中长期估值弹性的关键"
          citation="[p.65]"
        />
        <Bullet
          frame={frame}
          start={168}
          text="主要风险来自需求、关税、供应链和执行节奏"
          citation="[p.65]"
        />
      </div>
    </AssistantCard>
  </div>
);

const FollowupMessages = ({frame}: {frame: number}) => (
  <div style={{display: 'grid', gap: 16, marginTop: 18}}>
    <div style={{display: 'flex', justifyContent: 'flex-end', opacity: clamp(frame, [40, 70])}}>
      <div
        style={{
          maxWidth: 650,
          background: '#edf4ff',
          color: colors.blue,
          border: '1px solid #c9ddff',
          padding: '15px 19px',
          borderRadius: '18px 18px 6px 18px',
          fontSize: 20,
          lineHeight: 1.36,
          fontWeight: 620,
        }}
      >
        继续分析收入结构、能源业务增长和主要风险
      </div>
    </div>
    <AssistantCard frame={frame} start={84} compact>
      <div style={{display: 'grid', gap: 12}}>
        <CompactRow label="收入结构" text="汽车仍是核心，服务与能源贡献提升" source="p.113" />
        <CompactRow label="增长驱动" text="储能、FSD 订阅、Robotaxi 形成长期弹性" source="p.65" />
      </div>
    </AssistantCard>
  </div>
);

const MemoRequestMessages = ({frame}: {frame: number}) => (
  <div style={{display: 'grid', gap: 16, marginTop: 18}}>
    <div style={{display: 'flex', justifyContent: 'flex-end', opacity: clamp(frame, [44, 72])}}>
      <div
        style={{
          maxWidth: 660,
          background: colors.green,
          color: '#fff',
          padding: '15px 19px',
          borderRadius: '18px 18px 6px 18px',
          fontSize: 20,
          lineHeight: 1.36,
          fontWeight: 650,
          boxShadow: '0 14px 28px rgba(17, 156, 120, 0.22)',
        }}
      >
        基于当前问答和本地 Tesla PDF，生成一份投资 memo PDF
      </div>
    </div>
    <AssistantCard frame={frame} start={94} compact>
      <MemoStatus frame={frame} />
    </AssistantCard>
  </div>
);

const AssistantCard = ({
  frame,
  start,
  children,
  compact = false,
}: {
  frame: number;
  start: number;
  children: ReactNode;
  compact?: boolean;
}) => (
  <div
    style={{
      ...cardBase,
      ...enter(frame, start, 24),
      background: '#fff',
      padding: compact ? '18px 20px' : '24px 26px',
      maxWidth: 850,
      borderRadius: '20px 20px 20px 6px',
    }}
  >
    {children}
  </div>
);

const Bullet = ({
  frame,
  start,
  text,
  citation,
  pulse = false,
}: {
  frame: number;
  start: number;
  text: string;
  citation: string;
  pulse?: boolean;
}) => (
  <div
    style={{
      opacity: clamp(frame, [start, start + 22]),
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      fontSize: 21,
      lineHeight: 1.34,
      color: colors.slate,
    }}
  >
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 99,
        background: colors.green,
        marginTop: 10,
        flexShrink: 0,
      }}
    />
    <span>
      {text}{' '}
      <span
        style={{
          color: colors.blue,
          fontWeight: 780,
          textDecoration: 'underline',
          textDecorationStyle: 'dotted',
          background: pulse
            ? `rgba(37, 99, 235, ${interpolate(Math.sin(frame / 8), [-1, 1], [0.06, 0.2])})`
            : 'transparent',
          borderRadius: 5,
          padding: '1px 4px',
        }}
      >
        {citation}
      </span>
    </span>
  </div>
);

const CompactRow = ({label, text, source}: {label: string; text: string; source: string}) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '100px 1fr 70px',
      gap: 14,
      alignItems: 'center',
      fontSize: 18,
      color: colors.slate,
    }}
  >
    <div style={{fontWeight: 780, color: colors.ink}}>{label}</div>
    <div>{text}</div>
    <div style={{color: colors.blue, fontWeight: 760}}>{source}</div>
  </div>
);

const StepCards = ({frame}: {frame: number}) => (
  <div
    style={{
      height: '100%',
      display: 'grid',
      placeItems: 'center',
    }}
  >
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 22,
        width: 900,
      }}
    >
      {[
        ['01', '读取本地 PDF', 'Tesla 10-K 与研究资料', colors.blue],
        ['02', '生成结构化回答', '结论、依据、风险', colors.green],
        ['03', '绑定可点击来源', '页码、段落、原文区域', colors.amber],
      ].map(([num, title, body, color], index) => (
        <div
          key={title}
          style={{
            ...cardBase,
            ...enter(frame, 40 + index * 32, 30),
            padding: 28,
            height: 210,
            background: '#fff',
          }}
        >
          <div style={{fontSize: 23, fontWeight: 820, color}}>{num}</div>
          <div style={{fontSize: 27, fontWeight: 800, color: colors.ink, marginTop: 30}}>
            {title}
          </div>
          <div style={{fontSize: 19, color: colors.muted, marginTop: 16, lineHeight: 1.35}}>
            {body}
          </div>
        </div>
      ))}
    </div>
  </div>
);

const MemoStatus = ({frame}: {frame: number}) => (
  <div>
    <div style={{fontSize: 21, fontWeight: 800, color: colors.ink}}>正在生成 Tesla 投资 memo</div>
    <div style={{display: 'grid', gap: 14, marginTop: 20}}>
      {[
        ['整理材料', colors.blue],
        ['形成观点', colors.green],
        ['生成 PDF', colors.amber],
      ].map(([label, color], index) => {
        const done = frame > 132 + index * 48;
        return (
          <div
            key={label}
            style={{
              display: 'grid',
              gridTemplateColumns: '30px 1fr 76px',
              gap: 14,
              alignItems: 'center',
              opacity: clamp(frame, [110 + index * 36, 132 + index * 36]),
            }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 99,
                background: done ? color : '#e4e7ec',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 16,
                fontWeight: 800,
              }}
            >
              {done ? '✓' : ''}
            </div>
            <div style={{fontSize: 19, color: colors.slate, fontWeight: 650}}>{label}</div>
            <div style={{fontSize: 16, color: done ? colors.green : colors.faint, fontWeight: 760}}>
              {done ? '完成' : '处理中'}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

const Composer = ({
  text,
  cursor,
  frame,
  variant,
}: {
  text: string;
  cursor: boolean;
  frame: number;
  variant: ProductVariant;
}) => {
  const promptByVariant: Partial<Record<ProductVariant, string>> = {
    answer: '',
    source: '',
    followup: '继续分析 Tesla 的收入结构、能源业务增长和主要风险',
    memoRequest: '基于当前问答和本地 Tesla PDF，生成一份投资 memo PDF',
    memoPreview: '',
  };
  const value = text || promptByVariant[variant] || '';

  return (
    <div
      style={{
        padding: '18px 30px 24px',
        borderTop: `1px solid ${colors.border}`,
        background: '#fff',
      }}
    >
      <div
        style={{
          minHeight: 58,
          borderRadius: 18,
          border: `1px solid ${colors.border}`,
          background: '#f9fafb',
          padding: '15px 18px',
          fontSize: 20,
          color: value ? colors.ink : colors.faint,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 20,
        }}
      >
        <div style={{lineHeight: 1.35}}>
          {value || 'Ask about local PDFs, sources, or memo generation'}
          {cursor ? (
            <span
              style={{
                display: 'inline-block',
                width: 3,
                height: 24,
                marginLeft: 4,
                translate: '0px 4px',
                background: colors.blue,
                opacity: Math.sin(frame / 5) > 0 ? 1 : 0.2,
              }}
            />
          ) : null}
        </div>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 12,
            background: value ? colors.blue : '#e4e7ec',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontSize: 22,
            flexShrink: 0,
          }}
        >
          ↑
        </div>
      </div>
    </div>
  );
};

const MiniPill = ({children, color}: {children: ReactNode; color: string}) => (
  <div
    style={{
      padding: '6px 9px',
      borderRadius: 8,
      background: `${color}16`,
      color,
      fontSize: 12,
      fontWeight: 780,
      border: `1px solid ${color}33`,
    }}
  >
    {children}
  </div>
);

const SourcePanel = ({frame}: {frame: number}) => (
  <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column'}}>
    <PanelHeader title="Sources" subtitle="2026 Tesla 10-K · p.113" color={colors.blue} />
    <div style={{padding: 20, flex: 1, overflow: 'hidden'}}>
      <div
        style={{
          height: '100%',
          background: '#fff',
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 24,
          position: 'relative',
          boxShadow: 'inset 0 0 0 1px rgba(16, 24, 40, 0.02)',
        }}
      >
        <div style={{fontSize: 13, color: colors.faint, textAlign: 'center'}}>Tesla, Inc. 10-K</div>
        <div style={{height: 18}} />
        <PdfLine width="72%" />
        <PdfLine width="88%" />
        <PdfLine width="76%" />
        <div
          style={{
            marginTop: 22,
            border: '1px solid #cfd8e3',
            borderRadius: 4,
            overflow: 'hidden',
          }}
        >
          {[
            ['Automotive sales', '$69,526', '69%'],
            ['Energy generation and storage', '$12,771', '13%'],
            ['Services and other', '$12,530', '13%'],
          ].map((row, index) => (
            <div
              key={row[0]}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.7fr 1fr 0.8fr',
                padding: '13px 12px',
                fontSize: 14,
                color: colors.slate,
                background: index === 0 ? colors.highlight : index % 2 ? '#f8fafc' : '#fff',
                borderBottom: index < 2 ? '1px solid #e2e8f0' : 0,
              }}
            >
              <span>{row[0]}</span>
              <span>{row[1]}</span>
              <span>{row[2]}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            position: 'absolute',
            left: 21,
            right: 21,
            top: 146,
            height: 47,
            border: `4px solid rgba(209, 138, 0, ${clamp(frame, [80, 120], [0.2, 0.9])})`,
            borderRadius: 7,
            boxShadow: '0 0 0 999px rgba(255, 231, 163, 0.05)',
          }}
        />
        <div style={{marginTop: 30}}>
          <PdfLine width="92%" />
          <PdfLine width="86%" />
          <PdfLine width="79%" />
          <PdfLine width="90%" />
          <PdfLine width="68%" />
        </div>
        <div
          style={{
            position: 'absolute',
            right: 26,
            bottom: 18,
            color: colors.faint,
            fontSize: 13,
          }}
        >
          113
        </div>
      </div>
    </div>
  </div>
);

const MemoPanel = ({frame}: {frame: number}) => (
  <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column'}}>
    <PanelHeader title="Memo PDF" subtitle="Tesla investment memo" color={colors.green} />
    <div style={{padding: 20, flex: 1, overflow: 'hidden'}}>
      <div
        style={{
          height: '100%',
          background: '#fff',
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          padding: 28,
          boxShadow: '0 18px 44px rgba(16,24,40,0.10)',
          opacity: clamp(frame, [76, 116]),
          translate: `0px ${interpolate(frame, [76, 116], [24, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: ease,
          })}px`,
        }}
      >
        <div style={{fontSize: 14, color: colors.green, fontWeight: 800}}>INVESTMENT MEMO</div>
        <div
          style={{
            marginTop: 14,
            fontSize: 30,
            lineHeight: 1.16,
            fontWeight: 840,
            color: colors.ink,
          }}
        >
          Tesla, Inc.
          <br />
          核心投资逻辑
        </div>
        <div style={{fontSize: 13, color: colors.faint, marginTop: 10}}>Generated from local PDFs</div>
        <div style={{marginTop: 28, display: 'grid', gap: 14}}>
          {[
            ['一页结论', 'Neutral / Watchlist'],
            ['公司概览', '汽车、能源、AI 平台'],
            ['核心观点', '现金流 + 增长 + 期权'],
            ['风险与催化剂', '需求、监管、Robotaxi'],
            ['引用来源', '10-K p.65 / p.113'],
          ].map(([label, body], index) => (
            <div
              key={label}
              style={{
                display: 'grid',
                gridTemplateColumns: '92px 1fr',
                gap: 14,
                alignItems: 'baseline',
                paddingBottom: 12,
                borderBottom: '1px solid #eef2f7',
                opacity: clamp(frame, [118 + index * 18, 136 + index * 18]),
              }}
            >
              <span style={{fontSize: 14, color: colors.faint, fontWeight: 760}}>{label}</span>
              <span style={{fontSize: 18, color: colors.slate, fontWeight: 650}}>{body}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            position: 'absolute',
            left: 28,
            right: 28,
            bottom: 24,
            padding: 14,
            borderRadius: 10,
            background: '#ecfdf5',
            color: colors.green,
            fontSize: 15,
            fontWeight: 760,
            border: '1px solid #bbf7d0',
          }}
        >
          Sources retained for review
        </div>
      </div>
    </div>
  </div>
);

const PanelHeader = ({
  title,
  subtitle,
  color,
}: {
  title: string;
  subtitle: string;
  color: string;
}) => (
  <div
    style={{
      height: 62,
      borderBottom: `1px solid ${colors.border}`,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '0 20px',
      background: '#fff',
    }}
  >
    <div style={{width: 10, height: 10, borderRadius: 99, background: color}} />
    <div>
      <div style={{fontSize: 18, fontWeight: 800, color: colors.ink}}>{title}</div>
      <div style={{fontSize: 12, color: colors.muted, marginTop: 2}}>{subtitle}</div>
    </div>
  </div>
);

const PdfLine = ({width}: {width: string}) => (
  <div
    style={{
      width,
      height: 9,
      borderRadius: 99,
      background: '#e6ebf2',
      marginBottom: 10,
    }}
  />
);

const Cursor = ({
  x,
  y,
  frame,
  clickAt,
}: {
  x: number;
  y: number;
  frame: number;
  clickAt: number;
}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: 0,
      height: 0,
      zIndex: 40,
      opacity: clamp(frame, [54, 82]),
    }}
  >
    <div
      style={{
        width: 0,
        height: 0,
        borderLeft: '18px solid #101828',
        borderTop: '12px solid transparent',
        borderBottom: '12px solid transparent',
        rotate: '-42deg',
        filter: 'drop-shadow(0 4px 8px rgba(16,24,40,0.25))',
      }}
    />
    <div
      style={{
        position: 'absolute',
        left: -28,
        top: -28,
        width: 58,
        height: 58,
        borderRadius: 99,
        border: `3px solid rgba(37,99,235,${clamp(frame, [clickAt, clickAt + 8], [0, 0.75])})`,
        scale: interpolate(frame, [clickAt, clickAt + 22], [0.45, 1.55], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: ease,
        }),
        opacity: interpolate(frame, [clickAt, clickAt + 28], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: ease,
        }),
      }}
    />
  </div>
);

const ValueStrip = ({frame, start}: {frame: number; start: number}) => (
  <div
    style={{
      position: 'absolute',
      left: 260,
      right: 260,
      bottom: 116,
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 18,
    }}
  >
    {[
      ['QA', '本地资料问答'],
      ['Source', '原文溯源复核'],
      ['Memo', '投资 memo 生成'],
    ].map(([label, body], index) => (
      <div
        key={label}
        style={{
          ...cardBase,
          ...enter(frame, start + index * 16, 20),
          padding: '20px 22px',
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
        }}
      >
        <div style={{fontSize: 24, fontWeight: 830, color: colors.blue}}>{label}</div>
        <div style={{fontSize: 22, fontWeight: 690, color: colors.slate}}>{body}</div>
      </div>
    ))}
  </div>
);
