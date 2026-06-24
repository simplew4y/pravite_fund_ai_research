import type {CSSProperties, ReactNode} from 'react';
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const fontStack =
  'Inter, "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif';

const colors = {
  bg: '#061014',
  panel: 'rgba(12, 20, 24, 0.78)',
  panelSolid: '#0d171b',
  border: 'rgba(206, 232, 224, 0.18)',
  text: '#edf8f4',
  muted: '#9fb3ae',
  jade: '#35d6a2',
  cyan: '#64d8ff',
  amber: '#f1b75c',
  coral: '#ff7d6e',
  violet: '#a98cff',
  ink: '#091115',
};

const scenes = {
  pain: 192,
  question: 216,
  agents: 360,
  evidence: 288,
  preview: 240,
  value: 240,
};

const sceneStarts = {
  pain: 0,
  question: scenes.pain,
  agents: scenes.pain + scenes.question,
  evidence: scenes.pain + scenes.question + scenes.agents,
  preview: scenes.pain + scenes.question + scenes.agents + scenes.evidence,
  value:
    scenes.pain +
    scenes.question +
    scenes.agents +
    scenes.evidence +
    scenes.preview,
};

const clamp = (
  frame: number,
  input: [number, number],
  output: [number, number] = [0, 1],
) =>
  interpolate(frame, input, output, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

const fadeStyle = (frame: number, start: number, end: number): CSSProperties => ({
  opacity: clamp(frame, [start, end]),
});

const entrance = (
  frame: number,
  start: number,
  distance = 32,
): CSSProperties => {
  const progress = spring({
    frame: frame - start,
    fps: 24,
    config: {damping: 18, stiffness: 90, mass: 0.8},
  });

  return {
    opacity: clamp(frame, [start, start + 16]),
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
};

const exitFade = (
  frame: number,
  start: number,
  end: number,
): CSSProperties => ({
  opacity: interpolate(frame, [start, end], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }),
});

const typeText = (text: string, frame: number, start: number, duration: number) => {
  const chars = Math.floor(clamp(frame, [start, start + duration], [0, text.length]));
  return text.slice(0, chars);
};

const shellStyle: CSSProperties = {
  fontFamily: fontStack,
  color: colors.text,
  background:
    'linear-gradient(135deg, #061014 0%, #0b1818 42%, #17130e 100%)',
  overflow: 'hidden',
};

const panelStyle: CSSProperties = {
  background: colors.panel,
  border: `1px solid ${colors.border}`,
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.34)',
  backdropFilter: 'blur(12px)',
};

export const PromoVideo = () => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();

  return (
    <AbsoluteFill style={shellStyle}>
      <GlobalBackdrop />
      <Header />
      <Sequence from={sceneStarts.pain} durationInFrames={scenes.pain}>
        <PainScene />
      </Sequence>
      <Sequence from={sceneStarts.question} durationInFrames={scenes.question}>
        <QuestionScene />
      </Sequence>
      <Sequence from={sceneStarts.agents} durationInFrames={scenes.agents}>
        <AgentsScene />
      </Sequence>
      <Sequence from={sceneStarts.evidence} durationInFrames={scenes.evidence}>
        <EvidenceScene />
      </Sequence>
      <Sequence from={sceneStarts.preview} durationInFrames={scenes.preview}>
        <PreviewScene />
      </Sequence>
      <Sequence from={sceneStarts.value} durationInFrames={scenes.value}>
        <ValueScene />
      </Sequence>
      <ProgressBar progress={frame / durationInFrames} />
    </AbsoluteFill>
  );
};

const GlobalBackdrop = () => {
  const frame = useCurrentFrame();
  const slowShift = interpolate(frame % 480, [0, 480], [0, 80]);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.038) 1px, transparent 1px)',
          backgroundSize: '80px 80px',
          transform: `translate(${slowShift * -0.25}px, ${slowShift * -0.15}px)`,
          opacity: 0.52,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(circle at 20% 15%, rgba(53,214,162,0.16), transparent 28%), radial-gradient(circle at 78% 72%, rgba(241,183,92,0.12), transparent 30%)',
          opacity: 0.74,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: -120,
          top: 0,
          width: 520,
          height: 1080,
          background:
            'linear-gradient(90deg, rgba(53,214,162,0.11), transparent)',
          transform: 'skewX(-12deg)',
          opacity: 0.55,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.08), rgba(0,0,0,0.36))',
        }}
      />
    </AbsoluteFill>
  );
};

const Header = () => {
  const frame = useCurrentFrame();
  const opacity = clamp(frame, [0, 24]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 46,
        left: 72,
        right: 72,
        height: 54,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        zIndex: 10,
        opacity,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
        <LogoMark />
        <div>
          <div style={{fontSize: 27, fontWeight: 760, lineHeight: 1}}>
            FinSagent
          </div>
          <div style={{fontSize: 14, color: colors.muted, marginTop: 7}}>
            Agentic Financial Intelligence
          </div>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          color: colors.muted,
          fontSize: 16,
        }}
      >
        <span>客户演示视频</span>
        <span style={{width: 6, height: 6, borderRadius: 99, background: colors.jade}} />
        <span>可信金融研究工作流</span>
      </div>
    </div>
  );
};

const LogoMark = () => (
  <div
    style={{
      width: 48,
      height: 48,
      borderRadius: 12,
      background:
        'linear-gradient(135deg, rgba(53,214,162,0.96), rgba(100,216,255,0.86) 58%, rgba(241,183,92,0.9))',
      position: 'relative',
      boxShadow: '0 14px 42px rgba(53, 214, 162, 0.24)',
    }}
  >
    <div
      style={{
        position: 'absolute',
        left: 13,
        top: 12,
        width: 22,
        height: 24,
        border: `3px solid ${colors.ink}`,
        borderTop: 0,
        borderRight: 0,
        transform: 'skewX(-12deg)',
      }}
    />
    <div
      style={{
        position: 'absolute',
        right: 11,
        top: 10,
        width: 8,
        height: 30,
        background: colors.ink,
        borderRadius: 4,
      }}
    />
  </div>
);

const ProgressBar = ({progress}: {progress: number}) => (
  <div
    style={{
      position: 'absolute',
      left: 72,
      right: 72,
      bottom: 42,
      height: 3,
      background: 'rgba(255,255,255,0.11)',
      overflow: 'hidden',
      borderRadius: 99,
      zIndex: 20,
    }}
  >
    <div
      style={{
        width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
        height: '100%',
        background:
          'linear-gradient(90deg, #35d6a2, #64d8ff 58%, #f1b75c)',
      }}
    />
  </div>
);

const Kicker = ({children, color = colors.jade}: {children: ReactNode; color?: string}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      color,
      fontSize: 18,
      fontWeight: 700,
      padding: '8px 13px',
      border: `1px solid ${color}55`,
      background: `${color}14`,
      borderRadius: 8,
    }}
  >
    <span
      style={{
        width: 8,
        height: 8,
        background: color,
        borderRadius: 99,
        boxShadow: `0 0 18px ${color}`,
      }}
    />
    {children}
  </div>
);

const PainScene = () => {
  const frame = useCurrentFrame();
  const exit = exitFade(frame, scenes.pain - 26, scenes.pain);

  const docs = [
    {title: '10-K / 年报', tag: '143 页', color: colors.cyan},
    {title: '市场新闻', tag: '实时变化', color: colors.amber},
    {title: '监管披露', tag: '风险条款', color: colors.coral},
    {title: '交易数据', tag: '指标波动', color: colors.jade},
    {title: '研报摘要', tag: '观点冲突', color: colors.violet},
  ];

  return (
    <AbsoluteFill style={{...exit}}>
      <div style={{position: 'absolute', left: 104, top: 178, width: 760}}>
        <div style={entrance(frame, 5)}>
          <Kicker color={colors.amber}>客户面对的问题</Kicker>
        </div>
        <h1
          style={{
            ...entrance(frame, 18, 38),
            margin: '34px 0 0',
            fontSize: 82,
            lineHeight: 1.06,
            fontWeight: 820,
          }}
        >
          金融研究的瓶颈，
          <br />
          不是信息少
        </h1>
        <p
          style={{
            ...entrance(frame, 42, 28),
            margin: '32px 0 0',
            width: 690,
            color: colors.muted,
            fontSize: 31,
            lineHeight: 1.38,
          }}
        >
          而是信息太多、变化太快，结论还必须经得起业务、风控与合规复核。
        </p>
      </div>

      <div style={{position: 'absolute', right: 112, top: 188, width: 770, height: 650}}>
        <DashboardLoad frame={frame} />
        {docs.map((doc, index) => {
          const top = [58, 188, 320, 452, 112][index];
          const left = [22, 398, 88, 462, 246][index];
          const rotate = [-6, 5, -3, 4, 1][index];
          const delay = 20 + index * 12;
          const progress = spring({
            frame: frame - delay,
            fps: 24,
            config: {damping: 20, stiffness: 95},
          });

          return (
            <div
              key={doc.title}
              style={{
                ...panelStyle,
                position: 'absolute',
                top,
                left,
                width: 258,
                padding: 22,
                borderRadius: 10,
                transform: `translateY(${(1 - progress) * 56}px) rotate(${rotate}deg)`,
                opacity: clamp(frame, [delay, delay + 14]),
              }}
            >
              <div
                style={{
                  color: doc.color,
                  fontSize: 15,
                  fontWeight: 760,
                  marginBottom: 12,
                }}
              >
                {doc.tag}
              </div>
              <div style={{fontSize: 25, fontWeight: 760}}>{doc.title}</div>
              <div
                style={{
                  marginTop: 16,
                  height: 8,
                  borderRadius: 99,
                  background: 'rgba(255,255,255,0.12)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${48 + index * 9}%`,
                    height: '100%',
                    background: doc.color,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const DashboardLoad = ({frame}: {frame: number}) => {
  const pulse = interpolate(Math.sin(frame / 12), [-1, 1], [0.62, 1]);

  return (
    <div
      style={{
        ...panelStyle,
        position: 'absolute',
        inset: '0 0 auto auto',
        width: 590,
        height: 520,
        borderRadius: 14,
        padding: 28,
        opacity: clamp(frame, [8, 30]) * 0.88,
      }}
    >
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <div style={{fontSize: 20, color: colors.muted}}>Research Desk</div>
        <div
          style={{
            color: colors.coral,
            fontSize: 16,
            border: `1px solid ${colors.coral}55`,
            padding: '7px 11px',
            borderRadius: 8,
          }}
        >
          证据待核验
        </div>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 30}}>
        {['信息源', '冲突观点', '时效风险', '合规提示'].map((label, index) => (
          <div
            key={label}
            style={{
              background: 'rgba(255,255,255,0.055)',
              border: `1px solid rgba(255,255,255,${0.1 + index * 0.018})`,
              borderRadius: 10,
              padding: 20,
              height: 120,
            }}
          >
            <div style={{color: colors.muted, fontSize: 17}}>{label}</div>
            <div style={{fontSize: 42, fontWeight: 800, marginTop: 14}}>
              {[37, 12, 8, 19][index]}
            </div>
          </div>
        ))}
      </div>
      <div style={{marginTop: 28}}>
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            style={{
              height: 18,
              borderRadius: 99,
              marginBottom: 16,
              background: 'rgba(255,255,255,0.1)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${[84, 64, 72][item] * pulse}%`,
                height: '100%',
                background:
                  item === 1
                    ? colors.amber
                    : 'linear-gradient(90deg, #35d6a2, #64d8ff)',
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

const QuestionScene = () => {
  const frame = useCurrentFrame();
  const exit = exitFade(frame, scenes.question - 28, scenes.question);
  const prompt =
    '分析 NVIDIA 未来收入增长的主要驱动因素，并指出需要关注的风险。';
  const typed = typeText(prompt, frame, 52, 78);

  return (
    <AbsoluteFill style={{...exit}}>
      <div
        style={{
          position: 'absolute',
          left: 112,
          top: 176,
          right: 112,
          display: 'grid',
          gridTemplateColumns: '690px 1fr',
          gap: 80,
          alignItems: 'center',
        }}
      >
        <div>
          <div style={entrance(frame, 4)}>
            <Kicker>FinSagent 的入口</Kicker>
          </div>
          <h2
            style={{
              ...entrance(frame, 18, 36),
              margin: '34px 0 0',
              fontSize: 76,
              lineHeight: 1.08,
              fontWeight: 820,
            }}
          >
            从一个复杂问题，
            <br />
            启动完整研究流程
          </h2>
          <p
            style={{
              ...entrance(frame, 44, 28),
              marginTop: 30,
              color: colors.muted,
              fontSize: 29,
              lineHeight: 1.42,
            }}
          >
            客户不用手动拆资料、分任务、核证据。系统自动路由给最合适的金融专家智能体。
          </p>
        </div>
        <div style={{position: 'relative', height: 640}}>
          <div
            style={{
              ...panelStyle,
              ...entrance(frame, 32, 44),
              borderRadius: 16,
              padding: 34,
              height: 500,
              position: 'absolute',
              inset: '42px 0 auto 0',
            }}
          >
            <div
              style={{
                height: 64,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                color: colors.muted,
                fontSize: 18,
                borderBottom: `1px solid ${colors.border}`,
                paddingBottom: 24,
              }}
            >
              <LogoMark />
              <div>
                <div style={{fontSize: 24, color: colors.text, fontWeight: 760}}>
                  FinSagent Research Console
                </div>
                <div style={{fontSize: 15, marginTop: 5}}>HTTP/SSE 流式响应</div>
              </div>
            </div>
            <div
              style={{
                marginTop: 36,
                background: 'rgba(255,255,255,0.07)',
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                minHeight: 130,
                padding: 26,
                fontSize: 27,
                lineHeight: 1.42,
              }}
            >
              {typed}
              <span
                style={{
                  display: 'inline-block',
                  width: 4,
                  height: 32,
                  marginLeft: 5,
                  transform: 'translateY(6px)',
                  background: colors.jade,
                  opacity: Math.sin(frame / 5) > 0 ? 1 : 0.2,
                }}
              />
            </div>
            <div style={{display: 'flex', gap: 14, marginTop: 30}}>
              {['时间锚点', '私有语料', '多专家路由'].map((item, index) => (
                <div
                  key={item}
                  style={{
                    opacity: clamp(frame, [138 + index * 10, 150 + index * 10]),
                    padding: '12px 16px',
                    borderRadius: 8,
                    background:
                      index === 2 ? 'rgba(53,214,162,0.14)' : 'rgba(255,255,255,0.06)',
                    border: `1px solid ${
                      index === 2 ? 'rgba(53,214,162,0.35)' : colors.border
                    }`,
                    color: index === 2 ? colors.jade : colors.muted,
                    fontSize: 17,
                    fontWeight: 680,
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
            <div
              style={{
                opacity: clamp(frame, [168, 184]),
                marginTop: 34,
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                color: colors.cyan,
                fontSize: 21,
                fontWeight: 760,
              }}
            >
              <Spinner frame={frame} />
              正在分解问题并选择专家智能体
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Spinner = ({frame}: {frame: number}) => (
  <div
    style={{
      width: 28,
      height: 28,
      borderRadius: 99,
      border: '3px solid rgba(100,216,255,0.22)',
      borderTopColor: colors.cyan,
      transform: `rotate(${frame * 12}deg)`,
    }}
  />
);

const AgentsScene = () => {
  const frame = useCurrentFrame();
  const exit = exitFade(frame, scenes.agents - 30, scenes.agents);
  const headingOpacity = interpolate(frame, [0, 16, 78, 112], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const agents = [
    {
      key: 'Market',
      name: '市场研究',
      desc: '行业趋势 / 需求结构',
      x: 260,
      y: 188,
      color: colors.cyan,
      delay: 46,
    },
    {
      key: 'Company',
      name: '公司研究',
      desc: '财报 / 业务线 / 指引',
      x: 1246,
      y: 188,
      color: colors.jade,
      delay: 58,
    },
    {
      key: 'Quant',
      name: '量化分析',
      desc: '指标 / 趋势 / 异常',
      x: 300,
      y: 650,
      color: colors.amber,
      delay: 70,
    },
    {
      key: 'Legal',
      name: '法律风险',
      desc: '监管 / 合规 / 风险条款',
      x: 1206,
      y: 650,
      color: colors.coral,
      delay: 82,
    },
    {
      key: 'General',
      name: '快速初稿',
      desc: '先给方向，再深挖',
      x: 760,
      y: 760,
      color: colors.violet,
      delay: 34,
    },
  ];

  return (
    <AbsoluteFill style={{...exit}}>
      <div style={{position: 'absolute', left: 112, top: 138, opacity: headingOpacity}}>
        <div style={entrance(frame, 4)}>
          <Kicker color={colors.cyan}>多智能体协作</Kicker>
        </div>
        <h2
          style={{
            ...entrance(frame, 18, 32),
            margin: '26px 0 0',
            fontSize: 62,
            lineHeight: 1.12,
            fontWeight: 820,
          }}
        >
          一个问题，多个专家并行研究
        </h2>
      </div>

      <svg
        width="1920"
        height="1080"
        style={{position: 'absolute', inset: 0, opacity: clamp(frame, [42, 72])}}
      >
        {agents.map((agent) => {
          const progress = clamp(frame, [agent.delay, agent.delay + 40]);
          const length = 640;
          return (
            <line
              key={agent.key}
              x1="960"
              y1="510"
              x2={agent.x + 180}
              y2={agent.y + 82}
              stroke={agent.color}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={length}
              strokeDashoffset={length * (1 - progress)}
              opacity="0.62"
            />
          );
        })}
      </svg>

      <CentralNode frame={frame} />
      {agents.map((agent) => (
        <AgentCard
          key={agent.key}
          frame={frame}
          name={agent.name}
          label={agent.key}
          desc={agent.desc}
          x={agent.x}
          y={agent.y}
          color={agent.color}
          delay={agent.delay}
        />
      ))}

      <div
        style={{
          ...panelStyle,
          position: 'absolute',
          right: 112,
          top: 146,
          width: 360,
          padding: 24,
          borderRadius: 12,
          opacity: clamp(frame, [132, 156]),
        }}
      >
        <div style={{fontSize: 17, color: colors.muted}}>实时编排状态</div>
        <div style={{marginTop: 18, display: 'grid', gap: 13}}>
          {[
            ['orchestrator', '已完成', colors.jade],
            ['dispatch', '并行中', colors.cyan],
            ['retrieval', '证据收集', colors.amber],
            ['synthesis', '等待汇总', colors.violet],
          ].map(([label, status, color], index) => (
            <div
              key={label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 16,
                opacity: clamp(frame, [150 + index * 12, 162 + index * 12]),
              }}
            >
              <span style={{color: colors.muted}}>{label}</span>
              <span style={{color, fontWeight: 760}}>{status}</span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const CentralNode = ({frame}: {frame: number}) => {
  const scale = spring({
    frame: frame - 22,
    fps: 24,
    config: {damping: 18, stiffness: 90},
  });
  const glow = interpolate(Math.sin(frame / 18), [-1, 1], [0.16, 0.32]);

  return (
    <div
      style={{
        ...panelStyle,
        position: 'absolute',
        left: 760,
        top: 382,
        width: 400,
        height: 256,
        borderRadius: 18,
        padding: 30,
        opacity: clamp(frame, [14, 32]),
        transform: `scale(${0.86 + scale * 0.14})`,
        boxShadow: `0 0 0 1px rgba(53,214,162,0.22), 0 34px 90px rgba(0,0,0,0.45), 0 0 80px rgba(53,214,162,${glow})`,
      }}
    >
      <div style={{fontSize: 17, color: colors.jade, fontWeight: 780}}>USER QUESTION</div>
      <div
        style={{
          marginTop: 18,
          fontSize: 31,
          fontWeight: 780,
          lineHeight: 1.28,
        }}
      >
        增长驱动是什么？
        <br />
        风险在哪里？
      </div>
      <div
        style={{
          marginTop: 24,
          display: 'flex',
          gap: 10,
          color: colors.muted,
          fontSize: 15,
        }}
      >
        <span>query_time</span>
        <span style={{color: colors.amber}}>2026</span>
        <span>routing</span>
      </div>
    </div>
  );
};

const AgentCard = ({
  frame,
  name,
  label,
  desc,
  x,
  y,
  color,
  delay,
}: {
  frame: number;
  name: string;
  label: string;
  desc: string;
  x: number;
  y: number;
  color: string;
  delay: number;
}) => {
  const progress = spring({
    frame: frame - delay,
    fps: 24,
    config: {damping: 18, stiffness: 100},
  });
  const active = clamp(frame, [delay + 70, delay + 118]);
  const done = clamp(frame, [delay + 160, delay + 186]);

  return (
    <div
      style={{
        ...panelStyle,
        position: 'absolute',
        left: x,
        top: y,
        width: 360,
        height: 164,
        borderRadius: 14,
        padding: 22,
        opacity: clamp(frame, [delay, delay + 18]),
        transform: `translateY(${(1 - progress) * 45}px)`,
        border: `1px solid ${color}55`,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            color: colors.ink,
            background: color,
            fontWeight: 900,
          }}
        >
          {label.slice(0, 1)}
        </div>
        <div style={{color, fontSize: 14, fontWeight: 800}}>
          {done > 0.65 ? 'completed' : active > 0.2 ? 'retrieving' : 'queued'}
        </div>
      </div>
      <div style={{fontSize: 27, fontWeight: 800, marginTop: 17}}>{name}</div>
      <div style={{fontSize: 16, color: colors.muted, marginTop: 8}}>{desc}</div>
      <div
        style={{
          height: 6,
          borderRadius: 99,
          marginTop: 18,
          background: 'rgba(255,255,255,0.1)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.max(active, done) * 100}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );
};

const EvidenceScene = () => {
  const frame = useCurrentFrame();
  const exit = exitFade(frame, scenes.evidence - 28, scenes.evidence);

  const citations = [
    {
      title: '财报与业务线',
      source: '10-K / Earnings Call',
      body: '数据中心业务、AI 加速计算、客户需求持续扩张。',
      color: colors.jade,
    },
    {
      title: '市场趋势',
      source: '行业新闻 / 供应链',
      body: '云厂商资本开支、AI 基础设施建设形成需求牵引。',
      color: colors.cyan,
    },
    {
      title: '风险提示',
      source: '监管披露 / Export Controls',
      body: '出口管制、供应约束、客户集中度可能影响增长节奏。',
      color: colors.coral,
    },
  ];

  return (
    <AbsoluteFill style={{...exit}}>
      <div style={{position: 'absolute', left: 112, top: 150, right: 112}}>
        <div style={entrance(frame, 4)}>
          <Kicker color={colors.jade}>答案必须可追溯</Kicker>
        </div>
        <h2
          style={{
            ...entrance(frame, 18, 28),
            margin: '28px 0 0',
            fontSize: 64,
            lineHeight: 1.12,
            fontWeight: 820,
          }}
        >
          每个结论，都能回到原始证据
        </h2>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 112,
          top: 330,
          width: 810,
          height: 540,
          ...panelStyle,
          borderRadius: 16,
          padding: 34,
          opacity: clamp(frame, [44, 66]),
        }}
      >
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <div style={{fontSize: 19, color: colors.muted}}>FinSagent Synthesis</div>
          <div
            style={{
              color: colors.jade,
              fontSize: 16,
              border: `1px solid ${colors.jade}55`,
              borderRadius: 8,
              padding: '8px 12px',
              background: 'rgba(53,214,162,0.12)',
            }}
          >
            grounded answer
          </div>
        </div>
        <div style={{marginTop: 32, display: 'grid', gap: 22}}>
          {[
            ['增长驱动', 'AI 数据中心需求、加速计算平台与生态锁定共同推动收入增长。'],
            ['关键变量', '云厂商资本开支、供给能力、产品迭代节奏决定增长斜率。'],
            ['主要风险', '出口管制、供应链约束、竞争加剧与客户集中度需要持续跟踪。'],
          ].map(([head, body], index) => (
            <div
              key={head}
              style={{
                opacity: clamp(frame, [70 + index * 28, 88 + index * 28]),
                display: 'grid',
                gridTemplateColumns: '150px 1fr',
                gap: 22,
                paddingBottom: 20,
                borderBottom:
                  index < 2 ? `1px solid rgba(255,255,255,0.11)` : 'none',
              }}
            >
              <div style={{fontSize: 23, fontWeight: 820, color: colors.jade}}>{head}</div>
              <div style={{fontSize: 25, lineHeight: 1.38, color: colors.text}}>{body}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{position: 'absolute', right: 112, top: 305, width: 760}}>
        {citations.map((citation, index) => (
          <EvidenceCard
            key={citation.title}
            frame={frame}
            index={index}
            {...citation}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
};

const EvidenceCard = ({
  frame,
  index,
  title,
  source,
  body,
  color,
}: {
  frame: number;
  index: number;
  title: string;
  source: string;
  body: string;
  color: string;
}) => {
  const delay = 64 + index * 34;
  const progress = spring({
    frame: frame - delay,
    fps: 24,
    config: {damping: 20, stiffness: 100},
  });

  return (
    <div
      style={{
        ...panelStyle,
        height: 142,
        marginBottom: 26,
        borderRadius: 13,
        padding: 24,
        display: 'grid',
        gridTemplateColumns: '110px 1fr',
        gap: 24,
        border: `1px solid ${color}50`,
        opacity: clamp(frame, [delay, delay + 16]),
        transform: `translateX(${(1 - progress) * 70}px)`,
      }}
    >
      <div
        style={{
          background: `${color}18`,
          border: `1px solid ${color}4f`,
          borderRadius: 10,
          display: 'grid',
          placeItems: 'center',
          color,
          fontWeight: 850,
          fontSize: 22,
        }}
      >
        [{index + 1}]
      </div>
      <div>
        <div style={{display: 'flex', justifyContent: 'space-between'}}>
          <div style={{fontSize: 24, fontWeight: 820}}>{title}</div>
          <div style={{fontSize: 15, color}}>{source}</div>
        </div>
        <div style={{fontSize: 19, color: colors.muted, lineHeight: 1.38, marginTop: 12}}>
          {body}
        </div>
      </div>
    </div>
  );
};

const PreviewScene = () => {
  const frame = useCurrentFrame();
  const exit = exitFade(frame, scenes.preview - 26, scenes.preview);
  const draftProgress = clamp(frame, [44, 104]);
  const fullProgress = clamp(frame, [98, 196]);

  return (
    <AbsoluteFill style={{...exit}}>
      <div style={{position: 'absolute', left: 112, top: 148, width: 750}}>
        <div style={entrance(frame, 4)}>
          <Kicker color={colors.amber}>更快进入判断</Kicker>
        </div>
        <h2
          style={{
            ...entrance(frame, 16, 30),
            margin: '28px 0 0',
            fontSize: 64,
            lineHeight: 1.12,
            fontWeight: 820,
          }}
        >
          先看到方向，
          <br />
          再等待完整研究结论
        </h2>
        <p
          style={{
            ...entrance(frame, 42, 24),
            marginTop: 28,
            fontSize: 28,
            lineHeight: 1.42,
            color: colors.muted,
          }}
        >
          Preview 模式让客户快速获得初稿，同时后台多专家继续检索、分析、汇总。
        </p>
      </div>

      <div
        style={{
          position: 'absolute',
          right: 112,
          top: 166,
          width: 820,
          height: 676,
          ...panelStyle,
          borderRadius: 16,
          padding: 30,
          opacity: clamp(frame, [30, 52]),
        }}
      >
        <TimelineStep
          frame={frame}
          delay={44}
          label="Phase 1"
          title="快速初稿"
          body="General agent 先生成方向性回答，让客户马上进入讨论。"
          progress={draftProgress}
          color={colors.violet}
        />
        <TimelineStep
          frame={frame}
          delay={96}
          label="Phase 2"
          title="多专家深度研究"
          body="Market / Company / Quant / Legal Risk 并行处理证据。"
          progress={fullProgress}
          color={colors.cyan}
        />
        <div
          style={{
            opacity: clamp(frame, [178, 208]),
            marginTop: 30,
            padding: 24,
            borderRadius: 12,
            background: 'rgba(53,214,162,0.12)',
            border: `1px solid ${colors.jade}55`,
          }}
        >
          <div style={{fontSize: 22, color: colors.jade, fontWeight: 820}}>
            最终汇总
          </div>
          <div style={{fontSize: 24, lineHeight: 1.36, marginTop: 10}}>
            结构化结论 + 引用证据 + 风险提示，一次交付给客户。
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const TimelineStep = ({
  frame,
  delay,
  label,
  title,
  body,
  progress,
  color,
}: {
  frame: number;
  delay: number;
  label: string;
  title: string;
  body: string;
  progress: number;
  color: string;
}) => (
  <div
    style={{
      opacity: clamp(frame, [delay, delay + 18]),
      display: 'grid',
      gridTemplateColumns: '96px 1fr',
      gap: 24,
      marginTop: delay === 44 ? 4 : 34,
    }}
  >
    <div
      style={{
        width: 76,
        height: 76,
        borderRadius: 18,
        display: 'grid',
        placeItems: 'center',
        background: `${color}1c`,
        border: `1px solid ${color}66`,
        color,
        fontSize: 18,
        fontWeight: 850,
      }}
    >
      {label.replace('Phase ', 'P')}
    </div>
    <div>
      <div style={{display: 'flex', justifyContent: 'space-between'}}>
        <div>
          <div style={{color, fontSize: 16, fontWeight: 820}}>{label}</div>
          <div style={{fontSize: 30, fontWeight: 830, marginTop: 6}}>{title}</div>
        </div>
        <div style={{fontSize: 42, fontWeight: 850, color}}>
          {Math.round(progress * 100)}%
        </div>
      </div>
      <div style={{fontSize: 21, color: colors.muted, lineHeight: 1.38, marginTop: 10}}>
        {body}
      </div>
      <div
        style={{
          height: 10,
          borderRadius: 99,
          marginTop: 18,
          background: 'rgba(255,255,255,0.1)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: '100%',
            background: color,
          }}
        />
      </div>
    </div>
  </div>
);

const ValueScene = () => {
  const frame = useCurrentFrame();
  const introFrame = frame + 16;
  const values = [
    {label: '研究更快', body: '从资料检索到初步判断，减少重复手工整理。', color: colors.jade},
    {label: '结论更稳', body: '多专家视角交叉检查，覆盖市场、公司、量化与风险。', color: colors.cyan},
    {label: '证据更清楚', body: '答案关联来源片段，支持客户复核与审计。', color: colors.amber},
  ];

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(135deg, rgba(53,214,162,0.18), transparent 38%), linear-gradient(315deg, rgba(241,183,92,0.16), transparent 42%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 136,
          top: 170,
          width: 840,
        }}
      >
        <div style={entrance(introFrame, 0)}>
          <Kicker color={colors.jade}>客户价值</Kicker>
        </div>
        <h2
          style={{
            ...entrance(introFrame, 4, 34),
            margin: '34px 0 0',
            fontSize: 76,
            lineHeight: 1.08,
            fontWeight: 840,
          }}
        >
          让金融研究从信息检索，
          <br />
          升级为可复核的智能分析
        </h2>
        <div
          style={{
            ...entrance(introFrame, 54, 24),
            marginTop: 42,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
          }}
        >
          <LogoMark />
          <div>
            <div style={{fontSize: 36, fontWeight: 840}}>FinSagent</div>
            <div style={{fontSize: 19, color: colors.muted, marginTop: 6}}>
              专为复杂金融问题打造的 Agentic RAG 系统
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          right: 136,
          top: 232,
          width: 650,
          display: 'grid',
          gap: 24,
        }}
      >
        {values.map((value, index) => (
          <div
            key={value.label}
            style={{
              ...panelStyle,
              ...entrance(introFrame, 24 + index * 22, 36),
              borderRadius: 14,
              padding: 28,
              border: `1px solid ${value.color}55`,
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 12,
                  background: value.color,
                  color: colors.ink,
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: 920,
                  fontSize: 24,
                }}
              >
                {index + 1}
              </div>
              <div style={{fontSize: 31, fontWeight: 830}}>{value.label}</div>
            </div>
            <div style={{fontSize: 22, lineHeight: 1.38, color: colors.muted, marginTop: 17}}>
              {value.body}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          left: 136,
          right: 136,
          bottom: 116,
          height: 86,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: `1px solid ${colors.border}`,
          opacity: clamp(frame, [146, 176]),
          color: colors.muted,
          fontSize: 21,
        }}
      >
        <span>多专家编排</span>
        <span>私有语料检索</span>
        <span>证据可追溯</span>
        <span>企业级金融场景</span>
      </div>
    </AbsoluteFill>
  );
};
