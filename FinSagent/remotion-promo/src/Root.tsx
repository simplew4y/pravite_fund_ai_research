import {Composition} from 'remotion';
import {
  PrivateFundResearchDemo,
  privateFundResearchDemoFrames,
} from './PrivateFundResearchDemo';
import {PromoVideo} from './PromoVideo';

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="FinSagentPromo"
        component={PromoVideo}
        durationInFrames={1536}
        fps={24}
        width={1920}
        height={1080}
      />
      <Composition
        id="PrivateFundResearchDemo"
        component={PrivateFundResearchDemo}
        durationInFrames={privateFundResearchDemoFrames}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
